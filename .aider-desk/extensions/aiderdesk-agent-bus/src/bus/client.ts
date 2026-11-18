/**
 * Thin, typed wrapper around the `agent-bus` CLI.
 *
 * The extension cannot call MCP tools itself, so the CLI is the integration
 * point for everything that has to happen without an agent in the loop
 * (health checks, unread counts, notifications). Agents keep using the MCP
 * tools for actual conversation.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface BusScope {
  project: string;
  area?: string;
  team: string;
}

export interface BusClientOptions {
  scope: BusScope;
  binary?: string;
  /**
   * Node executable used to run `binary` when it is a script. Needed when the
   * CLI was installed with a different Node major than the default `node`.
   */
  nodeBinary?: string;
  dataDir?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface InboxStatus {
  unread: number;
  claimed: number;
  delivered: number;
  raw: unknown;
}

export class BusUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusUnavailableError';
  }
}

/**
 * Non-zero exit from the CLI. `message` is the CLI's stderr, not the
 * "Command failed: …" wrapper, so callers can react to phrases like
 * "agent 'x' is not registered" instead of showing a shell command to the user.
 */
export class BusCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = 'BusCommandError';
  }
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * agent-bus reports inbox state in several shapes depending on version
 * (count fields, arrays, or nested buckets). Normalize defensively instead of
 * assuming one schema.
 */
export function normalizeInboxStatus(raw: unknown): InboxStatus {
  const root = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const counts = (root.counts && typeof root.counts === 'object' ? root.counts : {}) as Record<string, unknown>;

  const bucket = (key: string): unknown => root[key] ?? counts[key];

  const measure = (key: string, fallbackKeys: string[]): number => {
    const value = bucket(key);
    if (Array.isArray(value)) {
      return value.length;
    }
    const direct = asNumber(value);
    if (direct !== undefined) {
      return direct;
    }
    for (const fallback of fallbackKeys) {
      const alternative = asNumber(bucket(fallback));
      if (alternative !== undefined) {
        return alternative;
      }
    }
    return 0;
  };

  return {
    unread: measure('unread', ['unreadCount', 'pending']),
    claimed: measure('claimed', ['inFlight', 'in_flight']),
    delivered: measure('delivered', ['recent', 'recentDelivered']),
    raw,
  };
}

export class BusClient {
  private readonly scope: BusScope;
  private readonly binary: string;
  private readonly nodeBinary?: string;
  private readonly dataDir?: string;
  private readonly cwd?: string;
  private readonly timeoutMs: number;

  constructor(options: BusClientOptions) {
    this.scope = options.scope;
    this.binary = options.binary ?? 'agent-bus';
    this.nodeBinary = options.nodeBinary;
    this.dataDir = options.dataDir;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private scopeArgs(): string[] {
    const args = ['--project', this.scope.project];
    if (this.scope.area) {
      args.push('--area', this.scope.area);
    }
    args.push('--team', this.scope.team);
    return args;
  }

  async run(args: string[], timeoutMs = this.timeoutMs): Promise<{ stdout: string; stderr: string }> {
    const command = this.nodeBinary ?? this.binary;
    const commandArgs = this.nodeBinary ? [this.binary, ...args] : args;
    try {
      return await execFileAsync(command, commandArgs, {
        cwd: this.cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: this.dataDir ? { ...process.env, AGENT_BUS_DIR: this.dataDir } : process.env,
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
      if (err.code === 'ENOENT') {
        const runner = this.nodeBinary ? ` with node "${this.nodeBinary}"` : '';
        throw new BusUnavailableError(
          `agent-bus binary "${this.binary}" not found${runner}. Install with: npm install -g @agent-bus-connect/cli@latest`,
        );
      }

      // execFile wraps the interesting part in `stderr`; surfacing the wrapper
      // leaks a full shell command into the dashboard and hides the reason.
      const stderr = (err.stderr ?? '').trim();
      if (stderr) {
        throw new BusCommandError(stderr, typeof err.code === 'number' ? err.code : undefined);
      }
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.run(['--version'], 5_000);
      return true;
    } catch {
      return false;
    }
  }

  async inboxStatus(agentName: string): Promise<InboxStatus> {
    const { stdout } = await this.run(['inbox-status', '--agent', agentName, ...this.scopeArgs(), '--json']);
    return normalizeInboxStatus(JSON.parse(stdout));
  }

  async register(input: { name: string; role: string; capabilities: string[] }): Promise<string> {
    const args = [
      'register',
      '--name',
      input.name,
      '--role',
      input.role,
      '--capabilities',
      input.capabilities.join(','),
      ...this.scopeArgs(),
      '--replace',
    ];
    const { stdout } = await this.run(args);
    return stdout.trim();
  }

  async send(from: string, to: string, message: string, thread?: string): Promise<string> {
    const args = ['send', '--from', from, '--to', to, '--message', message, ...this.scopeArgs()];
    if (thread) {
      args.push('--thread', thread);
    }
    const { stdout } = await this.run(args);
    return stdout.trim();
  }

  async status(agentName: string, status: string, note?: string): Promise<string> {
    const args = ['now', '--agent', agentName, '--status', status];
    if (note) {
      args.push('--note', note);
    }
    const { stdout } = await this.run(args);
    return stdout.trim();
  }

  async directory(): Promise<string> {
    const { stdout } = await this.run(['whois', ...this.scopeArgs()]);
    return stdout;
  }

  async teamBoard(): Promise<string> {
    const { stdout } = await this.run(['tasks', ...this.scopeArgs()]);
    return stdout;
  }
}
