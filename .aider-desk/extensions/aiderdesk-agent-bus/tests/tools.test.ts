import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { AgentProfile } from '@aiderdesk/extensions';

import { createTeamTools } from '../src/tools.js';
import { makeHost, spawnBackend, startAgent } from './host.js';
import type { TestHost } from './host.js';

function unusedRuntime(): never {
  throw new Error('runtime must not be resolved while listing tools');
}

test('the master gets the full control plane', () => {
  const names = createTeamTools(unusedRuntime).map((tool) => tool.name);

  assert.deepEqual(names, [
    'agent_bus_spawn_worker',
    'agent_bus_spawn_team',
    'agent_bus_join_worker',
    'agent_bus_get_team',
    'agent_bus_stop_worker',
    'agent_bus_remove_worker',
  ]);
});

test('non-master profiles can only read the team', () => {
  const names = createTeamTools(unusedRuntime, { canSpawn: false }).map((tool) => tool.name);

  assert.deepEqual(names, ['agent_bus_get_team']);
});

function masterTool(h: TestHost, name: string) {
  const found = h.ext
    .getTools(h.context, 'agent', { id: 'agent-bus-master' } as AgentProfile)
    .find((tool) => tool.name === name);
  assert.ok(found, name);
  return found;
}

async function run(h: TestHost, name: string, input: Record<string, unknown>): Promise<Record<string, any>> {
  return (await masterTool(h, name).execute(input, undefined, h.context, {})) as Record<string, any>;
}

test('spawn_team starts several workers and returns the roster', async () => {
  const h = makeHost();

  const result = await run(h, 'agent_bus_spawn_team', {
    workers: [
      { name: 'backend', role: 'developer', task: 'A' },
      { name: 'qa', role: 'reviewer', task: 'B' },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.workers.length, 2);
  assert.match(result.team, /test-project-backend/);
  assert.match(result.team, /test-project-qa/);
  assert.equal(h.tasks.size, 2);
});

test('spawn and join refuse when the extension is disabled', async () => {
  const h = makeHost({ config: { enabled: false } });

  const spawn = await run(h, 'agent_bus_spawn_worker', { name: 'b', role: 'developer', task: 'A' });
  assert.equal(spawn.ok, false);
  assert.match(spawn.error, /disabled/);

  const team = await run(h, 'agent_bus_spawn_team', {
    workers: [{ name: 'b', role: 'developer', task: 'A' }],
  });
  assert.match(team.error, /disabled/);

  const join = await run(h, 'agent_bus_join_worker', {});
  assert.match(join.error, /disabled/);
});

test('spawn_team reports the worker limit per request', async () => {
  const h = makeHost({ config: { orchestration: { maxWorkers: 1 } } });

  const result = await run(h, 'agent_bus_spawn_team', {
    workers: [
      { name: 'one', role: 'developer', task: 'A' },
      { name: 'two', role: 'developer', task: 'B' },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.workers[0].ok, true);
  assert.match(result.workers[1].error, /maxWorkers \(1\)/);
});

test('get_team reports an empty team, a roster and the master', async () => {
  const h = makeHost();

  const empty = await run(h, 'agent_bus_get_team', {});
  assert.equal(empty.ok, true);
  assert.match(empty.team, /Project: test-project/);
  assert.match(empty.team, /Workers: none/);
  assert.equal(empty.config.team, 'test-team');

  await spawnBackend(h);
  const filled = await run(h, 'agent_bus_get_team', {});
  assert.match(filled.team, /test-project-backend \| developer \| starting/);

  h.setCurrentTask(h.createTask('master-task', 'pm'));
  await h.ext
    .getCommands(h.context)
    .find((c) => c.name === 'agent-bus-init')!
    .execute([], h.context);
  const withMaster = await run(h, 'agent_bus_get_team', {});
  assert.match(withMaster.team, /Master: test-project-master \(task master-task\)/);
});

test('join_worker adopts an existing task by id', async () => {
  const h = makeHost();
  h.createTask('existing', 'API review');

  const result = await run(h, 'agent_bus_join_worker', { taskId: 'existing' });

  assert.equal(result.ok, true);
  assert.equal(result.agentName, 'test-project-api-review');
  assert.match(result.team, /test-project-api-review \| reviewer/);
  assert.equal(h.tasks.get('existing')?.data.agentProfileId, 'agent-bus-reviewer');
  assert.equal(h.uiReloads, 1);
});

test('join_worker needs a task context or an explicit id', async () => {
  const h = makeHost();

  const result = await run(h, 'agent_bus_join_worker', {});

  assert.equal(result.ok, false);
  assert.match(result.error, /no task context; pass taskId explicitly/);
});

test('stop_worker interrupts a running worker and reports unknown names', async () => {
  const h = makeHost();
  await spawnBackend(h);
  await startAgent(h, 'task-1');

  const stopped = await run(h, 'agent_bus_stop_worker', { worker: 'test-project-backend' });
  assert.equal(stopped.ok, true);
  assert.deepEqual(h.interrupts, ['task-1']);
  assert.match(stopped.team, /idle/);

  const unknown = await run(h, 'agent_bus_stop_worker', { worker: 'ghost' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown worker/);
});

test('remove_worker drops the identity and reports unknown names', async () => {
  const h = makeHost();
  await spawnBackend(h);
  const reloadsBefore = h.uiReloads;

  const removed = await run(h, 'agent_bus_remove_worker', { worker: 'test-project-backend' });
  assert.equal(removed.ok, true);
  assert.match(removed.team, /Workers: none/);
  assert.ok(h.busCalls().some((call) => call.startsWith('remove-member test-project-backend')));
  assert.equal(h.uiReloads, reloadsBefore + 1);

  const unknown = await run(h, 'agent_bus_remove_worker', { worker: 'ghost' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown worker/);
});
