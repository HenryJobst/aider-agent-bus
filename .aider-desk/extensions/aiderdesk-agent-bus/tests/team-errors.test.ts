/**
 * Edge and failure paths of the orchestration: prompt/profile failures,
 * worktree switch errors, missing tasks, non-Error throws and the remaining
 * name-resolution fallbacks.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { TaskContext } from '@aiderdesk/extensions';

import type { BusClient } from '../src/bus/client.js';
import {
  agentNameFor,
  describeWorkers,
  ensureMaster,
  inferRole,
  joinWorker,
  leaveTeam,
  registerMaster,
  removeWorker,
  resetTeam,
  resolveAgentName,
  spawnWorkers,
  startWithRoleProfile,
  stopAll,
} from '../src/orchestration/team.js';
import { makeRuntime, makeTask } from './fakes.js';

test('a third duplicate name gets the next free suffix', async () => {
  const { runtime } = makeRuntime();

  const outcomes = await spawnWorkers(runtime, [
    { name: 'backend', role: 'developer', task: 'A' },
    { name: 'backend', role: 'developer', task: 'B' },
    { name: 'backend', role: 'developer', task: 'C' },
  ]);

  assert.deepEqual(
    outcomes.map((outcome) => outcome.agentName),
    ['test-project-backend', 'test-project-backend-2', 'test-project-backend-3'],
  );
});

test('spawn keeps requested capabilities and falls back for empty names', async () => {
  const { runtime } = makeRuntime();

  await spawnWorkers(runtime, [{ name: 'backend', role: 'developer', task: 'A', capabilities: ['typescript', 'sql'] }]);
  assert.deepEqual(runtime.state.workers[0].capabilities, ['typescript', 'sql']);
  assert.equal(agentNameFor(runtime, '!!!'), 'test-project-worker');
  assert.equal(inferRole(undefined), 'developer');
});

test('spawn reports a created task that never reached memory', async () => {
  const { runtime } = makeRuntime();
  runtime.projectContext.getTask = () => null;

  const [outcome] = await spawnWorkers(runtime, [{ name: 'backend', role: 'developer', task: 'A' }]);

  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? '', /was created but is not available in memory/);
  assert.equal(runtime.state.workers.length, 0);
});

test('spawn explains a failing worktree switch without a git hint', async () => {
  const { runtime } = makeRuntime({}, { workingMode: 'local', failSwitch: 'permission denied' });

  const [outcome] = await spawnWorkers(runtime, [{ name: 'backend', role: 'developer', task: 'A' }]);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'permission denied');
  assert.equal(runtime.state.workers.length, 0);
});

test('spawn stringifies a non-Error creation failure', async () => {
  const { runtime } = makeRuntime();
  runtime.projectContext.createTask = () => Promise.reject('plain failure');

  const [outcome] = await spawnWorkers(runtime, [{ name: 'backend', role: 'developer', task: 'A' }]);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'plain failure');
});

test('spawn blocks the worker when its first prompt cannot be sent', async () => {
  const { runtime } = makeRuntime({ profiles: {} }, { failRunPrompt: 'prompt exploded' });

  const [outcome] = await spawnWorkers(runtime, [{ name: 'backend', role: 'developer', task: 'A' }]);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'prompt exploded');
  assert.equal(runtime.state.findByTaskId(outcome.taskId ?? '')?.status, 'blocked');
});

test('registerMaster reports a failing registration prompt', async () => {
  const { runtime, fake } = makeRuntime({ profiles: {} }, { failRunPrompt: 'prompt exploded' });
  const task = makeTask('master-task', runtime.projectDir, fake.calls, { failRunPrompt: 'prompt exploded' });

  const result = await registerMaster(runtime, task);

  assert.equal(result.ok, false);
  assert.equal(result.prompted, false);
  assert.equal(result.error, 'prompt exploded');
});

test('join explains a failing worktree switch', async () => {
  const { runtime, fake } = makeRuntime({}, { workingMode: 'local', failSwitch: 'permission denied' });
  const task = makeTask('joined', runtime.projectDir, fake.calls, {
    workingMode: 'local',
    failSwitch: 'permission denied',
  });

  const result = await joinWorker(runtime, task, { name: 'joined', role: 'developer' });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'permission denied');
  assert.equal(runtime.state.workers.length, 0);
});

test('join blocks the worker when its prompt cannot be sent', async () => {
  const { runtime, fake } = makeRuntime({ profiles: {} }, { failRunPrompt: 'prompt exploded' });
  const task = makeTask('joined', runtime.projectDir, fake.calls, { failRunPrompt: 'prompt exploded' });

  const result = await joinWorker(runtime, task, { name: 'joined', role: 'developer', capabilities: ['ts'] });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'prompt exploded');
  assert.deepEqual(runtime.state.findByTaskId('joined')?.capabilities, ['ts']);
  assert.equal(runtime.state.findByTaskId('joined')?.status, 'blocked');
});

test('a profile switch failure is logged and does not stop the join', async () => {
  const { runtime, fake } = makeRuntime();
  const logs: string[] = [];
  runtime.log = (message) => logs.push(message);
  const task = makeTask('joined', runtime.projectDir, fake.calls, { provider: 'acme', model: 'acme-model' });
  task.updateTask = () => Promise.reject('plain update failure');

  const result = await joinWorker(runtime, task, { name: 'joined', role: 'reviewer' });

  assert.equal(result.ok, true);
  assert.ok(logs.some((line) => line.includes('plain update failure')));
});

test('identity helpers fall back when the project slug is empty', () => {
  const { runtime } = makeRuntime();
  runtime.config.agentBus.project = '';

  assert.equal(agentNameFor(runtime, 'backend'), 'project-backend');

  ensureMaster(runtime, { data: { id: 'master-task' } } as TaskContext);
  assert.equal(runtime.state.master?.agentName, 'project-master');
});

test('a profile switch failure with an Error logs its message', async () => {
  const { runtime, fake } = makeRuntime();
  const logs: string[] = [];
  runtime.log = (message) => logs.push(message);
  const task = makeTask('joined', runtime.projectDir, fake.calls, { provider: 'acme', model: 'acme-model' });
  task.updateTask = () => Promise.reject(new Error('profile switch failed'));

  await joinWorker(runtime, task, { name: 'joined', role: 'reviewer' });

  assert.ok(logs.some((line) => line.includes('profile switch failed')));
});

test('a rejected agent run with an Error logs its message', async () => {
  const { runtime, fake } = makeRuntime();
  const logs: string[] = [];
  runtime.log = (message) => logs.push(message);
  const task = makeTask('run', runtime.projectDir, fake.calls);
  task.runPromptInAgent = () => Promise.reject(new Error('run exploded'));

  await startWithRoleProfile(runtime, task, 'developer', 'do the work');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(logs.some((line) => line.includes('run exploded')));
});

test('a rejected agent run is logged without failing the caller', async () => {
  const { runtime, fake } = makeRuntime();
  const logs: string[] = [];
  runtime.log = (message) => logs.push(message);
  const task = makeTask('run', runtime.projectDir, fake.calls);
  task.runPromptInAgent = () => Promise.reject('plain run failure');

  await startWithRoleProfile(runtime, task, 'developer', 'do the work');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(logs.some((line) => line.includes('plain run failure')));
});

test('removeWorker tolerates a non-Error bus failure', async () => {
  const { runtime, fake } = makeRuntime();
  const logs: string[] = [];
  runtime.log = (message) => logs.push(message);
  await spawnWorkers(runtime, [{ name: 'backend', role: 'developer', task: 'A' }]);
  runtime.bus = { removeMember: () => Promise.reject('plain failure') } as unknown as BusClient;

  const result = await removeWorker(runtime, 'test-project-backend');

  assert.equal(result.ok, true);
  assert.ok(logs.some((line) => line.includes('plain failure')));
  assert.equal(fake.calls.interrupts.length, 0);
});

test('stopAll skips a running task that is no longer loaded', async () => {
  const { runtime } = makeRuntime();
  runtime.state.upsertWorker({
    agentName: 'p-gone',
    taskId: 'gone',
    role: 'developer',
    name: 'gone',
    capabilities: [],
    worktree: null,
    status: 'working',
  });
  runtime.runningTasks.add('gone');

  const result = stopAll(runtime);

  assert.deepEqual(result.stopped, []);
  assert.deepEqual(result.skipped, ['p-gone']);
});

test('leaveTeam tolerates a failing master deregistration', async () => {
  const { runtime, fake } = makeRuntime();
  const logs: string[] = [];
  runtime.log = (message) => logs.push(message);
  const master = makeTask('master-task', runtime.projectDir, fake.calls);
  ensureMaster(runtime, master);
  runtime.bus = { removeMember: () => Promise.reject('plain failure') } as unknown as BusClient;

  const result = await leaveTeam(runtime, master);

  assert.equal(result.ok, true);
  assert.equal(result.role, 'master');
  assert.equal(runtime.state.master, undefined);
  assert.ok(logs.some((line) => line.includes('plain failure')));
});

test('resetTeam handles a worker-only team and a non-Error failure', async () => {
  const { runtime } = makeRuntime();
  runtime.state.upsertWorker({
    agentName: 'p-backend',
    taskId: 't-backend',
    role: 'developer',
    name: 'backend',
    capabilities: [],
    worktree: null,
    status: 'idle',
  });
  runtime.bus = { removeMember: () => Promise.reject('plain failure') } as unknown as BusClient;

  const result = await resetTeam(runtime);

  assert.deepEqual(result.removed, ['p-backend']);
  assert.deepEqual(result.failed, [{ agentName: 'p-backend', error: 'plain failure' }]);
});

test('resolveAgentName and describeWorkers fall back safely', async () => {
  const { runtime } = makeRuntime();
  assert.equal(resolveAgentName(runtime, 'nobody'), 'nobody');

  await spawnWorkers(runtime, [{ name: 'backend', role: 'developer', task: 'A' }]);
  assert.deepEqual(describeWorkers(runtime), [
    {
      agentName: 'test-project-backend',
      role: 'developer',
      status: 'starting',
      worktree: '/tmp/worktrees/task-1',
      taskId: 'task-1',
    },
  ]);
});

test('describeWorkers accepts a task argument shape', () => {
  const { runtime } = makeRuntime();
  runtime.state.upsertWorker({
    agentName: 'p-backend',
    taskId: 't-backend',
    role: 'reviewer',
    name: 'backend',
    capabilities: [],
    worktree: null,
    status: 'blocked',
  });

  const [described] = describeWorkers(runtime);
  assert.deepEqual(described, {
    agentName: 'p-backend',
    role: 'reviewer',
    status: 'blocked',
    worktree: null,
    taskId: 't-backend',
  });
});
