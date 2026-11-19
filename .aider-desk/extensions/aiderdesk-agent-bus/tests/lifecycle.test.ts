/**
 * Tests the event handlers and the UI registration: the parts AiderDesk calls
 * on its own, without a user command in between.
 */

import assert from 'node:assert/strict';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { AgentProfile } from '@aiderdesk/extensions';

import AgentBusExtension from '../index.js';
import type { TestHost } from './host.js';
import { makeHost, spawnBackend, startAgent } from './host.js';

const timerHost = globalThis as typeof globalThis & { __agentBusPollTimer?: NodeJS.Timeout };

async function workerView(h: TestHost): Promise<{
  status: string;
  worktree: string | null;
}> {
  const view = (await h.ext.getUIExtensionData('agent-bus-dashboard', h.context)) as {
    workers: Array<{ status: string; worktree: string | null }>;
  };
  return view.workers[0];
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('condition was not met in time');
}

test('the panel is hidden without a team and registered once one exists', async () => {
  const h = makeHost();
  assert.deepEqual(h.ext.getUIComponents(h.context), []);

  await spawnBackend(h);
  const components = h.ext.getUIComponents(h.context);

  assert.equal(components.length, 1);
  assert.equal(components[0].id, 'agent-bus-dashboard');
  assert.equal(components[0].placement, 'tasks-sidebar-bottom');
  assert.equal(components[0].name, 'Agent Bus');
  assert.ok(components[0].jsx.length > 500, 'the dashboard source is loaded from disk');
});

test('the extension only hands the control plane to the master profile', () => {
  const h = makeHost();
  const masterTools = h.ext.getTools(h.context, 'agent', { id: 'agent-bus-master' } as AgentProfile);
  const developerTools = h.ext.getTools(h.context, 'agent', { id: 'agent-bus-developer' } as AgentProfile);

  assert.equal(masterTools.length, 6);
  assert.deepEqual(
    developerTools.map((tool) => tool.name),
    ['agent_bus_get_team'],
  );
});

test('closing a worker task marks it closed', async () => {
  const h = makeHost();
  await spawnBackend(h);

  await h.ext.onTaskClosed({ task: { id: 'task-1' } } as never, h.context);

  assert.equal((await workerView(h)).status, 'closed');
});

test('a created worktree is recorded on the worker', async () => {
  const h = makeHost();
  await spawnBackend(h);

  await h.ext.onWorktreeCreated(
    { task: { id: 'task-1' }, worktree: { path: '/tmp/test-project-wt-backend' } } as never,
    h.context,
  );

  assert.equal((await workerView(h)).worktree, '/tmp/test-project-wt-backend');
});

test('a merge notifies the master without blocking the event', async () => {
  const h = makeHost();
  const master = h.createTask('master-task', 'pm');
  h.setCurrentTask(master);
  await h.ext
    .getCommands(h.context)
    .find((c) => c.name === 'agent-bus-init')!
    .execute([], h.context);
  await spawnBackend(h);

  const view = (await h.ext.getUIExtensionData('agent-bus-dashboard', h.context)) as {
    workers: Array<{ taskId: string }>;
  };
  const workerTaskId = view.workers[0].taskId;

  await h.ext.onWorktreeMerged({ task: { id: workerTaskId }, targetBranch: 'main' } as never, h.context);

  assert.ok(h.logs.some((entry) => entry.message.includes('test-project-backend merged into main')));
  await waitFor(() =>
    h
      .busCalls()
      .some(
        (call) =>
          call.startsWith('send --from test-project-master --to test-project-backend') &&
          call.includes('merged into main'),
      ),
  );
});

test('profile edits are kept and teach the extension the provider defaults', async () => {
  const h = makeHost();
  const edited = {
    id: 'agent-bus-developer',
    provider: 'anthropic',
    model: 'claude-sonnet',
    maxIterations: 42,
  } as AgentProfile;

  const returned = await h.ext.onAgentProfileUpdated(h.context, 'agent-bus-developer', edited);
  assert.equal(returned, edited);

  const profiles = h.ext.getAgents(h.context);
  const developer = profiles.find((profile) => profile.id === 'agent-bus-developer');
  assert.equal(developer?.model, 'claude-sonnet');
  assert.equal(developer?.maxIterations, 42);

  const master = profiles.find((profile) => profile.id === 'agent-bus-master');
  assert.equal(master?.provider, 'anthropic', 'new profiles use the learned provider');
  assert.equal(master?.model, 'claude-sonnet');
});

test('profiles for other extensions are not taken over', async () => {
  const h = makeHost();
  const foreign = { id: 'other-profile', provider: 'x', model: 'y' } as AgentProfile;

  await h.ext.onAgentProfileUpdated(h.context, 'other-profile', foreign);

  assert.equal(
    h.ext.getAgents(h.context).some((profile) => profile.id === 'other-profile'),
    false,
  );
});

test('a started agent switches its worker to working, a finished one to idle', async () => {
  const h = makeHost();
  await spawnBackend(h);
  await startAgent(h, 'task-1');

  assert.equal((await workerView(h)).status, 'working');

  await h.ext.onAgentFinished({ aborted: false } as never, h.context);
  assert.equal((await workerView(h)).status, 'idle');
});

