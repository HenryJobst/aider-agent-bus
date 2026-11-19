/**
 * Drift checks: project metadata, required profile fields, and parity between
 * the English and German READMEs.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import type { ExtensionContext } from '@aiderdesk/extensions';

import AgentBusExtension from '../index.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
  version: string;
};
const metadata = (AgentBusExtension as unknown as { metadata: { version: string } }).metadata;

function globalContext(): ExtensionContext {
  return {
    getProjectDir: () => '',
    getProjectContext: () => {
      throw new Error('no project');
    },
    getTaskContext: () => null,
    log: () => undefined,
  } as unknown as ExtensionContext;
}

test('extension metadata version matches package.json', () => {
  assert.equal(metadata.version, packageJson.version);
});

test('every registered profile carries the full AgentProfile shape', () => {
  const profiles = new AgentBusExtension().getAgents(globalContext());
  assert.equal(profiles.length, 4);

  for (const profile of profiles) {
    assert.ok(profile.id.startsWith('agent-bus-'), profile.id);
    assert.ok(profile.name.length > 0, profile.id);
    assert.ok(Number.isInteger(profile.maxIterations), profile.id);
    assert.ok(Number.isFinite(profile.minTimeBetweenToolCalls), profile.id);
    assert.ok(Array.isArray(profile.enabledServers), profile.id);
    assert.equal(typeof profile.toolApprovals, 'object', profile.id);
    assert.equal(typeof profile.toolSettings, 'object', profile.id);
    assert.equal(typeof profile.disabledExtensionTools, 'object', profile.id);
    assert.equal(typeof profile.customInstructions, 'string', profile.id);
    assert.equal(typeof profile.includeContextFiles, 'boolean', profile.id);
    assert.equal(typeof profile.includeRepoMap, 'boolean', profile.id);
    assert.equal(typeof profile.usePowerTools, 'boolean', profile.id);
    assert.equal(typeof profile.useExtensionTools, 'boolean', profile.id);
    assert.ok(profile.subagent && typeof profile.subagent === 'object', profile.id);
  }
});

function commandsFrom(readme: string): string[] {
  const matches = readme.match(/\/agent-bus-[a-z-]+/g) ?? [];
  return [...new Set(matches.map((command) => command.replace(/^\//, '')))].sort();
}

// The READMEs live in the repository root. In an isolated copy (Stryker
// sandbox, standalone extension checkout) they are absent and this drift check
// has nothing to compare.
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const hasRepoDocs = existsSync(join(repoRoot, 'README.md')) && existsSync(join(repoRoot, 'README.de.md'));

test.skipIf(!hasRepoDocs)('English and German README document the same commands', () => {
  const english = readFileSync(join(repoRoot, 'README.md'), 'utf-8');
  const german = readFileSync(join(repoRoot, 'README.de.md'), 'utf-8');

  const englishCommands = commandsFrom(english);
  const germanCommands = commandsFrom(german);

  assert.ok(englishCommands.length >= 10, 'README should document the full command set');
  assert.deepEqual(germanCommands, englishCommands);
});
