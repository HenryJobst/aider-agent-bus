/**
 * Project configuration for the agent-bus extension.
 *
 * Lives in `<project>/.aider-desk/agent-bus.json` and is deliberately validated
 * by hand: a malformed config must never prevent AiderDesk from loading.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export function writeDefaultConfig(projectDir: string, config: AgentBusConfig): string {
  const path = configPath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return path;
}
