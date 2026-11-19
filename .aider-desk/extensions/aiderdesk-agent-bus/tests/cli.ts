/**
 * Shared discovery for the real agent-bus CLI.
 *
 * Installing the CLI is not enough: it only loads its better-sqlite3 build under
 * the Node major it was compiled for, so we probe candidate interpreters instead
 * of assuming one.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CliInfo {
  cli: string;
  node: string;
}

function findOnPath(): string | undefined {
  try {
    const found = execFileSync('sh', ['-c', 'command -v agent-bus'], { encoding: 'utf-8' }).trim();
    return found ? realpathSync(found) : undefined;
  } catch {
    return undefined;
  }
}

export function findAgentBus(): CliInfo | undefined {
  const cli = process.env.AGENT_BUS_BIN ?? findOnPath();
  if (!cli || !existsSync(cli)) {
    return undefined;
  }

  const candidates = [
    process.env.AGENT_BUS_NODE,
    process.execPath,
    '/opt/homebrew/opt/node@22/bin/node',
    '/usr/local/opt/node@22/bin/node',
  ].filter((candidate): candidate is string => !!candidate);

  const dataDir = mkdtempSync(join(tmpdir(), 'agent-bus-probe-'));
  for (const node of candidates) {
    if (!existsSync(node)) {
      continue;
    }
    try {
      execFileSync(node, [cli, 'inbox-status', '--agent', '__probe__', '--project', 'probe', '--team', 'probe'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
        env: { ...process.env, AGENT_BUS_DIR: dataDir },
      });
      return { cli, node };
    } catch (error) {
      // A non-zero exit for an unknown agent is fine; an ABI error is not.
      const stderr = String((error as { stderr?: string }).stderr ?? '');
      if (stderr.includes('is not registered')) {
        return { cli, node };
      }
    }
  }

  return undefined;
}
