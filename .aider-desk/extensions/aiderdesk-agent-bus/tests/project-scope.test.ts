/**
 * Polling is scoped to the project AiderDesk currently shows.
 *
 * Regression: after switching projects, the extension kept polling the project
 * the user had just left. On a slow bus (or a full disk) the CLI calls stacked
 * up and wake prompts started agents in the background, which made the app feel
 * hung.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type AgentBusExtension from '../index.js';
import type { TestHost } from './host.js';
import { makeHost, spawnBackend, startAgent } from './host.js';

interface Pollable {
  pollAll(): Promise<void>;
}

function poll(ext: AgentBusExtension): Promise<void> {
  return (ext as unknown as Pollable).pollAll();
}

function inboxCalls(host: TestHost): number {
  return host.busCalls().filter((call) => call.startsWith('inbox-status')).length;
}

async function runningWorker(host: TestHost): Promise<void> {
  await spawnBackend(host);
  await startAgent(host, 'task-1');
}

test('only the active project is polled', async () => {
  const left = makeHost();
  const active = makeHost();
  await runningWorker(left);
  await runningWorker(active);

  // One extension instance that has seen both projects, as after a switch.
  active.ext.getUIComponents(left.context);
  active.ext.getUIComponents(active.context);
  await active.ext.onProjectStarted({ baseDir: active.projectDir } as never, active.context);

  await poll(active.ext);

  assert.equal(inboxCalls(active), 1);
  assert.equal(inboxCalls(left), 0, 'the project the user left is not polled');
});

test('switching projects moves the polling to the new project', async () => {
  const first = makeHost();
  const second = makeHost();
  await runningWorker(first);
  await runningWorker(second);
  second.ext.getUIComponents(first.context);
  second.ext.getUIComponents(second.context);

  await second.ext.onProjectStarted({ baseDir: second.projectDir } as never, second.context);
  await poll(second.ext);
  const firstAfterFirstPoll = inboxCalls(first);

  await second.ext.onProjectStarted({ baseDir: first.projectDir } as never, second.context);
  await poll(second.ext);

  assert.equal(inboxCalls(first), firstAfterFirstPoll + 1);
});

test('a master-only team is polled too', async () => {
  const host = makeHost();
  host.setCurrentTask(host.createTask('master-task', 'pm'));
  await host.ext
    .getCommands(host.context)
    .find((c) => c.name === 'agent-bus-init')!
    .execute([], host.context);
  host.setCurrentTask(null);
  await host.ext.onProjectStarted({ baseDir: host.projectDir } as never, host.context);
  const before = inboxCalls(host);

  await poll(host.ext);

  assert.equal(inboxCalls(host), before + 1, 'the master inbox is checked without any worker');
});

test('stopping a project drops its runtime and stops its polling', async () => {
  const host = makeHost();
  await runningWorker(host);
  await host.ext.onProjectStarted({ baseDir: host.projectDir } as never, host.context);
  await poll(host.ext);
  const before = inboxCalls(host);

  await host.ext.onProjectStopped({ baseDir: host.projectDir } as never, host.context);
  await poll(host.ext);

  assert.equal(inboxCalls(host), before);
  assert.ok(
    host.logs.some((entry) => entry.message.includes('polling and wake-ups paused')),
    'the pause is logged',
  );
});

test('stopping another project leaves the active one alone', async () => {
  const active = makeHost();
  const other = makeHost();
  await runningWorker(active);
  await runningWorker(other);
  active.ext.getUIComponents(other.context);

  await active.ext.onProjectStarted({ baseDir: active.projectDir } as never, active.context);
  await active.ext.onProjectStopped({ baseDir: other.projectDir } as never, active.context);
  await poll(active.ext);

  assert.equal(inboxCalls(active), 1);
});

test('a slow bus does not stack overlapping polls', async () => {
  const host = makeHost({ delayMs: 150 });
  await runningWorker(host);
  await host.ext.onProjectStarted({ baseDir: host.projectDir } as never, host.context);

  await Promise.all([poll(host.ext), poll(host.ext)]);

  assert.equal(inboxCalls(host), 1, 'the second tick returns while the first is still running');
});

test('a slow poll is reported once it exceeds the budget', async () => {
  const host = makeHost({ delayMs: 1600 });
  await runningWorker(host);
  await host.ext.onProjectStarted({ baseDir: host.projectDir } as never, host.context);

  await poll(host.ext);

  assert.ok(
    host.logs.some((entry) => entry.message.includes('took')),
    'slow polls must be visible in the log',
  );
});
