/**
 * Tests for the label-catalog drift guard: members without labels fail,
 * extra labels do not.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverWorkspaceMembers, findMissingAreaLabels } from './check-label-drift.mjs';

test('reports members with no matching label', () => {
  assert.deepEqual(
    findMissingAreaLabels({
      workspaceMembers: ['substrate-core', 'substrate-compose'],
      labelNames: ['substrate-core', 'feat', 'P2-medium', 'repo']
    }),
    ['substrate-compose']
  );
});

test('extra labels (non-package areas) are not drift', () => {
  assert.deepEqual(
    findMissingAreaLabels({
      workspaceMembers: ['substrate-core'],
      labelNames: ['substrate-core', 'repo', 'docs-site']
    }),
    []
  );
});

test('discovers this repo’s own workspace members', () => {
  const root = new URL('../..', import.meta.url).pathname;
  const members = discoverWorkspaceMembers(root);
  assert.ok(members.length > 20, `expected 20+ members, got ${members.length}`);
  assert.ok(members.includes('substrate-core'));
  assert.ok(members.includes('substrate-compose'));
  assert.ok(members.includes('substrate-proposals'));
});
