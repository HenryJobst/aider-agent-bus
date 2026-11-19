import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { AgentBusState } from '../src/core/state.js';

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'agent-bus-state-'));
}

function worker(taskId: string, agentName = `p-${taskId}`) {
  return {
    agentName,
    taskId,
    role: 'developer',
    name: taskId,
    capabilities: ['typescript'],
    worktree: `/tmp/wt/${taskId}`,
    status: 'starting' as const,
  };
}

test('upsert keeps one record per task and preserves createdAt', () => {
  const state = new AgentBusState(tempProject(), 'p', 'team');

  const created = state.upsertWorker(worker('t1'));
  const updated = state.upsertWorker({ ...worker('t1'), status: 'working', wakes: 3 });

  assert.equal(state.workers.length, 1);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.status, 'working');
  assert.equal(updated.wakes, 3);
});

test('state survives a reload and keeps the join table', () => {
  const projectDir = tempProject();
  const state = new AgentBusState(projectDir, 'p', 'team');
  state.setMaster({ agentName: 'p-master', taskId: 'master-task' });
  state.upsertWorker(worker('t1'));

  const reloaded = new AgentBusState(projectDir, 'p', 'team');

  assert.equal(reloaded.master?.agentName, 'p-master');
  assert.equal(reloaded.workers.length, 1);
  assert.equal(reloaded.findByTaskId('t1')?.agentName, 'p-t1');
});

test('reconcile marks vanished tasks as closed instead of deleting history', () => {
  const state = new AgentBusState(tempProject(), 'p', 'team');
  state.upsertWorker(worker('t1'));
  state.upsertWorker(worker('t2'));
  state.updateWorker('t2', { status: 'idle' });

  state.reconcile(new Set(['t1']));

  assert.equal(state.findByTaskId('t1')?.status, 'starting');
  assert.equal(state.findByTaskId('t2')?.status, 'closed');
  assert.equal(state.workers.length, 2);
});

test('removeWorker drops only the matching record', () => {
  const state = new AgentBusState(tempProject(), 'p', 'team');
  state.upsertWorker(worker('t1'));
  state.upsertWorker(worker('t2'));

  state.removeWorker('t1');

  assert.equal(state.workers.length, 1);
  assert.equal(state.findByTaskId('t2')?.taskId, 't2');
});

test('a corrupted state file is ignored rather than fatal', () => {
  const projectDir = tempProject();
  const state = new AgentBusState(projectDir, 'p', 'team');
  state.upsertWorker(worker('t1'));

  writeFileSync(join(projectDir, '.aider-desk', 'agent-bus-state.json'), 'not json', 'utf-8');

  const reloaded = new AgentBusState(projectDir, 'p', 'team');
  assert.deepEqual(reloaded.workers, []);
});

test('master wake bookkeeping survives a reload', () => {
  const projectDir = tempProject();
  const state = new AgentBusState(projectDir, 'p', 'team');
  state.setMaster({ agentName: 'p-master', taskId: 'master-task' });
  state.updateMaster({ wakes: 2, lastWakeUnread: 3, status: 'working' });

  const reloaded = new AgentBusState(projectDir, 'p', 'team');

  assert.equal(reloaded.master?.wakes, 2);
  assert.equal(reloaded.master?.lastWakeUnread, 3);
  assert.equal(reloaded.master?.status, 'working');
});

test('a state file with a foreign version or shape is ignored', () => {
  const projectDir = tempProject();
  mkdirSync(join(projectDir, '.aider-desk'), { recursive: true });
  const path = join(projectDir, '.aider-desk', 'agent-bus-state.json');

  writeFileSync(path, JSON.stringify({ version: 2, workers: [worker('t1')] }));
  assert.equal(new AgentBusState(projectDir, 'p', 'team').workers.length, 0);

  writeFileSync(path, JSON.stringify({ version: 1, workers: { not: 'an array' } }));
  assert.equal(new AgentBusState(projectDir, 'p', 'team').workers.length, 0);
});

