/**
 * serve/stores.ts — recall/cluster store construction.
 *
 * The binary owns the pg pool and constructs the EmbeddingsStore, handing it
 * to recall via kernelHostDeps. Same pg-vs-memory split for all three
 * stores; memory variants close over the late-bound dataset registry so
 * content joins resolve after `compose()` populates it.
 */

import {
  InMemoryClusterStore,
  InMemoryEmbeddingsStore,
  InMemoryLexicalStore,
  PgClusterStore,
  PgEmbeddingsStore,
  PgLexicalStore
} from '@mnmal-ai/substrate-recall';
import type { Dataset } from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';
import { createRowsMissingProbe } from '../rows-missing-probe.js';

export interface RecallStores {
  recallStore: PgEmbeddingsStore | InMemoryEmbeddingsStore;
  lexicalStore: PgLexicalStore | InMemoryLexicalStore;
  clusterStore: PgClusterStore | InMemoryClusterStore;
  rowsMissing: ReturnType<typeof createRowsMissingProbe>;
}

export function buildRecallStores(
  storeSql: Sql | null,
  datasetRegistryRef: { current: { get: (ns: string) => Dataset | undefined } | null },
  resolveDataset: (namespace: string) => Dataset | null
): RecallStores {
  // The memory-mode store needs `datasetFor` to join row bodies at knnSearch /
  // fetchEmbeddings time — without it, results carry `row: { id }` stubs and
  // memory-mode /substrate/v1/recall returns content-less hits (pg gets the same join
  // via SQL). The store only calls it at search time, after compose() has
  // populated the ref.
  const recallStore =
    storeSql !== null
      ? new PgEmbeddingsStore({ sql: storeSql })
      : new InMemoryEmbeddingsStore({
          datasetFor: (ns) => datasetRegistryRef.current?.get(ns)
        });

  // Lexical arm store, same pg-vs-memory split as recallStore. Constructed
  // UNCONDITIONALLY: the gate is per-type (`lexical.source`), and a config
  // flag on top would be a second switch for the same decision.
  const lexicalStore =
    storeSql !== null
      ? new PgLexicalStore(storeSql)
      : new InMemoryLexicalStore({
          datasetFor: (ns) => datasetRegistryRef.current?.get(ns)
        });

  // Cluster persistence for crystallisation, the same pg-vs-memory
  // split as recallStore. `rowsMissing` backs the membership decay sweep and
  // reuses the same late-bound `resolveDataset` closure recall's
  // EmbedSourceContext already relies on — see rows-missing-probe.ts for why
  // it reports absent rows rather than surviving ones.
  const clusterStore =
    storeSql !== null ? new PgClusterStore({ sql: storeSql }) : new InMemoryClusterStore();

  const rowsMissing = createRowsMissingProbe({ resolveDataset });
  return { recallStore, lexicalStore, clusterStore, rowsMissing };
}
