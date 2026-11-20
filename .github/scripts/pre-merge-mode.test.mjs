/**
 * Tests for the pre-merge mode choice.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDocsOnly, isVersionOnly, pickFollow } from './pre-merge-mode.mjs';

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

test('a docs PR: the site outside its examples, docs/, Markdown and the site workflow', () => {
  const docs = [
    'apps/site/src/pages/index.astro',
    'apps/site/src/content/examples/onboard.md',
    'apps/site/public/favicon.svg',
    'apps/site/test/built-output.test.ts',
    'docs/walks.md',
    'README.md',
    'plugins/substrate-nl/README.md',
    '.github/workflows/site.yml'
  ];
  assert.equal(isDocsOnly(docs.map((filename) => ({ filename }))), true);
});

test('a site example, the site manifest, any other file, or no files is not docs-only', () => {
  // The site's examples run on Postgres in the pre-merge passes.
  for (const filename of [
    'apps/site/examples/reshape/steps.ts',
    'apps/site/examples/self-tending/output.json',
    'apps/site/package.json',
    'pnpm-lock.yaml',
    'packages/substrate-core/src/engine.ts',
    '.github/workflows/ci.yml'
  ]) {
    assert.equal(isDocsOnly([{ filename: 'README.md' }, { filename }]), false, filename);
  }
  assert.equal(isDocsOnly([]), false);
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
