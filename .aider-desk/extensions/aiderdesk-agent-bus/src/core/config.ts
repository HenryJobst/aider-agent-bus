/**
 * Project configuration for the agent-bus extension.
 *
 * Lives in `<project>/.aider-desk/agent-bus.json` and is deliberately validated
 * by hand: a malformed config must never prevent AiderDesk from loading.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type IsolationMode = 'worktree' | 'shared' | 'hybrid';
export type MergeStrategy = 'manual' | 'auto';

export interface AgentBusConfig {
  enabled: boolean;
  team: string;
  agentBus: {
    project: string;
    area?: string;
    binary: string;
    /** Run `binary` as a script with this Node executable instead of executing it directly. */
    nodeBinary?: string;
    dataDir?: string;
  };
  mcpServerName: string;
  isolation: {
    mode: IsolationMode;
    mergeStrategy: MergeStrategy;
  };
  orchestration: {
    masterEnabled: boolean;
    peerToPeerEnabled: boolean;
    /** false = coordinate by messages only, no task board rules in the prompts */
    trackTasks: boolean;
    maxWorkers: number;
    requireReview: boolean;
    pollIntervalMs: number;
    wakeCooldownMs: number;
    maxWakesPerTask: number;
  };
  profiles: {
    provider?: string;
    model?: string;
    maxIterations: number;
  };
}

export const CONFIG_FILE_NAME = 'agent-bus.json';

export function configPath(projectDir: string): string {
  return join(projectDir, '.aider-desk', CONFIG_FILE_NAME);
}

function defaultProjectName(projectDir: string): string {
  return projectDir.split(/[\\/]/).filter(Boolean).pop() ?? 'project';
}

export function defaultConfig(projectDir: string): AgentBusConfig {
  const project = defaultProjectName(projectDir);
  return {
    enabled: true,
    team: `${project}-team`,
    agentBus: {
      project,
      binary: 'agent-bus',
    },
    mcpServerName: 'agent-bus',
    isolation: {
      mode: 'worktree',
      mergeStrategy: 'manual',
    },
    orchestration: {
      masterEnabled: true,
      peerToPeerEnabled: true,
      trackTasks: true,
      maxWorkers: 5,
      requireReview: true,
      pollIntervalMs: 20_000,
      wakeCooldownMs: 15_000,
      maxWakesPerTask: 20,
    },
    profiles: {
      maxIterations: 100,
    },
  };
}

type Json = Record<string, unknown>;

