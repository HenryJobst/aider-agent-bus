import assert from 'node:assert/strict';
import test from 'node:test';

import type { TaskContext } from '@aiderdesk/extensions';

import type { BusClient } from '../src/bus/client.js';
import {
  deriveJoinName,
  ensureMaster,
  inferRole,
  joinWorker,
  registerMaster,
  removeWorker,
  spawnWorkers,
  stopWorker,
} from '../src/orchestration/team.js';
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
  assert.equal(created.mode, 'agent');
  assert.equal(created.activate, false);
  assert.equal(created.workingMode, 'worktree');
  assert.equal(created.agentProfileId, 'agent-bus-developer');
  assert.equal(created.parentId, null);

  const worker = runtime.state.findByTaskId(outcome.taskId!);
  assert.equal(worker?.agentName, 'test-project-backend');
  assert.equal(worker?.worktree, `/tmp/worktrees/${outcome.taskId}`);

  // The profile is passed explicitly: switching agentProfileId alone does not
  // enable the MCP server for the run.
  assert.equal(fake.calls.prompts[0].profileId, 'agent-bus-developer');

  const prompt = fake.calls.prompts[0].prompt;
  assert.match(prompt, /agent name: test-project-backend/);
  assert.match(prompt, /team: test-team/);
  assert.match(prompt, /"name": "test-project-backend"/);
  assert.match(prompt, /## Assigned work package\n\nImplement the users API/);
  assert.equal(fake.calls.prompts[0].mode, 'agent');
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
  assert.equal(fake.calls.updateTask[0].updates.agentProfileId, 'agent-bus-master');

  const prompt = fake.calls.prompts.at(-1)!.prompt;
  assert.match(prompt, /You are the master of this AiderDesk multi-agent team/);
  assert.match(prompt, /agent name: test-project-master/);
});

test('registerMaster switches the task to the master profile but keeps its model', async () => {
  const { runtime, fake } = makeRuntime();
  const masterTask = makeTask('master-task', runtime.projectDir, fake.calls, {
    provider: 'acme',
    model: 'acme-model',
  });

  await registerMaster(runtime, masterTask);

  assert.deepEqual(fake.calls.updateTask[0].updates, {
    agentProfileId: 'agent-bus-master',
    provider: 'acme',
    model: 'acme-model',
  });
});

test('without any known model the prompt falls back to the task profile', async () => {
  const { runtime, fake } = makeRuntime({ profiles: { provider: undefined, model: undefined } });
  const task = makeTask('plain-task', runtime.projectDir, fake.calls);

  await joinWorker(runtime, task, { name: 'backend', role: 'developer' });

  assert.equal(fake.calls.prompts.at(-1)!.profileId, undefined);
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

  assert.equal(fake.calls.prompts.at(-1)!.profileId, 'agent-bus-developer');

  const prompt = fake.calls.prompts.at(-1)!.prompt;
  assert.match(prompt, /You are joining the team with a task that is already in progress/);
  assert.match(prompt, /Do not restart the task from scratch/);
  assert.match(prompt, /agent name: test-project-frontend/);
});

test('the run uses the task mode instead of a hardcoded one', async () => {
  const { runtime, fake } = makeRuntime();
  const task = makeTask('task-in-aider-mode', runtime.projectDir, fake.calls, { currentMode: 'aider' });

  await joinWorker(runtime, task, { name: 'backend', role: 'developer' });

  assert.equal(fake.calls.prompts.at(-1)!.mode, 'aider');
});

test('join keeps the task model and only swaps the profile', async () => {
  const { runtime, fake } = makeRuntime();
  const task = makeTask('running-task', runtime.projectDir, fake.calls, {
    provider: 'acme',
    model: 'acme-model',
  });

  await joinWorker(runtime, task, { name: 'frontend', role: 'reviewer' });

  assert.deepEqual(fake.calls.updateTask[0].updates, {
    agentProfileId: 'agent-bus-reviewer',
    provider: 'acme',
    model: 'acme-model',
  });
});

test('join derives a sensible default identity from the task name', () => {
  assert.equal(deriveJoinName('M9 Pipeline', 'abcd1234'), 'm9-pipeline');
  assert.equal(deriveJoinName('Recherche (developer)', 'abcd1234'), 'recherche');
  assert.equal(deriveJoinName(undefined, 'abcd1234'), 'task-abcd');
  assert.equal(deriveJoinName('???', 'abcd1234'), 'task-abcd');
});

test('join infers the role from the profile first, then the task name', () => {
  assert.equal(inferRole('anything', 'agent-bus-reviewer'), 'reviewer');
  assert.equal(inferRole('QA Integration', undefined), 'reviewer');
  assert.equal(inferRole('Recherche Pipeline', undefined), 'analyst');
  assert.equal(inferRole('Backend API', undefined), 'developer');
});

test('join honours the configured worktree isolation', async () => {
  const { runtime, fake } = makeRuntime();
  const task = makeTask('local-task', runtime.projectDir, fake.calls, { workingMode: 'local' });

  await joinWorker(runtime, task, { name: 'backend', role: 'developer' });

  assert.equal(fake.calls.switches.length, 1);
});

test('join never moves a running task into a worktree', async () => {
  const { runtime, fake } = makeRuntime();
  const task = makeTask('busy-task', runtime.projectDir, fake.calls, { workingMode: 'local' });
  runtime.runningTasks.add('busy-task');

  const outcome = await joinWorker(runtime, task, { name: 'backend', role: 'developer' });

  assert.equal(outcome.ok, true);
  assert.equal(fake.calls.switches.length, 0);
});

test('shared isolation keeps an adopted task where it is', async () => {
  const { runtime, fake } = makeRuntime({ isolation: { mode: 'shared' } });
  const task = makeTask('local-task', runtime.projectDir, fake.calls, { workingMode: 'local' });

  await joinWorker(runtime, task, { name: 'backend', role: 'developer' });

  assert.equal(fake.calls.switches.length, 0);
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

test('removing a worker drops the mapping and tolerates a missing registration', async () => {
  const { runtime } = makeRuntime();
  await spawnWorkers(runtime, [{ name: 'backend', role: 'developer', task: 'A' }]);
  runtime.bus = {
    removeMember: async () => {
      throw new Error("agent 'test-project-backend' is not registered");
    },
  } as unknown as BusClient;

  const result = await removeWorker(runtime, 'test-project-backend');

  assert.equal(result.ok, true);
  assert.equal(result.agentName, 'test-project-backend');
  assert.equal(runtime.state.workers.length, 0);
});

test('removing an unknown worker reports instead of guessing', async () => {
  const { runtime } = makeRuntime();

  const result = await removeWorker(runtime, 'nobody');

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /unknown worker/);
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
