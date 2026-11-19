import assert from 'node:assert/strict';
import { test } from 'vitest';

import { BusUnavailableError } from '../src/bus/client.js';
import type { BusClient } from '../src/bus/client.js';
import { collectHealth, checkRegistration } from '../src/orchestration/doctor.js';
import { ensureMaster } from '../src/orchestration/team.js';
import { makeRuntime } from './fakes.js';

function stubBus(
  runtime: ReturnType<typeof makeRuntime>['runtime'],
  behaviour: (agentName: string) => Promise<{ unread: number }>,
): void {
  runtime.bus = { inboxStatus: behaviour } as unknown as BusClient;
}

test('health separates registered, unregistered and unreachable agents', async () => {
  const { runtime } = makeRuntime();
  ensureMaster(runtime, { data: { id: 'master-task' } } as never);
  runtime.state.upsertWorker({
    agentName: 'p-backend',
    taskId: 't-backend',
    role: 'developer',
    name: 'backend',
    capabilities: [],
    worktree: null,
    status: 'idle',
  });

  stubBus(runtime, async (agentName) => {
    if (agentName === 'p-backend') {
      throw new Error(`agent '${agentName}' is not registered`);
    }
    return { unread: 0 };
  });

  const health = await collectHealth(runtime);
  const master = health.find((entry) => entry.role === 'master');
  const worker = health.find((entry) => entry.agentName === 'p-backend');

  assert.equal(master?.registered, true);
  assert.equal(worker?.registered, false);
});

test('a missing CLI is reported as unknown, not as unregistered', async () => {
  const { runtime } = makeRuntime();
  ensureMaster(runtime, { data: { id: 'master-task' } } as never);

  stubBus(runtime, async () => {
    throw new BusUnavailableError('agent-bus binary "agent-bus" not found');
  });

  const [entry] = await collectHealth(runtime);

  assert.equal(entry.registered, null);
  assert.match(entry.error ?? '', /not found/);
  assert.equal(await checkRegistration(runtime, 'anything'), null);
});

test('an unexpected error is unknown, not unregistered, and keeps its message', async () => {
  const { runtime } = makeRuntime();
  ensureMaster(runtime, { data: { id: 'master-task' } } as never);

  stubBus(runtime, async () => {
    throw new Error('database is locked');
  });

  const [entry] = await collectHealth(runtime);

  assert.equal(entry.registered, null);
  assert.equal(entry.unread, 0);
  assert.equal(entry.error, 'database is locked');
});

test('a thrown non-Error is stringified instead of crashing', async () => {
  const { runtime } = makeRuntime();
  ensureMaster(runtime, { data: { id: 'master-task' } } as never);

  stubBus(runtime, () => Promise.reject('plain failure'));

  const [entry] = await collectHealth(runtime);

  assert.equal(entry.registered, null);
  assert.equal(entry.error, 'plain failure');
});

test('checkRegistration distinguishes a registered agent from a missing one', async () => {
  const { runtime } = makeRuntime();
  stubBus(runtime, async () => {
    throw new Error("agent 'x' is not registered");
  });

  assert.equal(await checkRegistration(runtime, 'x'), false);

  stubBus(runtime, async () => ({ unread: 3 }));
  assert.equal(await checkRegistration(runtime, 'x'), true);
});
