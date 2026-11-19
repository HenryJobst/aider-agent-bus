/**
 * Fake AiderDesk host for tests that need the real extension code: tools,
 * commands, events, UI data and panel actions.
 *
 * The extension is instantiated for real; only `ProjectContext`, `TaskContext`
 * and the CLI are substituted.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProfile, ExtensionContext, TaskContext } from '@aiderdesk/extensions';

import AgentBusExtension from '../index.js';

export interface LogEntry {
  level: string;
  message: string;
}

export interface TestHost {
  ext: AgentBusExtension;
  context: ExtensionContext;
  projectDir: string;
  tasks: Map<string, TaskContext>;
  prompts: Array<{ id: string; profileId?: string; prompt: string }>;
  interrupts: string[];
  logs: LogEntry[];
  uiReloads: number;
  setCurrentTask: (task: TaskContext | null) => void;
  createTask: (id: string, name: string) => TaskContext;
  busCalls: () => string[];
}

function fakeBus(projectDir: string, inboxMissing: boolean, delayMs: number): string {
  const path = join(projectDir, 'fake-bus.cjs');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'bus-calls.log'), args.join(' ') + '\\n');
const reply = () => {
  if (args.includes('inbox-status')) {
    if (${inboxMissing}) {
      process.stderr.write("agent 'x' is not registered");
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ unread: 0, claimed: 0, delivered: 0 }));
  } else if (args.includes('log')) {
    process.stdout.write('message from fake bus');
  } else if (args.includes('inject')) {
    process.stdout.write('injected');
  } else {
    process.stdout.write('ok');
  }
};
if (${delayMs} > 0) {
  setTimeout(reply, ${delayMs});
} else {
  reply();
}
`,
    'utf-8',
  );
  chmodSync(path, 0o755);
  return path;
}

export interface HostOptions {
  config?: Record<string, unknown>;
  /** Simulate a bus where nobody ever registered (`inbox-status` fails). */
  inboxMissing?: boolean;
  /** Make the fake CLI slow, to exercise overlapping polls. */
  delayMs?: number;
}

export function makeHost(options: HostOptions = {}): TestHost {
  const projectDir = mkdtempSync(join(tmpdir(), 'agent-bus-host-'));
  mkdirSync(join(projectDir, '.aider-desk'), { recursive: true });
  writeFileSync(
    join(projectDir, '.aider-desk', 'agent-bus.json'),
    JSON.stringify({
      team: 'test-team',
      agentBus: {
        project: 'test-project',
        binary: fakeBus(projectDir, options.inboxMissing ?? false, options.delayMs ?? 0),
        nodeBinary: process.execPath,
      },
      isolation: { mode: 'shared' },
      profiles: { provider: 'test', model: 'test-model' },
      ...options.config,
    }),
    'utf-8',
  );

  const tasks = new Map<string, TaskContext>();
  const prompts: TestHost['prompts'] = [];
  const interrupts: string[] = [];
  const logs: LogEntry[] = [];
  let uiReloads = 0;

  const createTask = (id: string, name: string): TaskContext => {
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

    const task = {
      data,
      runPrompt: async (prompt: string) => {
        prompts.push({ id, prompt });
      },
      runPromptInAgent: async (profile: AgentProfile, _mode: string, prompt: string | null) => {
        prompts.push({ id, profileId: profile.id, prompt: prompt ?? '' });
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
      addLogMessage: (level: string, message?: string) => {
        logs.push({ level, message: message ?? '' });
      },
    } as unknown as TaskContext;

    tasks.set(id, task);
    return task;
  };

  const projectContext = {
    baseDir: projectDir,
    createTask: async (params: { name?: string }) => {
      const id = `task-${tasks.size + 1}`;
      return createTask(id, params.name ?? id).data;
    },
    getTask: (id: string) => tasks.get(id) ?? null,
    getTasks: async () => [...tasks.values()].map((task) => task.data),
  };

  let currentTask: TaskContext | null = null;
  const context = {
    getProjectDir: () => projectDir,
    getProjectContext: () => projectContext,
    getTaskContext: () => currentTask,
    log: (message: string, level = 'log') => {
      logs.push({ level, message });
    },
    getMcpServers: async () => ({ 'agent-bus': { command: 'agent-bus-mcp', scope: 'task' } }),
    triggerUIDataRefresh: () => undefined,
    triggerUIComponentsReload: () => {
      uiReloads += 1;
    },
    addDisposable: () => undefined,
  } as unknown as ExtensionContext;

  const busCalls = (): string[] => {
    try {
      return readFileSync(join(projectDir, 'bus-calls.log'), 'utf-8').trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };

  return {
    ext: new AgentBusExtension(),
    context,
    projectDir,
    tasks,
    prompts,
    interrupts,
    logs,
    get uiReloads() {
      return uiReloads;
    },
    setCurrentTask: (task) => {
      currentTask = task;
    },
    createTask,
    busCalls,
  };
}

export async function spawnBackend(host: TestHost): Promise<void> {
  const tool = host.ext
    .getTools(host.context, 'agent', { id: 'agent-bus-master' } as AgentProfile)
    .find((candidate) => candidate.name === 'agent_bus_spawn_worker');
  if (!tool) {
    throw new Error('spawn tool missing');
  }
  await tool.execute({ name: 'backend', role: 'developer', task: 'do the work' }, undefined, host.context, {});
}

/** Marks a task as running, the way AiderDesk reports it through `onAgentStarted`. */
export async function startAgent(host: TestHost, taskId: string): Promise<void> {
  const task = host.tasks.get(taskId);
  if (!task) {
    throw new Error(`task ${taskId} missing`);
  }
  host.setCurrentTask(task);
  await host.ext.onAgentStarted({ agentProfile: { provider: 'test', model: 'test-model' } } as never, host.context);
}
