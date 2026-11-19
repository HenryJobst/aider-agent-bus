/**
 * Tests the extension's host-facing surface: tools, UI data and every panel
 * action. These are the paths a user actually clicks, and they were previously
 * only verified by hand.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { AgentProfile, ExtensionContext, TaskContext } from '@aiderdesk/extensions';

import AgentBusExtension from '../index.js';
import { DASHBOARD_ID } from '../src/constants.js';

interface Harness {
  ext: AgentBusExtension;
  context: ExtensionContext;
  tasks: Map<string, TaskContext>;
  prompts: Array<{ id: string; profileId?: string }>;
  interrupts: string[];
  setCurrentTask: (task: TaskContext | null) => void;
}

function fakeBus(projectDir: string): string {
  const path = join(projectDir, 'fake-bus.cjs');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('inbox-status')) {
  process.stdout.write(JSON.stringify({ unread: 0, claimed: 0, delivered: 0 }));
} else {
  process.stdout.write('ok');
}
`,
    'utf-8',
  );
  chmodSync(path, 0o755);
  return path;
}

function harness(): Harness {
  const projectDir = mkdtempSync(join(tmpdir(), 'agent-bus-actions-'));
  mkdirSync(join(projectDir, '.aider-desk'), { recursive: true });
  writeFileSync(
    join(projectDir, '.aider-desk', 'agent-bus.json'),
    JSON.stringify({
      team: 'test-team',
      agentBus: { project: 'test-project', binary: fakeBus(projectDir), nodeBinary: process.execPath },
      isolation: { mode: 'shared' },
      profiles: { provider: 'test', model: 'test-model' },
    }),
    'utf-8',
  );

  const tasks = new Map<string, TaskContext>();
  const prompts: Array<{ id: string; profileId?: string }> = [];
  const interrupts: string[] = [];

  const makeTask = (id: string, name: string): TaskContext => {
    const data = {
      id,
      baseDir: projectDir,
      name,
      mainModel: 'm',
      aiderTotalCost: 0,
      agentTotalCost: 0,
      workingMode: 'local',
      currentMode: 'agent',
      provider: 'test',
      model: 'test-model',
    } as unknown as TaskContext['data'];

    return {
      data,
      runPrompt: async () => {
        prompts.push({ id });
      },
      runPromptInAgent: async (profile: AgentProfile) => {
        prompts.push({ id, profileId: profile.id });
        return [];
      },
      updateTask: async (updates: Record<string, unknown>) => {
        Object.assign(data, updates);
        return data;
      },
      switchToWorktreeWorkingMode: async () => undefined,
      interruptResponse: async () => {
        interrupts.push(id);
      },
    } as unknown as TaskContext;
  };

  const projectContext = {
    baseDir: projectDir,
    createTask: async (params: { name?: string }) => {
      const id = `task-${tasks.size + 1}`;
      const task = makeTask(id, params.name ?? id);
      tasks.set(id, task);
      return task.data;
    },
    getTask: (id: string) => tasks.get(id) ?? null,
    getTasks: async () => [...tasks.values()].map((task) => task.data),
  };

  let currentTask: TaskContext | null = null;
  const context = {
    getProjectDir: () => projectDir,
    getProjectContext: () => projectContext,
    getTaskContext: () => currentTask,
    log: () => undefined,
    getMcpServers: async () => ({ 'agent-bus': { command: 'agent-bus-mcp', scope: 'task' } }),
    triggerUIDataRefresh: () => undefined,
    triggerUIComponentsReload: () => undefined,
    addDisposable: () => undefined,
  } as unknown as ExtensionContext;

  return {
    ext: new AgentBusExtension(),
    context,
    tasks,
    prompts,
    interrupts,
    setCurrentTask: (task) => {
      currentTask = task;
    },
  };
}

const MASTER: AgentProfile = { id: 'agent-bus-master' } as AgentProfile;

async function spawnWorker(h: Harness): Promise<void> {
  const tool = h.ext
    .getTools(h.context, 'agent', MASTER)
    .find((candidate) => candidate.name === 'agent_bus_spawn_worker');
  assert.ok(tool, 'spawn tool must be registered for the master');

  const result = (await tool.execute(
    { name: 'backend', role: 'developer', task: 'do the work' },
    undefined,
    h.context,
    {},
  )) as { ok: boolean };
  assert.equal(result.ok, true);
}

async function data(h: Harness): Promise<Record<string, unknown>> {
  return (await h.ext.getUIExtensionData(DASHBOARD_ID, h.context)) as Record<string, unknown>;
}

test('spawn through the tool shows up in the panel data', async () => {
  const h = harness();
  await spawnWorker(h);

  const view = (await data(h)) as {
    workers: Array<{ agentName: string; muted: boolean; status: string }>;
    settings: { trackTasks: boolean; isolation: string };
  };

  assert.equal(view.workers.length, 1);
  assert.equal(view.workers[0].agentName, 'test-project-backend');
  assert.equal(view.workers[0].muted, false);
  assert.equal(view.settings.trackTasks, true);
  assert.equal(view.settings.isolation, 'shared');
  assert.equal(h.prompts.at(-1)?.profileId, 'agent-bus-developer');
});

test('the mute toggle flips wake-ups and is visible in the panel', async () => {
  const h = harness();
  await spawnWorker(h);

  const muted = (await h.ext.executeUIExtensionAction(
    DASHBOARD_ID,
    'toggle-mute',
    ['test-project-backend'],
    h.context,
  )) as {
    ok: boolean;
    muted: boolean;
  };
  assert.equal(muted.ok, true);
  assert.equal(muted.muted, true);

  const view = (await data(h)) as { workers: Array<{ muted: boolean }> };
  assert.equal(view.workers[0].muted, true);
});

test('remove drops the participant from the panel', async () => {
  const h = harness();
  await spawnWorker(h);

  const result = (await h.ext.executeUIExtensionAction(
    DASHBOARD_ID,
    'remove-worker',
    ['test-project-backend'],
    h.context,
  )) as { ok: boolean };

  assert.equal(result.ok, true);
  const view = (await data(h)) as { workers: unknown[] };
  assert.equal(view.workers.length, 0);
});

test('set-config writes the project file and is reflected immediately', async () => {
  const h = harness();
  await spawnWorker(h);

  const result = (await h.ext.executeUIExtensionAction(
    DASHBOARD_ID,
    'set-config',
    ['orchestration.trackTasks', 'false'],
    h.context,
  )) as { ok: boolean; value: unknown };

  assert.equal(result.ok, true);
  assert.equal(result.value, false);
  const view = (await data(h)) as { settings: { trackTasks: boolean } };
  assert.equal(view.settings.trackTasks, false);
});

test('isolation is refused while a worker is running', async () => {
  const h = harness();
  await spawnWorker(h);
  const workerTask = h.tasks.get('task-1');
  assert.ok(workerTask);
  h.setCurrentTask(workerTask);
  await h.ext.onAgentStarted({ agentProfile: { provider: 'test', model: 'test-model' } } as never, h.context);

  const result = (await h.ext.executeUIExtensionAction(
    DASHBOARD_ID,
    'set-config',
    ['isolation.mode', 'worktree'],
    h.context,
  )) as { ok: boolean; error?: string };

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /stop the running workers/);
});

test('stop-all interrupts running agents and reports the count', async () => {
  const h = harness();
  await spawnWorker(h);
  const workerTask = h.tasks.get('task-1');
  assert.ok(workerTask);
  h.setCurrentTask(workerTask);
  await h.ext.onAgentStarted({ agentProfile: { provider: 'test', model: 'test-model' } } as never, h.context);

  const first = (await h.ext.executeUIExtensionAction(DASHBOARD_ID, 'stop-all', [], h.context)) as {
    ok: boolean;
    stopped: string[];
  };
  assert.equal(first.ok, true);
  assert.deepEqual(first.stopped, ['test-project-backend']);
  assert.deepEqual(h.interrupts, ['task-1']);

  await h.ext.onAgentFinished({ aborted: true } as never, h.context);
  const second = (await h.ext.executeUIExtensionAction(DASHBOARD_ID, 'stop-all', [], h.context)) as {
    stopped: string[];
  };
  assert.deepEqual(second.stopped, []);
});

test('refresh reports registration truth instead of raw CLI errors', async () => {
  const h = harness();
  await spawnWorker(h);

  const result = (await h.ext.executeUIExtensionAction(DASHBOARD_ID, 'refresh', [], h.context)) as {
    ok: boolean;
    registered: number;
    total: number;
  };

  assert.equal(result.ok, true);
  assert.equal(result.total, 1);
  assert.equal(result.registered, 1);
});

test('unknown actions and components are rejected', async () => {
  const h = harness();

  assert.equal(await h.ext.executeUIExtensionAction('other-component', 'refresh', [], h.context), undefined);

  const unknown = (await h.ext.executeUIExtensionAction(DASHBOARD_ID, 'nope', [], h.context)) as {
    ok: boolean;
    error: string;
  };
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown action/);
});
