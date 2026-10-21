/**
 * Tests for the PR-hygiene validator that backs the `PR hygiene` CI gate.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePrHygiene } from './check-pr-labels.mjs';

test('passes with one area, one type, one priority, and an assignee', () => {
  const result = evaluatePrHygiene({
    labels: ['core', 'feat', 'P2-medium'],
    assignees: ['octocat']
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('an optional status label does not count as an area and does not break a valid PR', () => {
  const result = evaluatePrHygiene({
    labels: ['server', 'refactor', 'P1-high', 'needs-review'],
    assignees: ['octocat']
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.areas, ['server']);
});

test('fails when no area label is present (type+priority+status are not areas)', () => {
  const result = evaluatePrHygiene({
    labels: ['feat', 'P2-medium', 'needs-review'],
    assignees: ['octocat']
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((e) => e.includes('Area')),
    true
  );
});

test('fails when the type label is missing', () => {
  const result = evaluatePrHygiene({
    labels: ['core', 'P2-medium'],
    assignees: ['octocat']
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((e) => e.includes('Type')),
    true
  );
});

test('fails when more than one type label is present', () => {
  const result = evaluatePrHygiene({
    labels: ['core', 'feat', 'refactor', 'P2-medium'],
    assignees: ['octocat']
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((e) => e.includes('Type')),
    true
  );
});

test('fails when the priority label is missing', () => {
  const result = evaluatePrHygiene({
    labels: ['core', 'feat'],
    assignees: ['octocat']
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((e) => e.includes('Priority')),
    true
  );
});

test('fails when there is no assignee', () => {
  const result = evaluatePrHygiene({
    labels: ['core', 'feat', 'P2-medium'],
    assignees: []
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((e) => e.includes('assignee')),
    true
  );
});

test('accumulates every distinct failure rather than stopping at the first', () => {
  const result = evaluatePrHygiene({ labels: [], assignees: [] });
  assert.equal(result.ok, false);
  // missing area, missing type, missing priority, missing assignee
  assert.equal(result.errors.length, 4);
});
