/**
 * Tests for the label-catalog drift guard: members without labels fail,
 * extra labels do not.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverWorkspaceMembers, findMissingAreaLabels } from './check-label-drift.mjs';

test('reports members with no matching label', () => {
  assert.deepEqual(
    findMissingAreaLabels({
      workspaceMembers: ['core', 'compose'],
      labelNames: ['core', 'feat', 'P2-medium', 'repo']
    }),
    ['compose']
  );
});

test('extra labels (non-package areas) are not drift', () => {
  assert.deepEqual(
    findMissingAreaLabels({
      workspaceMembers: ['core'],
      labelNames: ['core', 'repo', 'docs-site']
    }),
    []
  );
});

test('discovers named members of packages/, apps/ and plugins/, without the scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'label-drift-'));
  const write = (dir, pkg) => {
    mkdirSync(join(root, dir), { recursive: true });
    if (pkg) writeFileSync(join(root, dir, 'package.json'), JSON.stringify(pkg));
  };
  write('packages/one', { name: '@mnmal-ai/one' });
  write('apps/two', { name: 'two' });
  write('plugins/no-manifest');
  write('docs/ignored', { name: '@mnmal-ai/ignored' });
  try {
    assert.deepEqual(discoverWorkspaceMembers(root), ['one', 'two']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discovers Cargo crates and the root and npm/ members, but not the root package.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'label-drift-'));
  const put = (file, text) => {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  put(
    'Cargo.toml',
    '[workspace]\nmembers = ["crates/two"]\n\n[package]\nname = "one"\nversion = "0.1.0"\n'
  );
  put('crates/two/Cargo.toml', '[package]\nname = "two"\n\n[[bin]]\nname = "two-cli"\n');
  put('npm/package.json', JSON.stringify({ name: '@mnmal-ai/two' }));
  put('package.json', JSON.stringify({ name: '@mnmal-ai/repo-workspace' }));
  try {
    assert.deepEqual(discoverWorkspaceMembers(root), ['one', 'two']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
