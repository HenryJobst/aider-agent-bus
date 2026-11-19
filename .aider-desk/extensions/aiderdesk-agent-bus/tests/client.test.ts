import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { BusClient, BusCommandError, BusUnavailableError, normalizeInboxStatus } from '../src/bus/client.js';

const FAKE_BUS = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_BUS_LOG) {
  fs.appendFileSync(process.env.FAKE_BUS_LOG, JSON.stringify(args) + '\\n');
}
if (args.includes('fail')) {
  process.stderr.write("error: agent 'ghost' is not registered\\n");
  process.exit(1);
} else if (args.includes('silent-fail')) {
  process.exit(3);
} else if (args.includes('die')) {
  process.stderr.write('killed by signal\\n');
  process.kill(process.pid, 'SIGTERM');
} else if (args.includes('inbox-status')) {
  process.stdout.write(JSON.stringify({ unread: 2, claimed: 1, delivered: 5 }));
} else if (args.includes('register')) {
  process.stdout.write('registered');
} else if (args.includes('send')) {
  process.stdout.write('sent');
} else if (args.includes('--version')) {
  process.stdout.write('0.43.0');
} else {
  process.stdout.write('ok');
}
`;

function fakeBinary(): { path: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bus-bin-'));
  const path = join(dir, 'agent-bus.cjs');
  writeFileSync(path, FAKE_BUS, 'utf-8');
  chmodSync(path, 0o755);
  return { path, log: join(dir, 'calls.log') };
}

test('without a binary option the client looks up "agent-bus" on PATH', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bus-path-'));
  const path = join(dir, 'agent-bus');
  writeFileSync(path, FAKE_BUS, 'utf-8');
  chmodSync(path, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath ?? ''}`;
  try {
    const client = new BusClient({ scope: { project: 'p', team: 't' } });
    assert.equal(await client.isAvailable(), true);
  } finally {
    process.env.PATH = previousPath;
  }
});

