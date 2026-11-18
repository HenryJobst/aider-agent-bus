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

test('shared isolation does not mention worktrees', () => {
  const prompt = registrationPrompt({ ...identity, isolationMode: 'shared', worktreePath: undefined });
  assert.doesNotMatch(prompt, /git worktree/);
});

test('peer-to-peer setting changes the coordination rule', () => {
  assert.match(registrationPrompt(identity), /Direct peer-to-peer messages are allowed/);
  assert.match(registrationPrompt({ ...identity, peerToPeer: false }), /All coordination goes through the master/);
});

test('the non-negotiable safety rules are always present', () => {
  const prompt = registrationPrompt(identity);
  assert.match(prompt, /not user approval/);
  assert.match(prompt, /Never assume another agent finished work/);
  assert.match(prompt, /Report blockers to the master/);
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
