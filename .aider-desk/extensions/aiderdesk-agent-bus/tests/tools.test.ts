import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createTeamTools } from '../src/tools.js';

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
