/**
 * Tests the slash commands end to end against the fake host: argument parsing,
 * validation, the join table and the bus calls they trigger.
 */

import assert from 'node:assert/strict';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';

import type { CommandDefinition } from '@aiderdesk/extensions';

import { makeHost, spawnBackend } from './host.js';
import type { TestHost } from './host.js';

function command(h: TestHost, name: string): CommandDefinition {
  const found = h.ext.getCommands(h.context).find((candidate) => candidate.name === name);
  assert.ok(found, `command ${name} must be registered`);
  return found;
}

async function run(h: TestHost, name: string, ...args: string[]): Promise<void> {
  await command(h, name).execute(args, h.context);
}

/** Drops the `[agent-bus]` prefix the extension adds when no task is open. */
function clean(message: string): string {
  return message.replace(/^\[agent-bus\] /, '');
}

function output(h: TestHost): string {
  const last = h.logs.at(-1);
  assert.ok(last, 'command produced no output');
  return clean(last.message);
}

function errorOutput(h: TestHost): string {
  const last = h.logs.filter((entry) => entry.level === 'error').at(-1);
  assert.ok(last, 'command reported no error');
  return clean(last.message);
}

async function registerMaster(h: TestHost): Promise<void> {
  const master = h.createTask('master-task', 'pm');
  h.setCurrentTask(master);
  await run(h, 'agent-bus-init');
}

test('init writes its health report and registers the calling task as master', async () => {
  const h = makeHost();
  const master = h.createTask('master-task', 'pm');
  h.setCurrentTask(master);

  await run(h, 'agent-bus-init');
  const report = output(h);

  assert.match(report, /agent-bus enabled/);
  assert.match(report, /project: test-project/);
  assert.match(report, /team: test-team/);
  assert.match(report, /master: test-project-master/);
  assert.match(report, /bus: reachable/);
  assert.match(report, /mcp: configured \(scope: task\)/);
  assert.match(report, /registration: prompt queued/);
  assert.equal(master.data.agentProfileId, 'agent-bus-master');
  assert.equal(h.prompts.at(-1)?.profileId, 'agent-bus-master');
  assert.equal(h.uiReloads, 1, 'the panel appears once the team exists');
});

test('init without a task context reports that no master could be registered', async () => {
  const h = makeHost();
  h.setCurrentTask(null);

  await run(h, 'agent-bus-init');

  assert.match(output(h), /master: not registered/);
  assert.match(output(h), /registration: no task context/);
});

test('team lists master, workers, roles and unread counts', async () => {
  const h = makeHost();
  await spawnBackend(h);

  await run(h, 'agent-bus-team');
  const report = output(h);

  assert.match(report, /^project test-project · team test-team/);
  assert.match(report, /master {2}not registered/);
  assert.match(report, /test-project-backend {2}developer {2}(starting|idle) {2}unread 0 {2}task task-1/);
});

test('config shows every setting, one key or clamps a new value', async () => {
  const h = makeHost();

  await run(h, 'agent-bus-config');
  assert.match(output(h), /orchestration\.trackTasks = true/);
  assert.match(output(h), /Change: \/agent-bus-config <key> <value>/);

  await run(h, 'agent-bus-config', 'isolation.mode');
  assert.equal(output(h), 'isolation.mode = "shared"');

  await run(h, 'agent-bus-config', 'orchestration.maxWorkers', '20');
  assert.equal(output(h), 'orchestration.maxWorkers = 10 (applied)');
});

test('config rejects unknown keys and invalid enum values', async () => {
  const h = makeHost();

  await run(h, 'agent-bus-config', 'nope', 'x');
  assert.match(errorOutput(h), /unknown key "nope" — try enabled, team, mcpServerName/);

  await run(h, 'agent-bus-config', 'isolation.mode', 'container');
  assert.match(errorOutput(h), /isolation\.mode expects one of worktree, shared, hybrid, got "container"/);
});

