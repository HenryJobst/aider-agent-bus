import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { ToolApprovalState } from '@aiderdesk/extensions';
import type { AgentProfile } from '@aiderdesk/extensions';

import { buildProfile, buildProfiles, resolveRole } from '../src/profiles.js';
import type { ProfileOptions, TeamRole } from '../src/profiles.js';

const options: ProfileOptions = {
  mcpServerName: 'agent-bus',
  peerToPeer: false,
  maxIterations: 42,
  defaults: { provider: 'openai', model: 'gpt-5' },
};

describe('resolveRole', () => {
  test('accepts the canonical roles regardless of casing', () => {
    for (const role of ['master', 'developer', 'reviewer', 'analyst'] as TeamRole[]) {
      assert.equal(resolveRole(role), role);
      assert.equal(resolveRole(role.toUpperCase()), role);
    }
  });

  test('maps common aliases and falls back to developer', () => {
    assert.equal(resolveRole('qa'), 'reviewer');
    assert.equal(resolveRole('Review'), 'reviewer');
    assert.equal(resolveRole('planner'), 'analyst');
    assert.equal(resolveRole('PLAN'), 'analyst');
    assert.equal(resolveRole('backend'), 'developer');
    assert.equal(resolveRole(''), 'developer');
  });
});

describe('buildProfile', () => {
  test('passes through the provider, model, iteration limit and MCP server', () => {
    const profile = buildProfile('developer', options);

    assert.equal(profile.id, 'agent-bus-developer');
    assert.equal(profile.name, 'Agent Bus Developer');
    assert.equal(profile.provider, 'openai');
    assert.equal(profile.model, 'gpt-5');
    assert.equal(profile.maxIterations, 42);
    assert.deepEqual(profile.enabledServers, ['agent-bus']);
  });

  test('only the master may spawn subagents and manage tasks', () => {
    for (const role of ['developer', 'reviewer', 'analyst'] as TeamRole[]) {
      const profile = buildProfile(role, options);
      assert.equal(profile.useSubagents, false, role);
      assert.equal(profile.useTaskTools, false, role);
    }

    const master = buildProfile('master', options);
    assert.equal(master.useSubagents, true);
    assert.equal(master.useTaskTools, true);
  });

  test('read-only roles must ask to create tasks and may never delete them', () => {
    for (const role of ['reviewer', 'analyst'] as TeamRole[]) {
      const profile = buildProfile(role, options);
      assert.equal(profile.toolApprovals['tasks---create_task'], ToolApprovalState.Ask, role);
      assert.equal(profile.toolApprovals['tasks---delete_task'], ToolApprovalState.Never, role);
    }
  });

  test('implementing roles may delete tasks after approval', () => {
    for (const role of ['master', 'developer'] as TeamRole[]) {
      const profile = buildProfile(role, options);
      assert.equal(profile.toolApprovals['tasks---delete_task'], ToolApprovalState.Ask, role);
      assert.equal(profile.toolApprovals['tasks---create_task'], undefined, role);
    }
  });

  test('file edits and bash always require approval', () => {
    for (const role of ['master', 'developer', 'reviewer', 'analyst'] as TeamRole[]) {
      const approvals = buildProfile(role, options).toolApprovals;
      assert.equal(approvals['power---file_edit'], ToolApprovalState.Ask, role);
      assert.equal(approvals['power---file_write'], ToolApprovalState.Ask, role);
      assert.equal(approvals['power---bash'], ToolApprovalState.Ask, role);
      assert.equal(approvals['power---file_read'], ToolApprovalState.Always, role);
    }
  });

  test('the peer-to-peer option changes the coordination instruction', () => {
    const direct = buildProfile('developer', options);
    assert.match(direct.customInstructions, /Route coordination through the master only\./);
    assert.doesNotMatch(direct.customInstructions, /Peer-to-peer/);

    const peer = buildProfile('developer', { ...options, peerToPeer: true });
    assert.match(peer.customInstructions, /Peer-to-peer messages between workers are allowed\./);
    assert.doesNotMatch(peer.customInstructions, /Route coordination/);
  });

  test('each role explains its own job and has a distinct colour', () => {
    const expectedColour: Record<TeamRole, string> = {
      master: '#6366f1',
      reviewer: '#f59e0b',
      developer: '#10b981',
      analyst: '#10b981',
    };

    for (const role of ['master', 'developer', 'reviewer', 'analyst'] as TeamRole[]) {
      const profile = buildProfile(role, options);
      const intro = role === 'master' ? 'the team master' : `an? ${role}`;
      assert.match(profile.customInstructions, new RegExp(`You are ${intro}`, 'i'), role);
      assert.equal(profile.subagent?.color, expectedColour[role], role);
      assert.equal(profile.subagent?.description, `${role} for the agent-bus team`, role);
    }
  });
});

test('buildProfiles returns every role in a stable order', () => {
  const profiles: AgentProfile[] = buildProfiles(options);

  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ['agent-bus-master', 'agent-bus-developer', 'agent-bus-reviewer', 'agent-bus-analyst'],
  );
});
