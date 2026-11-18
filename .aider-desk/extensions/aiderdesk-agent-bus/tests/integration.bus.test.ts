/**
 * Integration test against the real agent-bus CLI.
 *
 * Skipped automatically when the CLI is not installed. Uses a throwaway
 * AGENT_BUS_DIR, so it never touches the user's bus database.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BusClient } from '../src/bus/client.js';

const CLI = process.env.AGENT_BUS_BIN ?? '/opt/homebrew/lib/node_modules/@agent-bus-connect/cli/dist/cli/index.js';
const NODE = process.env.AGENT_BUS_NODE ?? '/opt/homebrew/opt/node@22/bin/node';
const available = existsSync(CLI) && existsSync(NODE);

function client(project: string, team: string, dataDir: string, cwd: string): BusClient {
  return new BusClient({
    scope: { project, team },
    binary: CLI,
    nodeBinary: NODE,
    dataDir,
    cwd,
    timeoutMs: 30_000,
  });
}

test('two identities register, message and see unread state', { skip: !available }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-bus-it-'));
  const project = `it-${Date.now().toString(36)}`;
  const team = `${project}-team`;
  const alpha = client(project, team, dataDir, dataDir);
  const beta = client(project, team, dataDir, dataDir);

  await alpha.register({ name: `${project}-alpha`, role: 'developer', capabilities: ['typescript'] });
  await beta.register({ name: `${project}-beta`, role: 'reviewer', capabilities: ['review'] });

  assert.equal((await beta.inboxStatus(`${project}-beta`)).unread, 0);

  await alpha.send(`${project}-alpha`, `${project}-beta`, 'ping from integration test');

  const status = await beta.inboxStatus(`${project}-beta`);
  assert.equal(status.unread, 1);

  // Scoping is explicit, so another project must not see this traffic.
  const other = client(`${project}-other`, team, dataDir, dataDir);
  await other.register({ name: `${project}-other`, role: 'developer', capabilities: [] });
  assert.equal((await other.inboxStatus(`${project}-other`)).unread, 0);
});
