import assert from 'node:assert/strict';
import test from 'node:test';

import { BusUnavailableError } from '../src/bus/client.js';
import type { BusClient } from '../src/bus/client.js';
import type { ProjectRuntime } from '../src/core/runtime.js';
import { spawnWorkers } from '../src/orchestration/team.js';
import { InboxWatcher } from '../src/orchestration/wakeup.js';
import { makeRuntime, makeTask } from './fakes.js';

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

test('a muted worker is not woken although messages are waiting', async () => {
  const { runtime, fake, watcher } = await setup(3);
  runtime.state.updateWorker('task-1', { muted: true });
  const promptsBefore = fake.calls.prompts.length;

  await watcher.checkWorker('task-1');

  assert.equal(fake.calls.prompts.length, promptsBefore);
  assert.equal(runtime.state.findByTaskId('task-1')?.wakes, 0);
});

test('an agent that ignored its inbox is not woken twice for the same backlog', async () => {
  const { runtime, fake, watcher } = await setup(2);
  runtime.state.updateWorker('task-1', {
    lastWakeUnread: 2,
    lastWakeAt: new Date(0).toISOString(),
    wakes: 1,
  });
  const promptsBefore = fake.calls.prompts.length;

  await watcher.checkWorker('task-1');

  assert.equal(fake.calls.prompts.length, promptsBefore);
});

test('progress after a wake re-enables the next wake', async () => {
  const { runtime, fake, watcher } = await setup(1);
  runtime.state.updateWorker('task-1', {
    lastWakeUnread: 2,
    lastWakeAt: new Date(0).toISOString(),
    wakes: 1,
  });
  const promptsBefore = fake.calls.prompts.length;

  await watcher.checkWorker('task-1');

  assert.equal(fake.calls.prompts.length, promptsBefore + 1);
});

test('exhausting the wake budget marks the worker blocked instead of spinning', async () => {
  const { runtime, watcher } = await setup(2);
  runtime.state.updateWorker('task-1', {
    wakes: runtime.config.orchestration.maxWakesPerTask,
    lastWakeUnread: 2,
  });

  await watcher.checkWorker('task-1');

  assert.equal(runtime.state.findByTaskId('task-1')?.status, 'blocked');
});

test('an unchanged backlog stays parked and warns only once', async () => {
  const { runtime, watcher } = await setup(2);
  let busCalls = 0;
  runtime.bus = {
    inboxStatus: async () => {
      busCalls += 1;
      return { unread: 2, claimed: 0, delivered: 0, raw: {} };
    },
  } as unknown as BusClient;

  let warnings = 0;
  const originalLog = runtime.log;
  runtime.log = ((message: string, type?: 'info' | 'error' | 'warn' | 'debug') => {
    if (type === 'warn' && message.includes('maxWakesPerTask')) {
      warnings += 1;
    }
    originalLog(message, type);
  }) as typeof runtime.log;

  runtime.state.updateWorker('task-1', {
    wakes: runtime.config.orchestration.maxWakesPerTask,
    lastWakeUnread: 2,
  });

  await watcher.checkWorker('task-1');
  await watcher.checkWorker('task-1');
  await watcher.pollOnce();

  assert.equal(busCalls, 3, 'the inbox is still read so new messages are noticed');
  assert.equal(warnings, 1);
  assert.equal(runtime.state.findByTaskId('task-1')?.status, 'blocked');
});

test('a new backlog reopens a parked worker', async () => {
  const { runtime, fake, watcher } = await setup(3);
  runtime.state.updateWorker('task-1', {
    wakes: runtime.config.orchestration.maxWakesPerTask,
    lastWakeUnread: 2,
    wakeBudgetLogged: true,
    status: 'blocked',
  });
  const promptsBefore = fake.calls.prompts.length;

  await watcher.checkWorker('task-1');

  assert.equal(fake.calls.prompts.length, promptsBefore + 1);
  const worker = runtime.state.findByTaskId('task-1');
  assert.equal(worker?.wakes, 1, 'the budget starts over for the new backlog');
  assert.equal(worker?.wakeBudgetLogged, false);
  assert.equal(worker?.status, 'working');
});

test('a worker parked without a known backlog gets one fresh try', async () => {
  // State written by an older version has no lastWakeUnread; such a worker
  // must not stay parked forever.
  const { runtime, fake, watcher } = await setup(2);
  runtime.state.updateWorker('task-1', {
    wakes: runtime.config.orchestration.maxWakesPerTask,
    status: 'blocked',
  });
  const promptsBefore = fake.calls.prompts.length;

  await watcher.checkWorker('task-1');

  assert.equal(fake.calls.prompts.length, promptsBefore + 1);
});

test('an empty inbox clears the budget and unblocks the worker', async () => {
  const { runtime, fake, watcher } = await setup(0);
  runtime.state.updateWorker('task-1', {
    wakes: runtime.config.orchestration.maxWakesPerTask,
    lastWakeUnread: 2,
    wakeBudgetLogged: true,
    status: 'blocked',
  });
  const promptsBefore = fake.calls.prompts.length;

  await watcher.checkWorker('task-1');

  const worker = runtime.state.findByTaskId('task-1');
  assert.equal(fake.calls.prompts.length, promptsBefore);
  assert.equal(worker?.wakes, 0);
  assert.equal(worker?.wakeBudgetLogged, false);
  assert.equal(worker?.lastWakeUnread, undefined);
  assert.equal(worker?.status, 'idle');
});

