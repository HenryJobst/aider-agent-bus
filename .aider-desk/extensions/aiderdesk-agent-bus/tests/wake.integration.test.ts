/**
 * Wake-up decisions against the real CLI and a real bus database.
 *
 * The unit tests use a stubbed bus; this one proves that the shape of
 * `inbox-status --json` is understood and that a delivered message really leads
 * to exactly one wake.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import type { ExtensionContext, TaskContext } from '@aiderdesk/extensions';

import { ProjectRuntime } from '../src/core/runtime.js';
import { InboxWatcher } from '../src/orchestration/wakeup.js';
import { findAgentBus } from './cli.js';

const cli = findAgentBus();

test('a real message wakes once, and not again without progress', { skip: !cli }, async () => {
  if (!cli) {
    return;
  }
  const projectDir = mkdtempSync(join(tmpdir(), 'wake-it-'));
  const busDir = mkdtempSync(join(tmpdir(), 'wake-bus-'));
  mkdirSync(join(projectDir, '.aider-desk'), { recursive: true });

  const project = `wake-${Date.now().toString(36)}`;
  const team = `${project}-team`;
  writeFileSync(
    join(projectDir, '.aider-desk', 'agent-bus.json'),
    JSON.stringify({
      team,
      agentBus: { project, binary: cli.cli, nodeBinary: cli.node, dataDir: busDir },
      isolation: { mode: 'shared' },
      profiles: { provider: 'test', model: 'test-model' },
    }),
    'utf-8',
  );

  const prompts: string[] = [];
  const task = {
    data: {
      id: 't1',
      name: 'Worker',
      baseDir: projectDir,
      mainModel: 'm',
      aiderTotalCost: 0,
      agentTotalCost: 0,
      workingMode: 'local',
      currentMode: 'agent',
    },
    runPrompt: async (prompt: string) => {
      prompts.push(prompt);
    },
    runPromptInAgent: async (_profile: unknown, _mode: string, prompt: string | null) => {
      prompts.push(prompt ?? '');
      return [];
    },
    updateTask: async (updates: Record<string, unknown>) => updates,
    switchToWorktreeWorkingMode: async () => undefined,
    interruptResponse: async () => undefined,
  } as unknown as TaskContext;

  const projectContext = {
    baseDir: projectDir,
    createTask: async () => task.data,
    getTask: (id: string) => (id === 't1' ? task : null),
    getTasks: async () => [task.data],
  };

  const context = {
    getProjectDir: () => projectDir,
    getProjectContext: () => projectContext,
    getTaskContext: () => null,
    log: () => undefined,
  } as unknown as ExtensionContext;

  const runtime = new ProjectRuntime(context);
  runtime.state.upsertWorker({
    agentName: `${project}-worker`,
    taskId: 't1',
    role: 'developer',
    name: 'worker',
    capabilities: [],
    worktree: null,
    status: 'idle',
  });

  await runtime.bus.register({ name: `${project}-sender`, role: 'developer', capabilities: [] });
  await runtime.bus.register({ name: `${project}-worker`, role: 'developer', capabilities: [] });
  await runtime.bus.send(`${project}-sender`, `${project}-worker`, 'please pick this up');

  const watcher = new InboxWatcher(runtime);

  const unread = await watcher.checkWorker('t1');
  assert.equal(unread, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /1 unread agent-bus message/);
  assert.equal(runtime.state.findByTaskId('t1')?.wakes, 1);
  assert.equal(runtime.state.findByTaskId('t1')?.lastWakeUnread, 1);

  await watcher.checkWorker('t1');
  assert.equal(prompts.length, 1, 'no second wake while the backlog is unchanged');
});

test('a muted worker is not woken even with real unread messages', { skip: !cli }, async () => {
  if (!cli) {
    return;
  }
  const projectDir = mkdtempSync(join(tmpdir(), 'wake-mute-'));
  const busDir = mkdtempSync(join(tmpdir(), 'wake-bus-'));
  mkdirSync(join(projectDir, '.aider-desk'), { recursive: true });

  const project = `mute-${Date.now().toString(36)}`;
  writeFileSync(
    join(projectDir, '.aider-desk', 'agent-bus.json'),
    JSON.stringify({
      team: `${project}-team`,
      agentBus: { project, binary: cli.cli, nodeBinary: cli.node, dataDir: busDir },
      isolation: { mode: 'shared' },
      profiles: { provider: 'test', model: 'test-model' },
    }),
    'utf-8',
  );

  const prompts: string[] = [];
  const task = {
    data: {
      id: 't1',
      name: 'Worker',
      baseDir: projectDir,
      mainModel: 'm',
      aiderTotalCost: 0,
      agentTotalCost: 0,
      workingMode: 'local',
    },
    runPromptInAgent: async () => {
      prompts.push('wake');
      return [];
    },
  } as unknown as TaskContext;

  const context = {
    getProjectDir: () => projectDir,
    getProjectContext: () => ({
      baseDir: projectDir,
      createTask: async () => task.data,
      getTask: () => task,
      getTasks: async () => [task.data],
    }),
    getTaskContext: () => null,
    log: () => undefined,
  } as unknown as ExtensionContext;

  const runtime = new ProjectRuntime(context);
  runtime.state.upsertWorker({
    agentName: `${project}-worker`,
    taskId: 't1',
    role: 'developer',
    name: 'worker',
    capabilities: [],
    worktree: null,
    status: 'idle',
    muted: true,
  });

  await runtime.bus.register({ name: `${project}-sender`, role: 'developer', capabilities: [] });
  await runtime.bus.register({ name: `${project}-worker`, role: 'developer', capabilities: [] });
  await runtime.bus.send(`${project}-sender`, `${project}-worker`, 'still muted?');

  const unread = await new InboxWatcher(runtime).checkWorker('t1');

  assert.equal(unread, 1);
  assert.equal(prompts.length, 0);
});
