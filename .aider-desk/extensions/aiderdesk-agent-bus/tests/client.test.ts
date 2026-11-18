import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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

  await client.status('p-backend', 'working');

  const [call] = readCalls(log);
  assert.deepEqual(call.slice(0, 4), ['now', '--agent', 'p-backend', '--status']);
  assert.ok(call.includes('working'));
});

test('a missing binary raises BusUnavailableError with an install hint', async () => {
  const client = new BusClient({ scope: { project: 'p', team: 't' }, binary: '/nonexistent/agent-bus' });

  await assert.rejects(
    () => client.inboxStatus('x'),
    (error: unknown) => {
      assert.ok(error instanceof BusUnavailableError);
      assert.match(error.message, /npm install -g @agent-bus-connect\/cli/);
      return true;
    },
  );

  assert.equal(await client.isAvailable(), false);
});
