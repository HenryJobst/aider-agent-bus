/**
 * Error and edge paths of the slash commands: broken MCP config, unreachable or
 * misbehaving bus, failing spawn/join/stop/remove and partial resets.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { CommandDefinition } from '@aiderdesk/extensions';

import { BusUnavailableError } from '../src/bus/client.js';
import type { BusClient } from '../src/bus/client.js';
import type { ProjectRuntime } from '../src/core/runtime.js';
import { makeHost, spawnBackend } from './host.js';
import type { TestHost } from './host.js';

function command(h: TestHost, name: string): CommandDefinition {
  const found = h.ext.getCommands(h.context).find((candidate) => candidate.name === name);
  assert.ok(found, `command ${name} must be registered`);
  return found;
}

async function run(h: TestHost, name: string, ...args: string[]): Promise<void> {
  await command(h, name).execute(args, h.context);
}

function clean(message: string): string {
  return message.replace(/^\[agent-bus\] /, '');
}

function output(h: TestHost): string {
  const last = h.logs.at(-1);
  assert.ok(last, 'command produced no output');
  return clean(last.message);
}

function errorOutput(h: TestHost): string {
  const last = h.logs.filter((entry) => entry.level === 'error').at(-1);
  assert.ok(last, 'command reported no error');
  return clean(last.message);
}

function runtimeOf(h: TestHost): ProjectRuntime {
  const internals = h.ext as unknown as { getRuntime(context: unknown): ProjectRuntime };
  return internals.getRuntime(h.context);
}

function stubBus(runtime: ProjectRuntime, patch: Partial<BusClient>): void {
  runtime.bus = patch as unknown as BusClient;
}

async function initMaster(h: TestHost): Promise<void> {
  h.setCurrentTask(h.createTask('master-task', 'pm'));
  await run(h, 'agent-bus-init');
}

test('init reports a missing MCP entry and an unreadable MCP config', async () => {
  const h = makeHost();
  h.setCurrentTask(h.createTask('master-task', 'pm'));

  Object.assign(h.context, { getMcpServers: async () => ({}) });
  await run(h, 'agent-bus-init');
  assert.match(output(h), /mcp: missing — no "agent-bus" server in the AiderDesk MCP config/);

  Object.assign(h.context, {
    getMcpServers: async () => {
      throw new Error('mcp config unreadable');
    },
  });
  await run(h, 'agent-bus-init');
  assert.match(output(h), /mcp: unknown/);
});

test('init names a configured MCP server without a scope and a disabled extension', async () => {
  const h = makeHost({ config: { enabled: false } });
  h.setCurrentTask(h.createTask('master-task', 'pm'));
  Object.assign(h.context, { getMcpServers: async () => ({ 'agent-bus': { command: 'agent-bus-mcp' } }) });

  await run(h, 'agent-bus-init');

  const report = output(h);
  assert.match(report, /agent-bus disabled/);
  assert.match(report, /mcp: configured$/m);
});

test('init translates the bus failure into a readable health line', async () => {
  const cases: Array<{ error: unknown; expected: RegExp }> = [
    {
      error: new Error("agent 'test-project-master' is not registered"),
      expected: /bus: reachable, master not yet registered on the bus/,
    },
    {
      error: new Error('NODE_MODULE_VERSION 137 this Node.js version'),
      expected: /bus: unreachable: CLI ran under the wrong Node, set agentBus\.nodeBinary/,
    },
    {
      error: new BusUnavailableError('agent-bus binary "agent-bus" not found'),
      expected: /bus: unreachable: agent-bus binary "agent-bus" not found/,
    },
    {
      error: new Error('socket closed'),
      expected: /bus: unreachable: socket closed/,
    },
    {
      error: 'plain failure',
      expected: /bus: unreachable: plain failure/,
    },
  ];

  for (const item of cases) {
    const h = makeHost();
    h.setCurrentTask(h.createTask('master-task', 'pm'));
    stubBus(runtimeOf(h), {
      inboxStatus: async () => {
        throw item.error;
      },
    });

    await run(h, 'agent-bus-init');

    assert.match(output(h), item.expected);
  }
});

test('team keeps the roster readable when an inbox lookup fails', async () => {
  const h = makeHost();
  await spawnBackend(h);
  stubBus(runtimeOf(h), {
    inboxStatus: async () => {
      throw new Error('bus timeout');
    },
  });

  await run(h, 'agent-bus-team');

  const report = output(h);
  assert.match(report, /test-project-backend {2}developer {2}(starting|idle) {2}unread error: bus timeout/);
  assert.match(report, /task task-1/);
});

test('team shows the master and a worktree, and stringifies a non-Error inbox failure', async () => {
  const h = makeHost();
  await initMaster(h);
  await spawnBackend(h);
  const runtime = runtimeOf(h);
  const workerTaskId = runtime.state.workers[0]?.taskId;
  assert.ok(workerTaskId);
  runtime.state.updateWorker(workerTaskId, { worktree: '/wt/backend' });

  await run(h, 'agent-bus-team');
  const listed = output(h);
  assert.match(listed, /master {2}test-project-master/);
  assert.match(listed, /worktree \/wt\/backend/);

  stubBus(runtimeOf(h), {
    inboxStatus: () => Promise.reject('plain failure'),
  });
  await run(h, 'agent-bus-team');
  assert.match(output(h), /unread error: plain failure/);
});

test('doctor marks an unexpected bus error as unknown and shows it', async () => {
  const h = makeHost();
  await spawnBackend(h);
  stubBus(runtimeOf(h), {
    inboxStatus: async () => {
      throw new Error('socket closed');
    },
  });

  await run(h, 'agent-bus-doctor');

  const report = output(h);
  assert.match(report, /test-project-backend {2}developer {2}unknown {2}unread 0 {2}task task-1 {2}socket closed/);
  assert.doesNotMatch(report, /needs a fresh prompt/);
});

test('spawn reports a refused worker limit instead of claiming success', async () => {
  const h = makeHost({ config: { orchestration: { maxWorkers: 1 } } });
  await initMaster(h);
  await run(h, 'agent-bus-spawn', 'backend', 'do', 'the', 'work');

  await run(h, 'agent-bus-spawn', 'frontend', 'more', 'work');

  assert.match(errorOutput(h), /spawn failed: maxWorkers \(1\) reached/);
});

test('join reports a refused worker limit', async () => {
  const h = makeHost({ config: { orchestration: { maxWorkers: 1 } } });
  await spawnBackend(h);
  h.setCurrentTask(h.createTask('late', 'late task'));

  await run(h, 'agent-bus-join');

  assert.match(errorOutput(h), /join failed: maxWorkers \(1\) reached/);
});

test('stop and remove name an unknown participant', async () => {
  const h = makeHost();

  await run(h, 'agent-bus-stop', 'ghost');
  assert.equal(errorOutput(h), 'unknown worker "ghost"');

  await run(h, 'agent-bus-remove', 'ghost');
  assert.equal(errorOutput(h), 'unknown worker "ghost"');

  await run(h, 'agent-bus-remove');
  assert.equal(errorOutput(h), 'No participants to remove.');
});

test('config rejects an unknown key in read-only form too', async () => {
  const h = makeHost();

  await run(h, 'agent-bus-config', 'nope');

  assert.match(errorOutput(h), /unknown key "nope"/);
});

test('say and log surface a failing bus call', async () => {
  const h = makeHost();
  await spawnBackend(h);
  stubBus(runtimeOf(h), {
    inject: async () => {
      throw new Error('bus gone');
    },
    log: async () => {
      throw new Error('log gone');
    },
  });

  await run(h, 'agent-bus-say', 'backend', 'hello');
  assert.equal(errorOutput(h), 'send failed: bus gone');

  await run(h, 'agent-bus-log');
  assert.equal(errorOutput(h), 'log failed: log gone');

  stubBus(runtimeOf(h), { log: async () => Promise.resolve('   ') });
  await run(h, 'agent-bus-log');
  assert.equal(output(h), 'no traffic yet');

  stubBus(runtimeOf(h), {
    inject: () => Promise.reject('plain failure'),
    log: () => Promise.reject('plain failure'),
  });
  await run(h, 'agent-bus-say', 'backend', 'hello');
  assert.equal(errorOutput(h), 'send failed: plain failure');
  await run(h, 'agent-bus-log');
  assert.equal(errorOutput(h), 'log failed: plain failure');
});

test('log falls back to twenty lines for a non-numeric argument', async () => {
  const h = makeHost();

  await run(h, 'agent-bus-log', 'abc');

  assert.equal(output(h), 'message from fake bus');
  assert.ok(h.busCalls().some((call) => call.startsWith('log -n 20')));
});

test('pause and resume explain missing and unknown targets', async () => {
  const h = makeHost();
  await spawnBackend(h);

  await run(h, 'agent-bus-pause');
  assert.equal(errorOutput(h), 'Usage: /agent-bus-pause <worker name or task id>');

  await run(h, 'agent-bus-resume');
  assert.equal(errorOutput(h), 'Usage: /agent-bus-resume <worker name or task id>');

  await run(h, 'agent-bus-resume', 'ghost');
  assert.equal(errorOutput(h), 'unknown worker "ghost"');
});

test('leave removes an adopted task from the team but keeps it running', async () => {
  const h = makeHost();
  await spawnBackend(h);
  const worker = h.tasks.get('task-1');
  assert.ok(worker);
  h.setCurrentTask(worker);

  await run(h, 'agent-bus-leave');

  assert.equal(output(h), 'test-project-backend left the team (developer); the task keeps running');
  assert.ok(h.busCalls().some((call) => call.startsWith('remove-member test-project-backend')));
  assert.equal(h.uiReloads, 2, 'spawn and leave both refresh the panel');
});

test('reset mentions an empty team and reports bus-side failures', async () => {
  const empty = makeHost();
  await run(empty, 'agent-bus-reset');
  assert.equal(output(empty), 'No team identities to remove.');

  const h = makeHost();
  await initMaster(h);
  await spawnBackend(h);
  stubBus(runtimeOf(h), {
    removeMember: async () => {
      throw new Error('bus gone');
    },
  });

  await run(h, 'agent-bus-reset', 'confirm');

  const report = output(h);
  assert.match(report, /removed 2 identities/);
  assert.match(report, /bus-side failures \(clean up manually\):/);
  assert.match(report, /- test-project-master: bus gone/);
  assert.match(report, /- test-project-backend: bus gone/);
});
