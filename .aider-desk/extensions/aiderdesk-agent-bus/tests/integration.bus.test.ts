/**
 * Integration test against the real agent-bus CLI.
 *
 * Skipped automatically when the CLI is not installed. Uses a throwaway
 * AGENT_BUS_DIR, so it never touches the user's bus database.
 *
 * Override with AGENT_BUS_BIN (CLI entry point, e.g. dist/cli/index.js) and
 * AGENT_BUS_NODE (interpreter that can load its better-sqlite3 build).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BusClient } from '../src/bus/client.js';

function findCli(): string | undefined {
  if (process.env.AGENT_BUS_BIN) {
    return process.env.AGENT_BUS_BIN;
  }
  try {
    const found = execFileSync('sh', ['-c', 'command -v agent-bus'], { encoding: 'utf-8' }).trim();
    return found ? realpathSync(found) : undefined;
  } catch {
    return undefined;
  }
}

const CLI = findCli();

/** The CLI only loads better-sqlite3 under the Node major it was built for. */
function findNode(): string | undefined {
  const candidates = [
    process.env.AGENT_BUS_NODE,
    process.execPath,
    '/opt/homebrew/opt/node@22/bin/node',
    '/usr/local/opt/node@22/bin/node',
  ].filter((candidate): candidate is string => !!candidate);

  const dataDir = mkdtempSync(join(tmpdir(), 'agent-bus-probe-'));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const stderr = execFileSync(
        candidate,
        [CLI!, 'inbox-status', '--agent', '__probe__', '--project', 'probe', '--team', 'probe'],
        {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 20_000,
          env: { ...process.env, AGENT_BUS_DIR: dataDir },
        },
      );
      void stderr;
      return candidate;
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? '');
      if (stderr.includes('is not registered')) {
        return candidate;
      }
    }
  }
  return undefined;
}

const NODE = CLI ? findNode() : undefined;
const available = !!CLI && !!NODE;

function client(project: string, team: string, dataDir: string, cwd: string): BusClient {
  if (!CLI || !NODE) {
    throw new Error('agent-bus CLI unavailable');
  }
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

  assert.equal((await beta.inboxStatus(`${project}-beta`)).unread, 1);

  // Scoping is explicit, so another project must not see this traffic.
  const other = client(`${project}-other`, team, dataDir, dataDir);
  await other.register({ name: `${project}-other`, role: 'developer', capabilities: [] });
  assert.equal((await other.inboxStatus(`${project}-other`)).unread, 0);
});

test('inject delivers a message body that starts with a dash', { skip: !available }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-bus-it-'));
  const project = `it-${Date.now().toString(36)}`;
  const team = `${project}-team`;
  const alpha = client(project, team, dataDir, dataDir);
  const agent = `${project}-alpha`;

  await alpha.register({ name: agent, role: 'developer', capabilities: [] });

  // Without the `--` terminator the CLI reads the body as an option.
  await alpha.inject(agent, '--not-a-flag');

  assert.equal((await alpha.inboxStatus(agent)).unread, 1);

  // These two subcommands take no scope flags; the agent name has to be enough.
  await alpha.status(agent, 'working', 'integration test');
  await alpha.removeMember(agent);

  await assert.rejects(() => alpha.inboxStatus(agent), /is not registered/);
});
