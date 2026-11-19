import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { configMtime, configPath, defaultConfig, loadConfig } from '../src/core/config.js';

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'agent-bus-config-'));
}

function writeConfig(projectDir: string, content: string): void {
  const path = configPath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

test('missing config falls back to defaults derived from the project folder', () => {
  const projectDir = join(tempProject(), 'webshop');
  const { config, exists, error } = loadConfig(projectDir);

  assert.equal(exists, false);
  assert.equal(error, undefined);
  assert.equal(config.agentBus.project, 'webshop');
  assert.equal(config.team, 'webshop-team');
  assert.equal(config.isolation.mode, 'worktree');
  assert.equal(config.orchestration.maxWorkers, 5);
});

test('partial config merges with defaults instead of replacing them', () => {
  const projectDir = tempProject();
  writeConfig(projectDir, JSON.stringify({ team: 'custom-team', isolation: { mode: 'shared' } }));

  const { config, exists } = loadConfig(projectDir);

  assert.equal(exists, true);
  assert.equal(config.team, 'custom-team');
  assert.equal(config.isolation.mode, 'shared');
  assert.equal(config.isolation.mergeStrategy, 'manual');
  assert.equal(config.orchestration.pollIntervalMs, 20_000);
  assert.equal(config.mcpServerName, 'agent-bus');
});

test('invalid JSON never breaks loading and reports the error', () => {
  const projectDir = tempProject();
  writeConfig(projectDir, '{ not json');

  const { config, exists, error } = loadConfig(projectDir);

  assert.equal(exists, true);
  assert.match(error ?? '', /Cannot parse/);
  assert.equal(config.isolation.mode, 'worktree');
});

test('out-of-range and unknown values are normalized', () => {
  const projectDir = tempProject();
  writeConfig(
    projectDir,
    JSON.stringify({
      team: '',
      isolation: { mode: 'quantum' },
      orchestration: { maxWorkers: 99, pollIntervalMs: 10, wakeCooldownMs: -5, maxWakesPerTask: 5000 },
      agentBus: { project: '', binary: '' },
    }),
  );

  const { config } = loadConfig(projectDir);

  assert.equal(config.team, 'default-team');
  assert.equal(config.isolation.mode, 'worktree');
  assert.equal(config.orchestration.maxWorkers, 10);
  assert.equal(config.orchestration.pollIntervalMs, 5_000);
  assert.equal(config.orchestration.wakeCooldownMs, 0);
  assert.equal(config.orchestration.maxWakesPerTask, 1000);
  assert.equal(config.agentBus.project, 'project');
  assert.equal(config.agentBus.binary, 'agent-bus');
});

test('configMtime is undefined without a file and a number with one', () => {
  const projectDir = tempProject();

  assert.equal(configMtime(projectDir), undefined);

  writeConfig(projectDir, '{}');

  assert.equal(typeof configMtime(projectDir), 'number');
});

test('defaultConfig keeps worktree isolation as the recommendation', () => {
  const config = defaultConfig('/tmp/some-project');
  assert.equal(config.isolation.mode, 'worktree');
  assert.equal(config.orchestration.requireReview, true);
  assert.equal(config.orchestration.peerToPeerEnabled, true);
});
