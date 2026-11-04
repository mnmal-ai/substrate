/**
 * Shared test-fixture coordinator — the canonical "some coordinator with some
 * types" the apps/substrate suite composes against. It is the scenario the
 * cross-server-parity acceptance gate runs byte-identically on both
 * MemorySubstrateServer and FastifySubstrateServer, so it deliberately stays a single
 * shared fixture rather than per-test inline coordinators.
 *
 * Test-only, not part of the published substrate-compose API. It stays on the
 * `'default'` namespace: the base substrate dataset is also `'default'`, and
 * the auth / edge / drop-namespace scenarios are keyed to that string.
 *
 * Types contributed:
 *   - `Todo`         — autoCRUD (non-embeddable)
 *   - `Tag`          — autoCRUD with crossRef to Todo (onDelete: 'set_null')
 *   - `Memo`         — autoCRUD, no `embed.source`: the recall scenarios seed
 *                      its rows and upsert vectors by hand
 *   - `Target`       — autoCRUD, no crossRefs of its own — the referent for
 *                      `Owner.ref` below
 *   - `Owner`        — autoCRUD with crossRef to Target via
 *                      `field.crossRef(..., { onMissing: 'reject' })` — the
 *                      cross-server-parity onMissing:'reject' scenario
 *                      exercises create/update enforcement through this pair
 *   - `streamTodos`  — §5.5 generator resolver (1ms delay between chunks)
 */

import { field, installAutoCrud } from '@mnmal-ai/substrate-sdk';
import type { CoordinatorPlugin, NamespaceInstallContext, Row } from '@mnmal-ai/substrate-types';

export const FIXTURE_NAMESPACE = 'default';

async function installFixtureNamespace(ctx: NamespaceInstallContext): Promise<void> {
  const { registry, dataset, edges } = ctx;

  const todoFields = {
    id: { kind: 'scalar', type: 'string', indexed: true },
    title: { kind: 'scalar', type: 'string', indexed: true },
    done: { kind: 'scalar', type: 'boolean', indexed: true, default: false },
    // No body-level `createdAt`: the row-metadata column shadows that name in
    // orderBy/where resolution, so a body field of the same name is a footgun
    // (writes go to body, reads route to metadata). Use _metadata.createdAt or
    // pick a different name (e.g. `dueAt`) for body-level dates.
    // Deliberately unindexed so integration tests can show an unindexed
    // filter is accepted, with or without the ignored _allowTableScan.
    priority: { kind: 'scalar', type: 'number', default: 0 },
    // Engine-allocated sequence number per (ns, type). Indexed so
    // cross-server parity tests filter by shortId.eq through an index.
    shortId: { kind: 'scalar', type: 'number', indexed: true, readonly: true },
    // Body-promoted to native columns on pg-dataset. Body remains the
    // source of truth on memory-dataset; the read-path on pg routes filters
    // and orderBy on these fields to dedicated indexed columns.
    archived: { kind: 'scalar', type: 'boolean', indexed: true, default: false },
    // `nullable: true` so the cold-start hot-path filter shape
    // `where { project: { in: ['substrate', null] } }` passes the engine validator.
    // Without it, `null` elements inside `in`/`nin` arrays are rejected.
    project: { kind: 'scalar', type: 'string', indexed: true, nullable: true },
    // Controlled vocabulary for the cross-server-parity enum-rejection gate.
    // nullable so scenarios that omit it keep passing.
    status: { kind: 'scalar', type: 'string', enum: ['open', 'done'], nullable: true }
  } as const;

  installAutoCrud(registry, 'Todo', dataset, edges, { fields: todoFields });

  installAutoCrud(registry, 'Tag', dataset, edges, {
    fields: {
      id: { kind: 'scalar', type: 'string', indexed: true },
      label: { kind: 'scalar', type: 'string', indexed: true },
      todoId: {
        kind: 'crossRef',
        ns: FIXTURE_NAMESPACE,
        type: 'Todo',
        onDelete: 'set_null'
      }
    }
  });

  // The recall-seed target. The cross-server-parity recall scenarios write a
  // Memo row (for the knnSearch datasetFor body-substratetion join) and MANUALLY
  // upsert the vector into the store, so this type only needs to be writable —
  // no `embed.source` auto-embed is exercised here (that path is covered by the
  // cross-plugin recall tests via _fixtures/embeddable-coordinator). Body is
  // unindexed (long-form prose).
  installAutoCrud(registry, 'Memo', dataset, edges, {
    fields: {
      id: { kind: 'scalar', type: 'string', indexed: true },
      name: { kind: 'scalar', type: 'string', indexed: true },
      description: { kind: 'scalar', type: 'string', indexed: true },
      body: { kind: 'scalar', type: 'string', indexed: false },
      archived: { kind: 'scalar', type: 'boolean', indexed: true, default: false },
      project: { kind: 'scalar', type: 'string', indexed: true, nullable: true }
    }
  });

  // onMissing:'reject' parity gate. `Target` is the
  // referent; `Owner.ref` uses the `field.crossRef` builder (not a
  // hand-written literal) so `onMissing` is actually set on the FieldDef.
  installAutoCrud(registry, 'Target', dataset, edges, {
    fields: {
      id: { kind: 'scalar', type: 'string', indexed: true }
    }
  });

  installAutoCrud(registry, 'Owner', dataset, edges, {
    fields: {
      id: { kind: 'scalar', type: 'string', indexed: true },
      ref: field.crossRef(FIXTURE_NAMESPACE, 'Target', { onMissing: 'reject' })
    }
  });

  registry.register('streamTodos', {
    kind: 'type',
    fields: todoFields,
    resolver: async function* (_ctx, args) {
      const { signal } = args;
      const source = args.dataset ?? dataset;
      const result = await source.read('Todo', {});
      for (const row of result.rows as Array<Row>) {
        if (signal?.aborted) return;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1);
          timer.unref?.();
          if (signal !== undefined) {
            const onAbort = (): void => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
        });
        yield row;
      }
    }
  });
}

export const fixturePlugin: CoordinatorPlugin = {
  name: 'fixtures',
  contractVersion: '*',
  namespaces: [
    {
      namespace: FIXTURE_NAMESPACE,
      install: installFixtureNamespace
    }
  ]
};
