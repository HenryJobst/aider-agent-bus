/**
 * Regression: AiderDesk asks for extension agents in a global context, so
 * profiles must exist without an open project. Otherwise every task that
 * references `agent-bus-*` fails with "Agent profile ... not found" and never
 * gets the agent-bus MCP server enabled.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtensionContext } from '@aiderdesk/extensions';

import AgentBusExtension from '../index.js';

function globalContext(): ExtensionContext {
  return {
    getProjectDir: () => '',
    getProjectContext: () => {
      throw new Error('no project');
    },
    getTaskContext: () => null,
    log: () => undefined,
  } as unknown as ExtensionContext;
}

test('agent profiles are registered without a project context', () => {
  const extension = new AgentBusExtension();

  const profiles = extension.getAgents(globalContext());

  assert.deepEqual(profiles.map((profile) => profile.id).sort(), [
    'agent-bus-analyst',
    'agent-bus-developer',
    'agent-bus-master',
    'agent-bus-reviewer',
  ]);
});

test('every registered profile enables the agent-bus MCP server', () => {
  const extension = new AgentBusExtension();

  const profiles = extension.getAgents(globalContext());

  for (const profile of profiles) {
    assert.deepEqual(profile.enabledServers, ['agent-bus'], profile.id);
    assert.ok(profile.provider.length > 0, profile.id);
    assert.ok(profile.model.length > 0, profile.id);
  }
});
