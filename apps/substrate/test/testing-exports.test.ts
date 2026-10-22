/**
 * An outside plugin composes its pg-gated suites from `@mnmal-ai/substrate/testing`
 * alone, so the pg dataset and its migration runners must be reachable there
 * beside the in-memory doubles and the test-database guards.
 */
import { describe, expect, it } from 'vitest';
import * as testing from '../src/exports/testing.js';

describe('@mnmal-ai/substrate/testing', () => {
  it.each([
    'compose',
    'MemoryDataset',
    'MemoryEdgesStore',
    'PgDataset',
    'PgEdgesStore',
    'runMigrations',
    'runDerivedMigrations',
    'deriveListIndexMigration',
    'assertTestDatabase',
    'assertNotSuperuser',
    'assertCannotWriteOutsideTestDatabases'
  ])('exports %s', (name) => {
    expect(typeof (testing as Record<string, unknown>)[name]).toBe('function');
  });
});