function readCalls(log: string): string[][] {
  return readFileSync(log, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

test('normalizeInboxStatus reads count fields', () => {
  const status = normalizeInboxStatus({ unread: 3, claimed: 2, delivered: 7 });
  assert.equal(status.unread, 3);
  assert.equal(status.claimed, 2);
  assert.equal(status.delivered, 7);
});

test('normalizeInboxStatus reads arrays and nested buckets', () => {
  assert.equal(normalizeInboxStatus({ unread: [{ id: 1 }, { id: 2 }] }).unread, 2);
  assert.equal(normalizeInboxStatus({ counts: { unread: '4', inFlight: 1 } }).unread, 4);
  assert.equal(normalizeInboxStatus({ counts: { unread: '4', inFlight: 1 } }).claimed, 1);
});

test('normalizeInboxStatus treats unknown shapes as empty', () => {
  const status = normalizeInboxStatus(null);
  assert.equal(status.unread, 0);
  assert.equal(status.claimed, 0);
  assert.equal(status.delivered, 0);

  assert.equal(normalizeInboxStatus({ unread: 'many' }).unread, 0);
  assert.equal(normalizeInboxStatus({ unread: '' }).unread, 0);
});

test('inboxStatus passes the explicit scope and parses JSON', async () => {
  const { path, log } = fakeBinary();
  process.env.FAKE_BUS_LOG = log;

  const client = new BusClient({
    scope: { project: 'webshop', area: 'impl', team: 'dev' },
    binary: path,
  });

  const status = await client.inboxStatus('webshop-backend');

  assert.equal(status.unread, 2);
  const [call] = readCalls(log);
  assert.deepEqual(call.slice(0, 3), ['inbox-status', '--agent', 'webshop-backend']);
  assert.ok(call.includes('--project') && call.includes('webshop'));
  assert.ok(call.includes('--area') && call.includes('impl'));
  assert.ok(call.includes('--team') && call.includes('dev'));
  assert.ok(call.includes('--json'));
});

test('register sends replace and capabilities', async () => {
  const { path, log } = fakeBinary();
  process.env.FAKE_BUS_LOG = log;

  const client = new BusClient({ scope: { project: 'p', team: 't' }, binary: path });
  const output = await client.register({ name: 'p-backend', role: 'developer', capabilities: ['ts', 'api'] });

  assert.equal(output, 'registered');
  const [call] = readCalls(log);
  assert.equal(call[0], 'register');
  assert.ok(call.includes('--replace'));
  assert.ok(call.includes('ts,api'));
  assert.ok(call.includes('--project') && call.includes('p'));
  assert.ok(!call.includes('--area'));
});

test('send builds a scoped message call', async () => {
  const { path, log } = fakeBinary();
  process.env.FAKE_BUS_LOG = log;

  const client = new BusClient({ scope: { project: 'p', team: 't' }, binary: path });
  await client.send('p-master', 'p-backend', 'hello');

  const [call] = readCalls(log);
  assert.deepEqual(call.slice(0, 6), ['send', '--from', 'p-master', '--to', 'p-backend', '--message']);
  assert.ok(call.includes('hello'));
});

test('send keeps a thread when one is given', async () => {
  const { path, log } = fakeBinary();
  process.env.FAKE_BUS_LOG = log;

  const client = new BusClient({ scope: { project: 'p', team: 't' }, binary: path });
  await client.send('p-master', 'p-backend', 'hello', 'thread-1');

  const [call] = readCalls(log);
  const threadFlag = call.indexOf('--thread');
  assert.ok(threadFlag > 0);
  assert.equal(call[threadFlag + 1], 'thread-1');
});

test('inject goes through send so the scope is explicit, log carries the scope', async () => {
  const { path, log } = fakeBinary();
  process.env.FAKE_BUS_LOG = log;

  const client = new BusClient({ scope: { project: 'p', team: 't' }, binary: path });
  await client.inject('p-backend', 'hello');
  await client.log(5);

  const calls = readCalls(log);
  assert.deepEqual(calls[0].slice(0, 6), ['send', '--from', 'human', '--to', 'p-backend', '--message']);
  assert.ok(calls[0].includes('hello'));
  assert.ok(calls[0].includes('--project') && calls[0].includes('p'));
  assert.ok(calls[0].includes('--team') && calls[0].includes('t'));
  assert.ok(calls[1].includes('log'));
  assert.ok(calls[1].includes('5'));
  assert.ok(calls[1].includes('--project') && calls[1].includes('p'));
});

test('removeMember relies on the globally unique agent name', async () => {
  const { path, log } = fakeBinary();
  process.env.FAKE_BUS_LOG = log;

  const client = new BusClient({ scope: { project: 'p', team: 't' }, binary: path });
  await client.removeMember('p-backend');

  const [call] = readCalls(log);
  assert.deepEqual(call, ['remove-member', 'p-backend']);
});

test('inject keeps a message that looks like a flag as the option value', async () => {
  const { path, log } = fakeBinary();
  process.env.FAKE_BUS_LOG = log;

  const client = new BusClient({ scope: { project: 'p', team: 't' }, binary: path });
  await client.inject('p-backend', '--delete-everything');

  const [call] = readCalls(log);
  const messageFlag = call.indexOf('--message');
  assert.ok(messageFlag > 0, 'the body is passed as an option value');
  assert.equal(call[messageFlag + 1], '--delete-everything');
});

test('a non-zero exit surfaces the CLI message, not the shell command', async () => {
  const { path, log } = fakeBinary();
  process.env.FAKE_BUS_LOG = log;

  const client = new BusClient({ scope: { project: 'p', team: 't' }, binary: path });

  await assert.rejects(
    () => client.run(['fail']),
    (error: unknown) => {
      assert.ok(error instanceof BusCommandError);
      assert.match(error.message, /agent 'ghost' is not registered/);
      assert.doesNotMatch(error.message, /Command failed/);
      return true;
    },
  );
});

test('nodeBinary runs the script through that interpreter', async () => {
  const { path, log } = fakeBinary();
  process.env.FAKE_BUS_LOG = log;

  const client = new BusClient({
    scope: { project: 'p', team: 't' },
    binary: path,
    nodeBinary: process.execPath,
  });

  await client.register({ name: 'p-backend', role: 'developer', capabilities: [] });

  const [call] = readCalls(log);
  assert.equal(call[0], 'register');
  assert.ok(call.includes('--project') && call.includes('p'));
});

test('a killed call reports stderr and leaves the exit code unset', async () => {
  const { path, log } = fakeBinary();
  process.env.FAKE_BUS_LOG = log;

  const client = new BusClient({ scope: { project: 'p', team: 't' }, binary: path });

  await assert.rejects(
    () => client.run(['die']),
    (error: unknown) => {
      assert.ok(error instanceof BusCommandError);
      assert.equal(error.message, 'killed by signal');
      assert.equal(error.exitCode, undefined);
      return true;
    },
  );
});

test('a failing call without stderr rethrows the original error', async () => {
  const { path, log } = fakeBinary();
  process.env.FAKE_BUS_LOG = log;

  const client = new BusClient({ scope: { project: 'p', team: 't' }, binary: path });

  await assert.rejects(
    () => client.run(['silent-fail']),
    (error: unknown) => {
      assert.ok(!(error instanceof BusCommandError));
      assert.equal((error as NodeJS.ErrnoException).code, 3);
      return true;
    },
  );
});

test('isAvailable reports a working binary', async () => {
  const { path, log } = fakeBinary();
  process.env.FAKE_BUS_LOG = log;

  const client = new BusClient({ scope: { project: 'p', team: 't' }, binary: path });
  assert.equal(await client.isAvailable(), true);
});

test('a missing binary raises BusUnavailableError with an install hint', async () => {
  const client = new BusClient({ scope: { project: 'p', team: 't' }, binary: '/nonexistent/agent-bus' });

  await assert.rejects(
    () => client.inboxStatus('x'),
    (error: unknown) => {
      assert.ok(error instanceof BusUnavailableError);
      assert.match(error.message, /npm install -g @agent-bus-connect\/cli/);
      assert.doesNotMatch(error.message, /with node/);
      return true;
    },
  );

  assert.equal(await client.isAvailable(), false);
});

test('the install hint names the interpreter when one is configured', async () => {
  const client = new BusClient({
    scope: { project: 'p', team: 't' },
    binary: '/nonexistent/agent-bus',
    nodeBinary: '/nonexistent/node',
  });

  await assert.rejects(
    () => client.inboxStatus('x'),
    (error: unknown) => {
      assert.ok(error instanceof BusUnavailableError);
      assert.match(error.message, /with node "\/nonexistent\/node"/);
      return true;
    },
  );
});
