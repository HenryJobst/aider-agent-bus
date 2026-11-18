import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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
