import assert from 'node:assert/strict';
import test from 'node:test';

import type { TaskContext } from '@aiderdesk/extensions';

import { ensureMaster, joinWorker, registerMaster, spawnWorkers, stopWorker } from '../src/orchestration/team.js';
import { makeRuntime, makeTask } from './fakes.js';

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

test('a fresh project has no team, so no dashboard is registered', async () => {
  const { runtime } = makeRuntime();
  assert.equal(runtime.hasTeam, false);

  ensureMaster(runtime, { data: { id: 'master-task' } } as unknown as TaskContext);
  assert.equal(runtime.hasTeam, true);

  const other = makeRuntime();
  await spawnWorkers(other.runtime, [{ name: 'backend', role: 'developer', task: 'A' }]);
  assert.equal(other.runtime.hasTeam, true);
});

test('registerMaster persists the master and queues its registration prompt', async () => {
  const { runtime, fake } = makeRuntime();
  const masterTask = makeTask('master-task', runtime.projectDir, fake.calls);

  const result = await registerMaster(runtime, masterTask);

  assert.equal(result.ok, true);
  assert.equal(result.prompted, true);
  assert.equal(runtime.state.master?.agentName, 'test-project-master');

  const prompt = fake.calls.prompts.at(-1)!.prompt;
  assert.match(prompt, /You are the master of this AiderDesk multi-agent team/);
  assert.match(prompt, /agent name: test-project-master/);
});

test('registerMaster without a task context reports instead of registering', async () => {
  const { runtime, fake } = makeRuntime();

  const result = await registerMaster(runtime, null);

  assert.equal(result.ok, false);
  assert.equal(result.prompted, false);
  assert.match(result.error ?? '', /no task context/);
  assert.equal(fake.calls.prompts.length, 0);
});

test('joinWorker adopts an existing task without creating a new one', async () => {
  const { runtime, fake } = makeRuntime();
  const task = makeTask('running-task', runtime.projectDir, fake.calls, { workingMode: 'local' });

  const outcome = await joinWorker(runtime, task, { name: 'frontend', role: 'developer' });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.agentName, 'test-project-frontend');
  assert.equal(fake.calls.createTask.length, 0);

  // The role profile is required so the agent-bus MCP server is enabled.
  assert.equal(fake.calls.updateTask[0].updates.agentProfileId, 'agent-bus-developer');
  assert.equal(fake.calls.updateTask[0].updates.provider, 'test');
  assert.equal(fake.calls.updateTask[0].updates.model, 'test-model');

  const worker = runtime.state.findByTaskId('running-task');
  assert.equal(worker?.role, 'developer');
  assert.equal(worker?.status, 'starting');

  const prompt = fake.calls.prompts.at(-1)!.prompt;
  assert.match(prompt, /You are joining the team with a task that is already in progress/);
  assert.match(prompt, /Do not restart the task from scratch/);
  assert.match(prompt, /agent name: test-project-frontend/);
});

test('joining again keeps the identity and does not duplicate the record', async () => {
  const { runtime, fake } = makeRuntime();
  const task = makeTask('running-task', runtime.projectDir, fake.calls);

  const first = await joinWorker(runtime, task, { name: 'frontend', role: 'developer' });
  const second = await joinWorker(runtime, task, { name: 'frontend-ui', role: 'reviewer' });

  assert.equal(first.agentName, second.agentName);
  assert.equal(runtime.state.workers.length, 1);
  assert.equal(runtime.state.findByTaskId('running-task')?.role, 'reviewer');
});

test('the master cannot join as a worker', async () => {
  const { runtime, fake } = makeRuntime();
  const task = makeTask('master-task', runtime.projectDir, fake.calls);
  ensureMaster(runtime, task);

  const outcome = await joinWorker(runtime, task, { name: 'master', role: 'developer' });

  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? '', /already the team master/);
});

test('joining respects maxWorkers', async () => {
  const { runtime, fake } = makeRuntime({ orchestration: { maxWorkers: 1 } });
  await spawnWorkers(runtime, [{ name: 'backend', role: 'developer', task: 'A' }]);
  const task = makeTask('other-task', runtime.projectDir, fake.calls);

  const outcome = await joinWorker(runtime, task, { name: 'frontend', role: 'developer' });

  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? '', /maxWorkers \(1\) reached/);
  assert.equal(runtime.state.workers.length, 1);
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
