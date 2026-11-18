import assert from 'node:assert/strict';
import test from 'node:test';

import { BusUnavailableError } from '../src/bus/client.js';
import type { BusClient } from '../src/bus/client.js';
import type { ProjectRuntime } from '../src/core/runtime.js';
import { spawnWorkers } from '../src/orchestration/team.js';
import { InboxWatcher } from '../src/orchestration/wakeup.js';
import { makeRuntime } from './fakes.js';

function stubBus(runtime: ProjectRuntime, unread: number): void {
  runtime.bus = {
    inboxStatus: async () => ({ unread, claimed: 0, delivered: 0, raw: {} }),
  } as unknown as BusClient;
}

async function setup(unread: number) {
  const harness = makeRuntime();
  await spawnWorkers(harness.runtime, [{ name: 'backend', role: 'developer', task: 'Implement API' }]);
  harness.runtime.state.updateWorker('task-1', { status: 'idle', wakes: 0 });
  stubBus(harness.runtime, unread);
  return { ...harness, watcher: new InboxWatcher(harness.runtime) };
}

test('an idle worker with unread messages is woken with an inbox prompt', async () => {
  const { runtime, fake, watcher } = await setup(2);
  const promptsBefore = fake.calls.prompts.length;

  const unread = await watcher.checkWorker('task-1');

  assert.equal(unread, 2);
  assert.equal(fake.calls.prompts.length, promptsBefore + 1);
  assert.match(fake.calls.prompts.at(-1)!.prompt, /2 unread agent-bus messages/);

  const worker = runtime.state.findByTaskId('task-1');
  assert.equal(worker?.wakes, 1);
  assert.equal(worker?.status, 'working');
  assert.ok(worker?.lastWakeAt);
});

test('a running task is never woken', async () => {
  const { runtime, fake, watcher } = await setup(3);
  runtime.runningTasks.add('task-1');
  const promptsBefore = fake.calls.prompts.length;

  await watcher.checkWorker('task-1');

  assert.equal(fake.calls.prompts.length, promptsBefore);
  assert.equal(runtime.state.findByTaskId('task-1')?.wakes, 0);
});

test('the wake cooldown prevents prompt storms', async () => {
  const { runtime, fake, watcher } = await setup(1);
  runtime.state.updateWorker('task-1', { lastWakeAt: new Date().toISOString() });
  const promptsBefore = fake.calls.prompts.length;

  await watcher.checkWorker('task-1');

  assert.equal(fake.calls.prompts.length, promptsBefore);
  assert.equal(runtime.state.findByTaskId('task-1')?.wakes, 0);
});

test('the wake budget per task is respected', async () => {
  const { runtime, fake, watcher } = await setup(1);
  runtime.state.updateWorker('task-1', { wakes: runtime.config.orchestration.maxWakesPerTask });
  const promptsBefore = fake.calls.prompts.length;

  await watcher.checkWorker('task-1');

  assert.equal(fake.calls.prompts.length, promptsBefore);
});

test('an empty inbox does not trigger a prompt', async () => {
  const { fake, watcher } = await setup(0);
  const promptsBefore = fake.calls.prompts.length;

  const unread = await watcher.checkWorker('task-1');

  assert.equal(unread, 0);
  assert.equal(fake.calls.prompts.length, promptsBefore);
});

test('a missing agent-bus binary degrades quietly but is reported', async () => {
  const { runtime, fake, watcher } = await setup(0);
  runtime.bus = {
    inboxStatus: async () => {
      throw new BusUnavailableError('agent-bus not found');
    },
  } as unknown as BusClient;
  const promptsBefore = fake.calls.prompts.length;

  const unread = await watcher.checkWorker('task-1');

  assert.equal(unread, 0);
  assert.equal(fake.calls.prompts.length, promptsBefore);
  assert.match(runtime.lastInboxError.get('task-1') ?? '', /not found/);
});

test('closed workers are skipped by the poller', async () => {
  const { runtime, fake, watcher } = await setup(5);
  runtime.state.updateWorker('task-1', { status: 'closed' });
  const promptsBefore = fake.calls.prompts.length;

  await watcher.pollOnce();

  assert.equal(fake.calls.prompts.length, promptsBefore);
});
