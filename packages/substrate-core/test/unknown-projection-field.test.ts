/**
 * An undeclared key in a projection is REPORTED, not rejected.
 *
 * Without the report, `fields: { typoField: true }` returns every row with
 * `typoField: null`, indistinguishable from a declared field that is null on
 * every row, so a typo reads as data absence rather than a broken read.
 *
 * Reported rather than rejected so a rolling deploy stays survivable: a
 * freshly-built consumer may legitimately project a field that a
 * not-yet-restarted substrate does not know yet.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { EdgesStore, FieldDef, RequestContext, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  Engine,
  MemoryEdgesStore,
  type NamespaceConfig,
  Registry,
  type Resolver
} from '../src/index.js';

const str: FieldDef = { kind: 'scalar', type: 'string' };

function makeCtx(): Partial<RequestContext> {
  return { identity: null, now: new Date('2026-08-08T00:00:00Z'), headers: {}, meta: {} };
}

/**
 * Registers WITH `fields`, deliberately. The diagnostic no-ops when the engine
 * has no type schema to compare against, so a registration lacking `fields`
 * would make every assertion below pass without exercising anything.
 */
function engineWith(rows: Row[]): Engine {
  const registry = new Registry();
  const resolver: Resolver = async () => rows;
  registry.register('Thing', {
    resolver,
    fields: { id: str, title: str, note: str }
  });
  const namespaces = new Map<string, NamespaceConfig>([['default', { registry }]]);
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', new MemoryDataset({ namespace: 'default' }));
  const edges: EdgesStore = new MemoryEdgesStore({ now: () => new Date() });
  return new Engine({ namespaces, datasets, edges });
}

const project = async (
  fields: Record<string, unknown>
): Promise<{ unknown: string[] | undefined; rows: number; errors: unknown }> => {
  const engine = engineWith([{ id: 'r1', title: 'a', note: null }]);
  const env = await engine.query({
    frame: { 'default/Thing': { params: {}, fields } },
    ctx: makeCtx()
  });
  return {
    unknown: env._diagnostics?.['default/Thing']?.unknownProjectionFields,
    rows: (env.data['default/Thing'] as unknown[] | undefined)?.length ?? 0,
    errors: env.errors
  };
};

describe('unknown projection fields are reported, not rejected', () => {
  it('says nothing when every projected key is declared', async () => {
    const { unknown, rows } = await project({ id: true, title: true });
    expect(unknown).toBeUndefined();
    expect(rows).toBe(1);
  });

  it('reports an undeclared key AND still returns the rows', async () => {
    const { unknown, rows } = await project({ id: true, nonesuch: true });
    expect(unknown).toEqual(['nonesuch']);
    // Non-fatal is the design, not an oversight: the read succeeds so a
    // rolling-deploy window stays survivable rather than becoming an outage.
    expect(rows).toBe(1);
  });

  /**
   * Naming every offender matters. "One or more fields were unknown" sends the
   * reader back to diff a long projection by hand.
   */
  it('names every unknown key, not just the first', async () => {
    const { unknown } = await project({ nope: true, alsoNope: true, title: true });
    expect(unknown).toEqual(['nope', 'alsoNope']);
  });

  it('does not fire on `_metadata`, projectable without being declared', async () => {
    const { unknown } = await project({ id: true, _metadata: { createdAt: true } });
    expect(unknown).toBeUndefined();
  });

  /**
   * The case the diagnostic exists to separate. A declared field that is null
   * on every row and an undeclared key return the SAME rows — which is what
   * makes the defect invisible without this — so it must not itself be flagged.
   */
  it('does not fire on a declared field that is null on every row', async () => {
    const { unknown } = await project({ id: true, note: true });
    expect(unknown).toBeUndefined();
  });

  it('leaves `errors` alone — a successful read must not look failed', async () => {
    const { unknown, errors } = await project({ id: true, nonesuch: true });
    // A consumer doing `if (env.errors) throw` must not start throwing on reads
    // that succeeded; that would make the diagnostic worse than the defect.
    expect(errors).toBeUndefined();
    expect(unknown).toEqual(['nonesuch']);
  });
});
