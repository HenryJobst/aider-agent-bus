#!/usr/bin/env node
/**
 * Refresh the tests/coverage badges at the top of the repository READMEs.
 *
 * Runs the Vitest suite with V8 coverage, reads the totals and rewrites the
 * block between `<!-- badges:start -->` and `<!-- badges:end -->`. Only works
 * in the repository checkout: the published extension copy has no READMEs to
 * update.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(extensionDir, '../../..');
const reportDir = join(extensionDir, 'coverage', '.badges');
const startMarker = '<!-- badges:start -->';
const endMarker = '<!-- badges:end -->';

const readmes = [
  { path: join(repoRoot, 'README.md'), development: '#development' },
  { path: join(repoRoot, 'README.de.md'), development: '#entwicklung' },
];

const packageJson = JSON.parse(readFileSync(join(extensionDir, 'package.json'), 'utf-8'));
const repositoryUrl = (packageJson.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');

const vitestBin = join(extensionDir, 'node_modules', 'vitest', 'vitest.mjs');
if (!existsSync(vitestBin)) {
  throw new Error(`Vitest is not installed at ${vitestBin} — run "npm install" in the extension first.`);
}
for (const { path } of readmes) {
  if (!existsSync(path)) {
    throw new Error(`${path} is missing — badges can only be refreshed in the repository checkout.`);
  }
}

rmSync(reportDir, { recursive: true, force: true });
mkdirSync(reportDir, { recursive: true });
const testReportDir = mkdtempSync(join(tmpdir(), 'agent-bus-badges-'));
const testReport = join(testReportDir, 'tests.json');

try {
  execFileSync(
    process.execPath,
    [
      vitestBin,
      'run',
      '--coverage',
      '--coverage.reporter=json-summary',
      `--coverage.reportsDirectory=${reportDir}`,
      '--reporter=json',
      `--outputFile=${testReport}`,
    ],
    { cwd: extensionDir, stdio: 'inherit' },
  );

  const summary = JSON.parse(readFileSync(join(reportDir, 'coverage-summary.json'), 'utf-8')).total;
  const tests = JSON.parse(readFileSync(testReport, 'utf-8')).numTotalTests;
  const statements = Number(summary.statements.pct);
  const branches = Number(summary.branches.pct);

  const block = renderBadges(tests, statements, branches);
  for (const readme of readmes) {
    replaceBlock(readme, block);
  }
  console.log(`badges updated: ${tests} tests, ${percent(statements)} statements, ${percent(branches)} branches`);
} finally {
  rmSync(testReportDir, { recursive: true, force: true });
}

function percent(value) {
  return `${value.toFixed(1)}%`;
}

function coverageColour(value) {
  if (value >= 90) return 'brightgreen';
  if (value >= 80) return 'green';
  if (value >= 70) return 'yellowgreen';
  return 'yellow';
}

function badge(label, message, colour, link) {
  // Shields.io escapes literal dashes as `--` and underscores as `__`.
  const escape = (text) => encodeURIComponent(text).replaceAll('-', '--').replaceAll('_', '__');
  return `[![${label}](https://img.shields.io/badge/${escape(label)}-${escape(message)}-${colour})](${link})`;
}

function renderBadges(tests, statements, branches) {
  return [
    startMarker,
    ...(repositoryUrl
      ? [`[![CI](${repositoryUrl}/actions/workflows/ci.yml/badge.svg)](${repositoryUrl}/actions/workflows/ci.yml)`]
      : []),
    badge('tests', String(tests), 'brightgreen', '#development'),
    badge(
      'coverage',
      `${percent(statements)} stmts / ${percent(branches)} branches`,
      coverageColour(statements),
      '#development',
    ),
    badge('license', 'MIT', 'blue', 'LICENSE'),
    badge('TypeScript', '5.9', '3178c6', 'https://www.typescriptlang.org'),
    badge('AiderDesk', 'extension', '6366f1', '.aider-desk/extensions/aiderdesk-agent-bus/README.md'),
    endMarker,
  ].join('\n');
}

function replaceBlock({ path, development }, block) {
  const content = readFileSync(path, 'utf-8');
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`${path} has no ${startMarker} … ${endMarker} block to replace.`);
  }

  // The development anchor differs per language; keep the badge links local.
  const localized = block.replaceAll('](#development)', `](${development})`);
  const next = `${content.slice(0, start)}${localized}${content.slice(end + endMarker.length)}`;
  if (next !== content) {
    writeFileSync(path, next, 'utf-8');
  }
}
