import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  configMtime,
  configPath,
  defaultConfig,
  flattenConfig,
  loadConfig,
  setConfigValue,
} from '../src/core/config.js';

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

test('setConfigValue writes one key and keeps everything else', () => {
  const projectDir = tempProject();
  writeConfig(projectDir, JSON.stringify({ team: 'a', orchestration: { maxWorkers: 2 } }));

  const result = setConfigValue(projectDir, 'orchestration.trackTasks', 'off');

  assert.equal(result.ok, true);
  assert.equal(result.value, false);

  const { config } = loadConfig(projectDir);
  assert.equal(config.team, 'a');
  assert.equal(config.orchestration.maxWorkers, 2);
  assert.equal(config.orchestration.trackTasks, false);
});

test('setConfigValue rejects unknown keys and bad enums, clamps numbers', () => {
  const projectDir = tempProject();

  assert.match(setConfigValue(projectDir, 'nope', '1').error ?? '', /unknown key/);
  assert.match(setConfigValue(projectDir, 'isolation.mode', 'quantum').error ?? '', /expects one of/);
  assert.equal(setConfigValue(projectDir, 'orchestration.maxWorkers', '99').value, 10);
});

test('setConfigValue refuses to overwrite a broken file', () => {
  const projectDir = tempProject();
  writeConfig(projectDir, '{ broken');

  const result = setConfigValue(projectDir, 'team', 'x');

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not valid JSON/);
});

test('flattenConfig renders dotted keys for display', () => {
  const rows = flattenConfig(defaultConfig('/tmp/demo'));
  const keys = rows.map(([key]) => key);

  assert.ok(keys.includes('team'));
  assert.ok(keys.includes('isolation.mode'));
  assert.ok(keys.includes('orchestration.trackTasks'));
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