function merge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return base;
  }
  const result = { ...(base as Json) };
  for (const [key, value] of Object.entries(patch as Json)) {
    const current = result[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object') {
      result[key] = merge(current, value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalize(config: AgentBusConfig): AgentBusConfig {
  const modes: IsolationMode[] = ['worktree', 'shared', 'hybrid'];
  if (!modes.includes(config.isolation.mode)) {
    config.isolation.mode = 'worktree';
  }
  if (config.isolation.mergeStrategy !== 'manual' && config.isolation.mergeStrategy !== 'auto') {
    config.isolation.mergeStrategy = 'manual';
  }
  if (typeof config.orchestration.trackTasks !== 'boolean') {
    config.orchestration.trackTasks = true;
  }
  config.orchestration.maxWorkers = clampInt(config.orchestration.maxWorkers, 1, 10, 5);
  config.orchestration.pollIntervalMs = clampInt(config.orchestration.pollIntervalMs, 5_000, 600_000, 20_000);
  config.orchestration.wakeCooldownMs = clampInt(config.orchestration.wakeCooldownMs, 0, 600_000, 15_000);
  config.orchestration.maxWakesPerTask = clampInt(config.orchestration.maxWakesPerTask, 0, 1000, 20);
  config.profiles.maxIterations = clampInt(config.profiles.maxIterations, 1, 1000, 100);
  if (typeof config.team !== 'string' || config.team.trim() === '') {
    config.team = 'default-team';
  }
  if (typeof config.agentBus.project !== 'string' || config.agentBus.project.trim() === '') {
    config.agentBus.project = 'project';
  }
  if (typeof config.agentBus.binary !== 'string' || config.agentBus.binary.trim() === '') {
    config.agentBus.binary = 'agent-bus';
  }
  if (typeof config.agentBus.nodeBinary !== 'string' || config.agentBus.nodeBinary.trim() === '') {
    delete config.agentBus.nodeBinary;
  }
  if (typeof config.mcpServerName !== 'string' || config.mcpServerName.trim() === '') {
    config.mcpServerName = 'agent-bus';
  }
  return config;
}

export interface LoadResult {
  config: AgentBusConfig;
  exists: boolean;
  error?: string;
}

export function loadConfig(projectDir: string): LoadResult {
  const base = defaultConfig(projectDir);
  const path = configPath(projectDir);

  if (!existsSync(path)) {
    return { config: base, exists: false };
  }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return { config: normalize(merge(base, raw)), exists: true };
  } catch (error) {
    return {
      config: base,
      exists: true,
      error: `Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Modification time of the config file, used to reload it without an extension reload. */
export function configMtime(projectDir: string): number | undefined {
  try {
    return statSync(configPath(projectDir)).mtimeMs;
  } catch {
    return undefined;
  }
}

export function writeDefaultConfig(projectDir: string, config: AgentBusConfig): string {
  const path = configPath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return path;
}

type ValueKind = 'boolean' | 'integer' | 'string' | readonly string[];

/**
 * Keys that can be changed through `/agent-bus-config`. A whitelist keeps the
 * command from writing arbitrary JSON into a file the extension has to trust.
 */
export const SETTABLE_KEYS: Record<string, ValueKind> = {
  enabled: 'boolean',
  team: 'string',
  mcpServerName: 'string',
  'agentBus.project': 'string',
  'agentBus.area': 'string',
  'agentBus.binary': 'string',
  'agentBus.nodeBinary': 'string',
  'isolation.mode': ['worktree', 'shared', 'hybrid'],
  'isolation.mergeStrategy': ['manual', 'auto'],
  'orchestration.masterEnabled': 'boolean',
  'orchestration.peerToPeerEnabled': 'boolean',
  'orchestration.trackTasks': 'boolean',
  'orchestration.requireReview': 'boolean',
  'orchestration.maxWorkers': 'integer',
  'orchestration.pollIntervalMs': 'integer',
  'orchestration.wakeCooldownMs': 'integer',
  'orchestration.maxWakesPerTask': 'integer',
  'profiles.provider': 'string',
  'profiles.model': 'string',
  'profiles.maxIterations': 'integer',
};

function parseValue(key: string, kind: ValueKind, raw: string): { value?: unknown; error?: string } {
  if (kind === 'boolean') {
    const normalized = raw.trim().toLowerCase();
    if (['true', 'on', 'yes', '1'].includes(normalized)) {
      return { value: true };
    }
    if (['false', 'off', 'no', '0'].includes(normalized)) {
      return { value: false };
    }
    return { error: `${key} expects true or false, got "${raw}"` };
  }

  if (kind === 'integer') {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      return { error: `${key} expects a number, got "${raw}"` };
    }
    return { value: parsed };
  }

  if (Array.isArray(kind)) {
    const normalized = raw.trim();
    if (!kind.includes(normalized)) {
      return { error: `${key} expects one of ${kind.join(', ')}, got "${raw}"` };
    }
    return { value: normalized };
  }

  return { value: raw };
}

function setPath(target: Record<string, unknown>, parts: string[], value: unknown): void {
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Writes one key into the project config, creating the file when needed.
 * Returns the value that is effective after normalization (clamping, defaults).
 */
export function setConfigValue(
  projectDir: string,
  key: string,
  raw: string,
): { ok: boolean; key: string; value?: unknown; error?: string } {
  const kind = SETTABLE_KEYS[key];
  if (!kind) {
    return { ok: false, key, error: `unknown key "${key}" — try ${Object.keys(SETTABLE_KEYS).join(', ')}` };
  }

  const parsed = parseValue(key, kind, raw);
  if (parsed.error) {
    return { ok: false, key, error: parsed.error };
  }

  const path = configPath(projectDir);
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsedFile = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      if (parsedFile && typeof parsedFile === 'object' && !Array.isArray(parsedFile)) {
        existing = parsedFile as Record<string, unknown>;
      }
    } catch {
      // Keep a broken file as-is instead of silently discarding the user's edits.
      return { ok: false, key, error: `${path} is not valid JSON; fix it first` };
    }
  }

  setPath(existing, key.split('.'), parsed.value);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, 'utf-8');

  const effective = loadConfig(projectDir).config;
  const parts = key.split('.');
  let current: unknown = effective;
  for (const part of parts) {
    current = current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined;
  }

  return { ok: true, key, value: current };
}

/** Flattens the effective config into dotted `key = value` lines for display. */
export function flattenConfig(config: AgentBusConfig): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const walk = (value: unknown, prefix: string): void => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, prefix ? `${prefix}.${key}` : key);
      }
      return;
    }
    if (value !== undefined) {
      rows.push([prefix, JSON.stringify(value)]);
    }
  };
  walk(config, '');
  return rows;
}