test('the poller notices new messages for a parked worker', async () => {
  const { runtime, fake, watcher } = await setup(3);
  runtime.state.updateWorker('task-1', {
    wakes: runtime.config.orchestration.maxWakesPerTask,
    lastWakeUnread: 3,
    wakeBudgetLogged: true,
    status: 'blocked',
  });
  const promptsBefore = fake.calls.prompts.length;

  await watcher.pollOnce();
  assert.equal(fake.calls.prompts.length, promptsBefore, 'an unchanged backlog stays parked');

  stubBus(runtime, 4);
  await watcher.pollOnce();

  assert.equal(fake.calls.prompts.length, promptsBefore + 1);
});

test('one poll tick wakes at most one worker', async () => {
  const { runtime, fake, watcher } = await setup(1);
  await spawnWorkers(runtime, [{ name: 'second', role: 'developer', task: 'B' }]);
  const second = runtime.state.workers.find((worker) => worker.name === 'second');
  assert.ok(second);
  runtime.state.updateWorker(second.taskId, { status: 'idle' });
  stubBus(runtime, 1);
  const promptsBefore = fake.calls.prompts.length;

  await watcher.pollOnce();

  assert.equal(fake.calls.prompts.length, promptsBefore + 1);
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
  runtime.state.updateWorker('task-1', {
    wakes: runtime.config.orchestration.maxWakesPerTask,
    lastWakeUnread: 1,
  });
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

test('an unregistered agent is a state, not an inbox error', async () => {
  const { runtime, fake, watcher } = await setup(0);
  runtime.bus = {
    inboxStatus: async () => {
      throw new Error("agent 'p-backend' is not registered");
    },
  } as unknown as BusClient;
  const promptsBefore = fake.calls.prompts.length;

  const unread = await watcher.checkWorker('task-1');

  assert.equal(unread, 0);
  assert.equal(fake.calls.prompts.length, promptsBefore);
  assert.equal(runtime.lastInboxError.has('task-1'), false);
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

function withMaster(unread: number) {
  const harness = makeRuntime();
  harness.fake.tasks.set('master-task', makeTask('master-task', harness.projectDir, harness.fake.calls));
  harness.runtime.state.setMaster({ agentName: 'test-project-master', taskId: 'master-task' });
  stubBus(harness.runtime, unread);
  return { ...harness, watcher: new InboxWatcher(harness.runtime) };
}

test('the master is woken when it has unread messages', async () => {
  const { runtime, fake, watcher } = withMaster(2);

  await watcher.pollOnce();

  assert.equal(fake.calls.prompts.length, 1);
  assert.equal(fake.calls.prompts[0].id, 'master-task');
  assert.equal(fake.calls.prompts[0].profileId, 'agent-bus-master');
  assert.match(fake.calls.prompts[0].prompt, /2 unread agent-bus messages/);

  const master = runtime.state.master;
  assert.equal(master?.wakes, 1);
  assert.equal(master?.status, 'working');
  assert.ok(master?.lastWakeAt);
});

test('a running master is never woken', async () => {
  const { runtime, fake, watcher } = withMaster(2);
  runtime.runningTasks.add('master-task');

  await watcher.pollOnce();

  assert.equal(fake.calls.prompts.length, 0);
});

test('the master wake respects the cooldown', async () => {
  const { runtime, fake, watcher } = withMaster(2);
  runtime.state.updateMaster({ lastWakeAt: new Date().toISOString() });

  await watcher.pollOnce();

  assert.equal(fake.calls.prompts.length, 0);
});

test('a new backlog reopens a parked master', async () => {
  const { runtime, fake, watcher } = withMaster(3);
  runtime.state.updateMaster({
    wakes: runtime.config.orchestration.maxWakesPerTask,
    lastWakeUnread: 2,
    wakeBudgetLogged: true,
    status: 'blocked',
  });

  await watcher.pollOnce();

  assert.equal(fake.calls.prompts.length, 1);
  assert.equal(runtime.state.master?.wakes, 1);
  assert.equal(runtime.state.master?.status, 'working');
});

test('an unchanged master backlog stays parked', async () => {
  const { runtime, fake, watcher } = withMaster(2);
  runtime.state.updateMaster({
    wakes: runtime.config.orchestration.maxWakesPerTask,
    lastWakeUnread: 2,
    wakeBudgetLogged: true,
    status: 'blocked',
  });

  await watcher.pollOnce();

  assert.equal(fake.calls.prompts.length, 0);
  assert.equal(runtime.state.master?.status, 'blocked');
});

test('the master is woken before any worker', async () => {
  const { runtime, fake, watcher } = await setup(2);
  fake.tasks.set('master-task', makeTask('master-task', runtime.projectDir, fake.calls));
  runtime.state.setMaster({ agentName: 'test-project-master', taskId: 'master-task' });
  const promptsBefore = fake.calls.prompts.length;

  await watcher.pollOnce();

  assert.equal(fake.calls.prompts.length, promptsBefore + 1);
  assert.equal(fake.calls.prompts.at(-1)?.id, 'master-task', 'coordination wins over worker wakes');
});
