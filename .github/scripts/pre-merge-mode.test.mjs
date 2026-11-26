/**
 * Tests for the pre-merge mode choice.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  affectedDirs,
  isDocsOnly,
  isVersionOnly,
  pickFollow,
  workspaceGraph
} from './pre-merge-mode.mjs';

const bump =
  '@@ -1,4 +1,4 @@\n {\n   "name": "x",\n-  "version": "1.0.0-beta.3",\n+  "version": "1.0.0-beta.4",\n   "type": "module"';

test('a release PR: version bumps plus CHANGELOG.md', () => {
  assert.equal(
    isVersionOnly([
      { filename: 'packages/a/package.json', patch: bump },
      { filename: 'CHANGELOG.md', patch: '+x' }
    ]),
    true
  );
});

test('a dependency change in package.json is not version-only', () => {
  const dep = `${bump}\n-    "foo": "1.0.0"\n+    "foo": "2.0.0"`;
  assert.equal(isVersionOnly([{ filename: 'packages/a/package.json', patch: dep }]), false);
});

test('any other file, a package.json with no patch, or no files is not version-only', () => {
  assert.equal(
    isVersionOnly([
      { filename: 'packages/a/package.json', patch: bump },
      { filename: 'src/x.ts', patch: '+y' }
    ]),
    false
  );
  assert.equal(isVersionOnly([{ filename: 'packages/a/package.json' }]), false);
  assert.equal(isVersionOnly([]), false);
});

test('a docs PR: the site source and assets, docs/, Markdown and the site workflow', () => {
  const docs = [
    'apps/site/src/pages/index.astro',
    'apps/site/src/content/examples/onboard.md',
    'apps/site/public/favicon.svg',
    'docs/walks.md',
    'README.md',
    'plugins/substrate-nl/README.md',
    '.github/workflows/site.yml'
  ];
  assert.equal(isDocsOnly(docs.map((filename) => ({ filename }))), true);
});

test('site examples, tests, config, any other file, or no files is not docs-only', () => {
  // The site's Postgres pass runs its examples and tests under its vitest config.
  for (const filename of [
    'apps/site/examples/reshape/steps.ts',
    'apps/site/examples/self-tending/output.json',
    'apps/site/test/built-output.test.ts',
    'apps/site/test/_global-setup.ts',
    'apps/site/vitest.config.ts',
    'apps/site/astro.config.mjs',
    'apps/site/package.json',
    'pnpm-lock.yaml',
    'packages/substrate-core/src/engine.ts',
    '.github/workflows/ci.yml'
  ]) {
    assert.equal(isDocsOnly([{ filename: 'README.md' }, { filename }]), false, filename);
  }
  assert.equal(isDocsOnly([]), false);
});

test('a rename counts as docs only when both its old and new paths are docs', () => {
  const moved = (previous_filename, filename) => [
    { filename, previous_filename, status: 'renamed' }
  ];
  assert.equal(
    isDocsOnly(moved('apps/site/examples/reshape/steps.ts', 'apps/site/src/x.ts')),
    false
  );
  assert.equal(isDocsOnly(moved('docs/old.md', 'docs/new.md')), true);
});

test('follows the newest other run that started the suites', () => {
  const runs = [
    { id: 1, created_at: '2026-11-17T10:00:00Z', suiteJobs: 5 },
    { id: 2, created_at: '2026-11-17T10:01:00Z', suiteJobs: 5 },
    { id: 3, created_at: '2026-11-17T10:02:00Z', suiteJobs: 0 },
    { id: 4, created_at: '2026-11-17T10:03:00Z', suiteJobs: 5 }
  ];
  assert.equal(pickFollow(runs, 4), 2);
  assert.equal(pickFollow(runs.slice(2, 3), 9), undefined);
});

const graph = {
  'packages/types': [],
  'packages/pg': ['packages/types'],
  'packages/client': ['packages/types'],
  'apps/server': ['packages/pg'],
  'plugins/nl': ['apps/server']
};
const changed = (...names) => names.map((filename) => ({ filename }));

test('a change reaches its package and everything that depends on it', () => {
  assert.deepEqual(affectedDirs(changed('packages/pg/src/a.ts'), graph), [
    'apps/server',
    'packages/pg',
    'plugins/nl'
  ]);
  assert.deepEqual(affectedDirs(changed('plugins/nl/src/a.ts'), graph), ['plugins/nl']);
  assert.equal(affectedDirs(changed('packages/types/src/a.ts'), graph).length, 5);
});

test('a file outside every package reaches all of them', () => {
  for (const f of ['pnpm-lock.yaml', '.github/workflows/ci.yml', 'turbo.json', 'packages/x.ts'])
    assert.equal(affectedDirs(changed('plugins/nl/src/a.ts', f), graph), null, f);
});

test('docs paths reach nothing, and a rename counts at both ends', () => {
  assert.deepEqual(affectedDirs(changed('README.md', 'plugins/nl/README.md'), graph), []);
  assert.deepEqual(
    affectedDirs(
      [{ filename: 'packages/client/src/a.ts', previous_filename: 'packages/pg/src/a.ts' }],
      graph
    ),
    ['apps/server', 'packages/client', 'packages/pg', 'plugins/nl']
  );
});

test('the real workspace: the storage package reaches the server and plugins, nl does not', () => {
  const real = workspaceGraph(new URL('../..', import.meta.url).pathname);
  const pg = affectedDirs(changed('packages/substrate-dataset-pg/src/a.ts'), real);
  for (const d of ['apps/substrate', 'plugins/substrate-recall', 'plugins/substrate-nl'])
    assert.ok(pg.includes(d), d);
  const nl = affectedDirs(changed('plugins/substrate-nl/src/a.ts'), real);
  assert.ok(nl.includes('plugins/substrate-nl'));
  for (const d of ['apps/substrate', 'packages/substrate-dataset-pg', 'plugins/substrate-recall'])
    assert.ok(!nl.includes(d), d);
});