test('setScope persists the new scope', () => {
  const projectDir = tempProject();
  const state = new AgentBusState(projectDir, 'p', 'team');

  state.setScope('p2', 'team2');

  const reloaded = new AgentBusState(projectDir, 'p', 'team');
  assert.equal(reloaded.project, 'p2');
  assert.equal(reloaded.team, 'team2');
});

test('clearMaster and removeWorker persist', () => {
  const projectDir = tempProject();
  const state = new AgentBusState(projectDir, 'p', 'team');
  state.setMaster({ agentName: 'p-master', taskId: 'master-task' });
  state.upsertWorker(worker('t1'));

  state.clearMaster();
  state.removeWorker('t1');

  const reloaded = new AgentBusState(projectDir, 'p', 'team');
  assert.equal(reloaded.master, undefined);
  assert.equal(reloaded.workers.length, 0);
});

test('updateWorker persists the patch', () => {
  const projectDir = tempProject();
  const state = new AgentBusState(projectDir, 'p', 'team');
  state.upsertWorker(worker('t1'));

  state.updateWorker('t1', { status: 'working', wakes: 2 });

  const reloaded = new AgentBusState(projectDir, 'p', 'team');
  assert.equal(reloaded.findByTaskId('t1')?.status, 'working');
  assert.equal(reloaded.findByTaskId('t1')?.wakes, 2);
});

test('updateMaster without a master is a no-op', () => {
  const state = new AgentBusState(tempProject(), 'p', 'team');

  assert.equal(state.updateMaster({ wakes: 1 }), undefined);
  assert.equal(state.master, undefined);
});

test('upsert keeps an explicit createdAt and wakes value', () => {
  const state = new AgentBusState(tempProject(), 'p', 'team');

  const created = state.upsertWorker({
    ...worker('t1'),
    createdAt: '2020-01-01T00:00:00.000Z',
    wakes: 4,
  });

  assert.equal(created.createdAt, '2020-01-01T00:00:00.000Z');
  assert.equal(created.wakes, 4);
});

test('reconcile persists the closed status', () => {
  const projectDir = tempProject();
  const state = new AgentBusState(projectDir, 'p', 'team');
  state.upsertWorker(worker('t1'));

  state.reconcile(new Set());

  const reloaded = new AgentBusState(projectDir, 'p', 'team');
  assert.equal(reloaded.findByTaskId('t1')?.status, 'closed');
});

test('setMaster persists on its own', () => {
  const projectDir = tempProject();
  const state = new AgentBusState(projectDir, 'p', 'team');

  state.setMaster({ agentName: 'p-master', taskId: 'master-task' });

  const reloaded = new AgentBusState(projectDir, 'p', 'team');
  assert.equal(reloaded.master?.agentName, 'p-master');
});

test('clearMaster persists on its own', () => {
  const projectDir = tempProject();
  const state = new AgentBusState(projectDir, 'p', 'team');
  state.setMaster({ agentName: 'p-master', taskId: 'master-task' });

  state.clearMaster();

  const reloaded = new AgentBusState(projectDir, 'p', 'team');
  assert.equal(reloaded.master, undefined);
});

test('updating a worker persists and keeps the original createdAt', () => {
  const projectDir = tempProject();
  const state = new AgentBusState(projectDir, 'p', 'team');
  state.upsertWorker({ ...worker('t1'), createdAt: '2020-01-01T00:00:00.000Z' });

  state.upsertWorker({ ...worker('t1'), status: 'working', createdAt: '2030-01-01T00:00:00.000Z' });

  const reloaded = new AgentBusState(projectDir, 'p', 'team');
  assert.equal(reloaded.findByTaskId('t1')?.status, 'working');
  assert.equal(reloaded.findByTaskId('t1')?.createdAt, '2020-01-01T00:00:00.000Z');
});