test('spawn defaults to developer when the role is omitted', async () => {
  const h = makeHost();

  await run(h, 'agent-bus-spawn', 'backend', 'do', 'the', 'work');

  assert.equal(output(h), 'spawned test-project-backend as task task-1 (shared)');
  assert.equal(h.prompts.at(-1)?.profileId, 'agent-bus-developer');
  assert.match(h.prompts.at(-1)?.prompt ?? '', /## Assigned work package\n\ndo the work/);
});

test('spawn explains missing arguments instead of failing silently', async () => {
  const h = makeHost();

  await run(h, 'agent-bus-spawn', 'backend');
  assert.match(errorOutput(h), /Usage: \/agent-bus-spawn <name> \[developer\|reviewer\|analyst\] <work package>/);

  await run(h, 'agent-bus-spawn', 'backend', 'developer');
  assert.equal(errorOutput(h), 'Work package missing after the role.');
});

test('join adopts the current task with defaults from its name', async () => {
  const h = makeHost();
  const task = h.createTask('join-1', 'API review');
  h.setCurrentTask(task);

  await run(h, 'agent-bus-join');

  assert.match(output(h), /task join-1 joined the team as test-project-api-review \(reviewer, name "api-review"\)/);
  assert.equal(task.data.agentProfileId, 'agent-bus-reviewer');
  assert.equal(h.prompts.at(-1)?.profileId, 'agent-bus-reviewer');
  assert.match(h.prompts.at(-1)?.prompt ?? '', /Do not restart the task from scratch/);
  assert.equal(h.uiReloads, 1);
});

test('join outside a task explains what to do', async () => {
  const h = makeHost();

  await run(h, 'agent-bus-join');

  assert.equal(errorOutput(h), 'Open the task you want to adopt and run the command inside it.');
});

test('say relays a human message to the resolved identity', async () => {
  const h = makeHost();
  await spawnBackend(h);

  await run(h, 'agent-bus-say', 'backend', 'please', 'report');

  assert.equal(output(h), 'sent to test-project-backend: please report');
  assert.ok(
    h
      .busCalls()
      .some(
        (call) =>
          call.startsWith('send --from human --to test-project-backend') && call.includes('--message please report'),
      ),
  );
});

test('say without a message prints the usage', async () => {
  const h = makeHost();

  await run(h, 'agent-bus-say', 'backend');

  assert.equal(errorOutput(h), 'Usage: /agent-bus-say <agent name> <message>');
});

test('pause and resume flip the mute flag of a participant', async () => {
  const h = makeHost();
  await spawnBackend(h);

  await run(h, 'agent-bus-pause', 'backend');
  assert.equal(output(h), 'test-project-backend muted — messages keep queuing');

  await run(h, 'agent-bus-resume', 'backend');
  assert.equal(output(h), 'test-project-backend will be woken again');

  await run(h, 'agent-bus-pause', 'ghost');
  assert.equal(errorOutput(h), 'unknown worker "ghost"');
});

test('remove lists the participants when called without an argument', async () => {
  const h = makeHost();
  await spawnBackend(h);

  await run(h, 'agent-bus-remove');
  assert.equal(errorOutput(h), 'Usage: /agent-bus-remove <name>. Participants: test-project-backend');

  await run(h, 'agent-bus-remove', 'backend');
  assert.equal(output(h), 'removed test-project-backend from the team (the task keeps running)');
});

test('leave reports when the calling task is not part of the team', async () => {
  const h = makeHost();
  h.setCurrentTask(null);

  await run(h, 'agent-bus-leave');
  assert.equal(errorOutput(h), 'Open the task that should leave and run the command inside it.');

  h.setCurrentTask(h.createTask('lonely', 'solo'));
  await run(h, 'agent-bus-leave');
  assert.equal(errorOutput(h), 'this task is not part of the team');
});

test('reset requires confirmation before it removes identities', async () => {
  const h = makeHost();
  await registerMaster(h);
  await spawnBackend(h);

  await run(h, 'agent-bus-reset');
  assert.match(errorOutput(h), /This removes 2 identity\(ies\)/);
  assert.match(errorOutput(h), /Run `\/agent-bus-reset confirm` to proceed/);

  await run(h, 'agent-bus-reset', 'confirm');
  assert.match(output(h), /removed 2 identities/);
  assert.match(output(h), /Master cleared — run `\/agent-bus-init` to start over/);

  await run(h, 'agent-bus-team');
  assert.match(output(h), /master {2}not registered/);
  assert.match(output(h), /workers none/);
});

test('log returns the traffic and clamps the requested line count', async () => {
  const h = makeHost();

  await run(h, 'agent-bus-log');
  assert.equal(output(h), 'message from fake bus');
  assert.ok(h.busCalls().some((call) => call.startsWith('log -n 20')));

  await run(h, 'agent-bus-log', '9999');
  assert.ok(h.busCalls().some((call) => call.startsWith('log -n 200')));
});

test('doctor reports the MCP wiring and the bus-side registration', async () => {
  const h = makeHost();
  await spawnBackend(h);

  await run(h, 'agent-bus-doctor');
  const report = output(h);

  assert.match(report, /mcp: configured \(scope: task\)/);
  assert.match(report, /test-project-backend {2}developer {2}registered {2}unread 0 {2}task task-1/);
});

test('stop without an argument needs exactly one running worker', async () => {
  const h = makeHost();
  await spawnBackend(h);

  // A freshly spawned worker is "starting", which counts as running.
  await run(h, 'agent-bus-stop');
  assert.equal(output(h), 'interrupted test-project-backend');
  assert.deepEqual(h.interrupts, ['task-1']);

  await run(h, 'agent-bus-stop');
  assert.equal(errorOutput(h), 'no worker is running');
});

test('team reconciles records whose task no longer exists', async () => {
  const h = makeHost();
  await spawnBackend(h);
  h.createTask('keep', 'keep');
  h.tasks.delete('task-1');

  await run(h, 'agent-bus-team');

  assert.match(output(h), /test-project-backend {2}developer {2}closed/);
});

test('init creates the config file when the project has none', async () => {
  const h = makeHost();
  unlinkSync(join(h.projectDir, '.aider-desk', 'agent-bus.json'));
  h.setCurrentTask(h.createTask('master-task', 'pm'));

  await run(h, 'agent-bus-init');

  assert.ok(existsSync(join(h.projectDir, '.aider-desk', 'agent-bus.json')));
  assert.match(output(h), /^config: /m);
});

test('init reports a broken config instead of hiding it', async () => {
  const h = makeHost();
  writeFileSync(join(h.projectDir, '.aider-desk', 'agent-bus.json'), '{oops', 'utf-8');

  await run(h, 'agent-bus-init');

  assert.match(output(h), /\(error: Cannot parse/);
});

test('doctor explains an unregistered worker', async () => {
  const h = makeHost({ inboxMissing: true });
  await spawnBackend(h);

  await run(h, 'agent-bus-doctor');

  assert.match(output(h), /test-project-backend {2}developer {2}NOT registered/);
  assert.match(output(h), /needs a fresh prompt/);
});

test('team reports workers parked at the wake budget', async () => {
  const h = makeHost();
  await spawnBackend(h);
  const internals = h.ext as unknown as {
    getRuntime(context: unknown): {
      state: { updateWorker(taskId: string, patch: Record<string, unknown>): void };
    };
  };
  internals.getRuntime(h.context).state.updateWorker('task-1', { wakes: 3 });

  await run(h, 'agent-bus-team');

  assert.match(output(h), /1 worker\(s\) parked at maxWakesPerTask \(3\): test-project-backend/);
});
