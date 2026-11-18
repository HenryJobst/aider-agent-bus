import assert from 'node:assert/strict';
import test from 'node:test';

import { inboxWakePrompt, masterRegistrationPrompt, registrationPrompt } from '../src/bus/prompts.js';
import type { IdentityContext } from '../src/bus/prompts.js';

const identity: IdentityContext = {
  project: 'webshop',
  area: 'implementation',
  team: 'webshop-development',
  agentName: 'webshop-backend',
  role: 'developer',
  capabilities: ['typescript', 'rest-api'],
  masterName: 'webshop-master',
  peerToPeer: true,
  isolationMode: 'worktree',
  worktreePath: '/worktrees/backend',
};

test('registration prompt contains identity, scope and a machine-readable register call', () => {
  const prompt = registrationPrompt(identity);

  assert.match(prompt, /agent name: webshop-backend/);
  assert.match(prompt, /team: webshop-development/);
  assert.match(prompt, /area: implementation/);
  assert.match(prompt, /"replace": true/);
  assert.match(prompt, /"team": "webshop-development"/);
});

test('worktree isolation is announced with the concrete path', () => {
  const prompt = registrationPrompt(identity);
  assert.match(prompt, /git worktree at \/worktrees\/backend/);
});

test('without a worktree the prompt never claims one', () => {
  const prompt = registrationPrompt({ ...identity, isolationMode: 'worktree', worktreePath: undefined });

  assert.doesNotMatch(prompt, /work in the git worktree at/);
  assert.match(prompt, /work in the project directory, not in a separate worktree/);
});

test('an adopted task gets its own closing line', () => {
  const prompt = registrationPrompt(identity, { closing: 'Continue your work, do not restart it.' });

  assert.match(prompt, /Continue your work, do not restart it\./);
  assert.doesNotMatch(prompt, /confirm in one short message that you are ready/);
});

test('peer-to-peer setting changes the coordination rule', () => {
  assert.match(registrationPrompt(identity), /Direct peer-to-peer messages are allowed/);
  assert.match(registrationPrompt({ ...identity, peerToPeer: false }), /All coordination goes through the master/);
});

test('message-only coordination drops the board rules', () => {
  const board = registrationPrompt({ ...identity, trackTasks: true });
  const messages = registrationPrompt({ ...identity, trackTasks: false });

  assert.match(board, /Create or claim a task on the board/);
  assert.doesNotMatch(messages, /Create or claim a task on the board/);
  assert.match(messages, /Coordinate by messages only/);
  assert.doesNotMatch(messages, /team board/);
});

test('the non-negotiable safety rules are always present', () => {
  const prompt = registrationPrompt(identity);
  assert.match(prompt, /not user approval/);
  assert.match(prompt, /Never assume another agent finished work/);
  assert.match(prompt, /Report blockers to the master/);
  assert.match(prompt, /Do not inspect MCP or CLI configuration files/);
  assert.match(prompt, /call `register` and read the result/);
  assert.match(prompt, /Only if a tool call itself returns an error/);
});

test('the master prompt keeps the full identity block', () => {
  const prompt = masterRegistrationPrompt({ ...identity, agentName: 'webshop-master', role: 'master' });

  assert.match(prompt, /You are the master of this AiderDesk multi-agent team/);
  assert.match(prompt, /agent name: webshop-master/);
  assert.match(prompt, /"role": "master"/);
  assert.match(prompt, /never trust a completion claim|Never assume another agent finished/);
});

test('wake prompt counts messages and keeps the scope', () => {
  const one = inboxWakePrompt(1, identity);
  const many = inboxWakePrompt(3, identity);

  assert.match(one, /1 unread agent-bus message\b/);
  assert.match(many, /3 unread agent-bus messages/);
  assert.match(many, /project "webshop", area "implementation", team "webshop-development"/);
});