test('a run that ends unregistered marks the worker blocked instead of leaving it starting', async () => {
  const h = makeHost({ inboxMissing: true });
  await spawnBackend(h);
  await startAgent(h, 'task-1');

  await h.ext.onAgentFinished({ aborted: false } as never, h.context);

  assert.equal((await workerView(h)).status, 'blocked');
  assert.ok(
    h.logs.some((entry) => entry.message.includes('finished without registering on the bus')),
    'the reason is logged',
  );
});

test('events without a worker record are ignored', async () => {
  const h = makeHost();

  await h.ext.onTaskClosed({ task: { id: 'unknown' } } as never, h.context);
  await h.ext.onWorktreeCreated({ task: { id: 'unknown' }, worktree: { path: '/tmp/x' } } as never, h.context);
  await h.ext.onWorktreeMerged({ task: { id: 'unknown' } } as never, h.context);
  await h.ext.onAgentFinished({ aborted: false } as never, h.context);

  assert.equal(h.busCalls().length, 0);
});

test('a reloaded extension replaces the poll timer instead of adding a second one', async () => {
  const h = makeHost();
  const first = new AgentBusExtension();
  const second = new AgentBusExtension();

  try {
    await first.onLoad(h.context);
    const firstTimer = timerHost.__agentBusPollTimer;
    assert.ok(firstTimer);

    await second.onLoad(h.context);
    const secondTimer = timerHost.__agentBusPollTimer;
    assert.ok(secondTimer);
    assert.notEqual(secondTimer, firstTimer);

    first.onUnload();
    assert.equal(timerHost.__agentBusPollTimer, secondTimer, 'the old instance must not clear the new timer');

    second.onUnload();
    assert.equal(timerHost.__agentBusPollTimer, undefined);
  } finally {
    first.onUnload();
    second.onUnload();
  }
});

test('a master run is tracked in the join table and returns to idle', async () => {
  const h = makeHost();
  h.setCurrentTask(h.createTask('master-task', 'pm'));
  await h.ext
    .getCommands(h.context)
    .find((c) => c.name === 'agent-bus-init')!
    .execute([], h.context);

  await startAgent(h, 'master-task');
  let view = (await h.ext.getUIExtensionData('agent-bus-dashboard', h.context)) as {
    master: { status?: string } | null;
  };
  assert.equal(view.master?.status, 'working');

  await h.ext.onAgentFinished({ aborted: false } as never, h.context);
  view = (await h.ext.getUIExtensionData('agent-bus-dashboard', h.context)) as {
    master: { status?: string } | null;
  };
  assert.equal(view.master?.status, 'idle');
});

test('deleting a worker task removes its identity from the join table', async () => {
  const h = makeHost();
  await spawnBackend(h);

  await h.ext.onTaskDeleted({ task: { id: 'task-1' } } as never, h.context);

  const view = (await h.ext.getUIExtensionData('agent-bus-dashboard', h.context)) as {
    workers: unknown[];
  };
  assert.equal(view.workers.length, 0);
  assert.ok(
    h.busCalls().some((call) => call.startsWith('remove-member test-project-backend')),
    'the bus registration is removed too',
  );
});

test('deleting the master task clears the master', async () => {
  const h = makeHost();
  h.setCurrentTask(h.createTask('master-task', 'pm'));
  await h.ext
    .getCommands(h.context)
    .find((c) => c.name === 'agent-bus-init')!
    .execute([], h.context);

  await h.ext.onTaskDeleted({ task: { id: 'master-task' } } as never, h.context);

  const view = (await h.ext.getUIExtensionData('agent-bus-dashboard', h.context)) as {
    master: unknown;
  };
  assert.equal(view.master, null);
});

test('a blocked deletion leaves the worker alone', async () => {
  const h = makeHost();
  await spawnBackend(h);

  await h.ext.onTaskDeleted({ task: { id: 'task-1' }, blocked: true } as never, h.context);

  const view = (await h.ext.getUIExtensionData('agent-bus-dashboard', h.context)) as {
    workers: unknown[];
  };
  assert.equal(view.workers.length, 1);
});

test('a project start closes workers whose task no longer exists', async () => {
  const h = makeHost();
  await spawnBackend(h);
  h.createTask('keep', 'keep');
  h.tasks.delete('task-1');

  await h.ext.onProjectStarted({ baseDir: h.projectDir } as never, h.context);

  assert.equal((await workerView(h)).status, 'closed');
});

test('a project start with no loaded tasks leaves the workers alone', async () => {
  const h = makeHost();
  await spawnBackend(h);
  h.tasks.clear();

  await h.ext.onProjectStarted({ baseDir: h.projectDir } as never, h.context);

  assert.equal(
    (await workerView(h)).status,
    'starting',
    'an empty task list means the project is still loading, not that every task is gone',
  );
});

test('a config edit applies on the next UI call without an extension reload', async () => {
  const h = makeHost();
  const before = (await h.ext.getUIExtensionData('agent-bus-dashboard', h.context)) as {
    settings: { trackTasks: boolean };
  };
  assert.equal(before.settings.trackTasks, true);

  const path = join(h.projectDir, '.aider-desk', 'agent-bus.json');
  const config = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  config.orchestration = { ...(config.orchestration as Record<string, unknown>), trackTasks: false };
  writeFileSync(path, JSON.stringify(config), 'utf-8');
  const future = new Date(Date.now() + 5_000);
  utimesSync(path, future, future);

  const after = (await h.ext.getUIExtensionData('agent-bus-dashboard', h.context)) as {
    settings: { trackTasks: boolean };
  };
  assert.equal(after.settings.trackTasks, false);
});
