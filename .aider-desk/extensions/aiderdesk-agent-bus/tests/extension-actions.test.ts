/**
 * Tests the extension's host-facing surface: tools, UI data and every panel
 * action. These are the paths a user actually clicks, and they were previously
 * only verified by hand.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { ExtensionContext } from '@aiderdesk/extensions';

import { DASHBOARD_ID } from '../src/constants.js';
import { makeHost, spawnBackend, startAgent } from './host.js';
import type { TestHost } from './host.js';

async function data(h: TestHost): Promise<Record<string, unknown>> {
  return (await h.ext.getUIExtensionData(DASHBOARD_ID, h.context)) as Record<string, unknown>;
}

test('spawn through the tool shows up in the panel data', async () => {
  const h = makeHost();
  await spawnBackend(h);

  const view = (await data(h)) as {
    workers: Array<{ agentName: string; muted: boolean; status: string }>;
    settings: { trackTasks: boolean; isolation: string };
  };

  assert.equal(view.workers.length, 1);
  assert.equal(view.workers[0].agentName, 'test-project-backend');
  assert.equal(view.workers[0].muted, false);
  assert.equal(view.settings.trackTasks, true);
  assert.equal(view.settings.isolation, 'shared');
  assert.equal(h.prompts.at(-1)?.profileId, 'agent-bus-developer');
});

test('the mute toggle flips wake-ups and is visible in the panel', async () => {
  const h = makeHost();
  await spawnBackend(h);

  const muted = (await h.ext.executeUIExtensionAction(
    DASHBOARD_ID,
    'toggle-mute',
    ['test-project-backend'],
    h.context,
  )) as {
    ok: boolean;
    muted: boolean;
  };
  assert.equal(muted.ok, true);
  assert.equal(muted.muted, true);

  const view = (await data(h)) as { workers: Array<{ muted: boolean }> };
  assert.equal(view.workers[0].muted, true);
});

test('remove drops the participant from the panel', async () => {
  const h = makeHost();
  await spawnBackend(h);

  const result = (await h.ext.executeUIExtensionAction(
    DASHBOARD_ID,
    'remove-worker',
    ['test-project-backend'],
    h.context,
  )) as { ok: boolean };

  assert.equal(result.ok, true);
  const view = (await data(h)) as { workers: unknown[] };
  assert.equal(view.workers.length, 0);
  assert.ok(h.busCalls().some((call) => call.includes('remove-member')));
});

test('set-config writes the project file and is reflected immediately', async () => {
  const h = makeHost();
  await spawnBackend(h);

  const result = (await h.ext.executeUIExtensionAction(
    DASHBOARD_ID,
    'set-config',
    ['orchestration.trackTasks', 'false'],
    h.context,
  )) as { ok: boolean; value: unknown };

  assert.equal(result.ok, true);
  assert.equal(result.value, false);
  const view = (await data(h)) as { settings: { trackTasks: boolean } };
  assert.equal(view.settings.trackTasks, false);
});

test('isolation is refused while a worker is running', async () => {
  const h = makeHost();
  await spawnBackend(h);
  await startAgent(h, 'task-1');

  const result = (await h.ext.executeUIExtensionAction(
    DASHBOARD_ID,
    'set-config',
    ['isolation.mode', 'worktree'],
    h.context,
  )) as { ok: boolean; error?: string };

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /stop the running workers/);
});

test('stop-all interrupts running agents and reports the count', async () => {
  const h = makeHost();
  await spawnBackend(h);
  await startAgent(h, 'task-1');

  const first = (await h.ext.executeUIExtensionAction(DASHBOARD_ID, 'stop-all', [], h.context)) as {
    ok: boolean;
    stopped: string[];
  };
  assert.equal(first.ok, true);
  assert.deepEqual(first.stopped, ['test-project-backend']);
  assert.deepEqual(h.interrupts, ['task-1']);

  await h.ext.onAgentFinished({ aborted: true } as never, h.context);
  const second = (await h.ext.executeUIExtensionAction(DASHBOARD_ID, 'stop-all', [], h.context)) as {
    stopped: string[];
  };
  assert.deepEqual(second.stopped, []);
});

test('refresh reports registration truth instead of raw CLI errors', async () => {
  const h = makeHost();
  await spawnBackend(h);

  const result = (await h.ext.executeUIExtensionAction(DASHBOARD_ID, 'refresh', [], h.context)) as {
    ok: boolean;
    registered: number;
    total: number;
  };

  assert.equal(result.ok, true);
  assert.equal(result.total, 1);
  assert.equal(result.registered, 1);
});

test('stop-worker logs the failure for an unknown name', async () => {
  const h = makeHost();
  await spawnBackend(h);

  const result = (await h.ext.executeUIExtensionAction(DASHBOARD_ID, 'stop-worker', ['nope'], h.context)) as {
    ok: boolean;
    error: string;
  };

  assert.equal(result.ok, false);
  assert.match(result.error, /unknown worker/);
  assert.ok(
    h.logs.some((entry) => entry.message.includes('stop failed for "nope"')),
    'failure is logged',
  );
});

test('unknown actions and components are rejected', async () => {
  const h = makeHost();

  assert.equal(await h.ext.executeUIExtensionAction('other-component', 'refresh', [], h.context), undefined);

  const unknown = (await h.ext.executeUIExtensionAction(DASHBOARD_ID, 'nope', [], h.context)) as {
    ok: boolean;
    error: string;
  };
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown action/);
});

test('refresh closes workers whose task no longer exists', async () => {
  const h = makeHost();
  await spawnBackend(h);
  h.createTask('keep', 'keep');
  h.tasks.delete('task-1');

  await h.ext.executeUIExtensionAction(DASHBOARD_ID, 'refresh', [], h.context);

  const view = (await data(h)) as { workers: Array<{ status: string }> };
  assert.equal(view.workers[0].status, 'closed', 'refresh must not resurrect a closed worker');
});

test('a host without an open project gets no data and a clear action error', async () => {
  const h = makeHost();
  const context = {
    getProjectDir: () => '',
    getProjectContext: () => {
      throw new Error('no project');
    },
    getTaskContext: () => null,
    log: () => undefined,
    triggerUIDataRefresh: () => undefined,
  } as unknown as ExtensionContext;

  assert.deepEqual(await h.ext.getUIExtensionData(DASHBOARD_ID, context), { available: false });
  assert.deepEqual(await h.ext.executeUIExtensionAction(DASHBOARD_ID, 'refresh', [], context), {
    ok: false,
    error: 'no project',
  });
});
