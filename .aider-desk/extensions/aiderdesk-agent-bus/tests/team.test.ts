import assert from 'node:assert/strict';
import test from 'node:test';

import type { TaskContext } from '@aiderdesk/extensions';

import { ensureMaster, spawnWorkers, stopWorker } from '../src/orchestration/team.js';
import { makeRuntime } from './fakes.js';

test('spawn creates a task with profile, worktree mode and a registration prompt', async () => {
  const { runtime, fake } = makeRuntime();

  const [outcome] = await spawnWorkers(runtime, [
    { name: 'backend', role: 'developer', task: 'Implement the users API' },
  ]);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.agentName, 'test-project-backend');

  const [created] = fake.calls.createTask;
  assert.equal(created.name, 'backend (developer)');
  assert.equal(created.mode, 'code');
  assert.equal(created.activate, false);
  assert.equal(created.workingMode, 'worktree');
  assert.equal(created.agentProfileId, 'agent-bus-developer');
  assert.equal(created.parentId, null);

  const worker = runtime.state.findByTaskId(outcome.taskId!);
  assert.equal(worker?.agentName, 'test-project-backend');
  assert.equal(worker?.worktree, `/tmp/worktrees/${outcome.taskId}`);

  const prompt = fake.calls.prompts[0].prompt;
  assert.match(prompt, /agent name: test-project-backend/);
  assert.match(prompt, /team: test-team/);
  assert.match(prompt, /"name": "test-project-backend"/);
  assert.match(prompt, /## Assigned work package\n\nImplement the users API/);
  assert.equal(fake.calls.prompts[0].mode, 'code');
});

test('spawn falls back to switching into a worktree when the task starts local', async () => {
  const { runtime, fake } = makeRuntime({}, { workingMode: 'local' });

  await spawnWorkers(runtime, [{ name: 'frontend', role: 'developer', task: 'Build the UI' }]);

  assert.equal(fake.calls.switches.length, 1);
  assert.equal(fake.calls.switches[0].options.carryOverUncommittedChanges, false);
});

test('shared isolation never requests a worktree', async () => {
  const { runtime, fake } = makeRuntime({ isolation: { mode: 'shared' } });

  await spawnWorkers(runtime, [{ name: 'qa', role: 'reviewer', task: 'Review the API' }]);

  assert.equal(fake.calls.createTask[0].workingMode, 'local');
  assert.equal(fake.calls.switches.length, 0);
  assert.equal(runtime.state.workers[0].role, 'reviewer');
});

test('worker task adopts the known provider/model pair', async () => {
  const { runtime, fake } = makeRuntime({}, { provider: 'old', model: 'old-model' });

  await spawnWorkers(runtime, [{ name: 'backend', role: 'developer', task: 'Do work' }]);

  assert.deepEqual(fake.calls.updateTask[0].updates, { provider: 'test', model: 'test-model' });
});

test('maxWorkers is enforced', async () => {
  const { runtime, fake } = makeRuntime({ orchestration: { maxWorkers: 1 } });

  const outcomes = await spawnWorkers(runtime, [
    { name: 'one', role: 'developer', task: 'A' },
    { name: 'two', role: 'developer', task: 'B' },
  ]);

  assert.equal(outcomes[0].ok, true);
  assert.equal(outcomes[1].ok, false);
  assert.match(outcomes[1].error ?? '', /maxWorkers \(1\) reached/);
  assert.equal(fake.calls.createTask.length, 1);
});

test('duplicate worker names get a unique bus identity', async () => {
  const { runtime } = makeRuntime();

  const outcomes = await spawnWorkers(runtime, [
    { name: 'backend', role: 'developer', task: 'A' },
    { name: 'backend', role: 'developer', task: 'B' },
  ]);

  assert.equal(outcomes[0].agentName, 'test-project-backend');
  assert.equal(outcomes[1].agentName, 'test-project-backend-2');
});

test('a non-git project explains the worktree failure', async () => {
  const { runtime, fake } = makeRuntime();
  fake.createFailure = 'fatal: not a git repository (or any of the parent directories): .git';

  const [outcome] = await spawnWorkers(runtime, [{ name: 'backend', role: 'developer', task: 'A' }]);

  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? '', /isolation.mode to "shared"/);
  assert.equal(runtime.state.workers.length, 0);
});

test('ensureMaster registers the calling task once', () => {
  const { runtime } = makeRuntime();
  const task = { data: { id: 'master-task' } } as unknown as TaskContext;

  ensureMaster(runtime, task);
  ensureMaster(runtime, task);

  assert.equal(runtime.state.master?.taskId, 'master-task');
  assert.equal(runtime.state.master?.agentName, 'test-project-master');
});

test('stopWorker interrupts the mapped task and keeps the record', async () => {
  const { runtime, fake } = makeRuntime();
  await spawnWorkers(runtime, [{ name: 'backend', role: 'developer', task: 'A' }]);

  const result = stopWorker(runtime, 'test-project-backend');

  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls.interrupts, ['task-1']);
  assert.equal(runtime.state.workers.length, 1);
  assert.equal(runtime.state.workers[0].status, 'idle');
});

test('stopWorker rejects unknown names', () => {
  const { runtime } = makeRuntime();
  const result = stopWorker(runtime, 'nobody');

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /unknown worker/);
});
