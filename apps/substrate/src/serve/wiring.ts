/**
 * serve/wiring.ts — substrate + bridge + dataset wiring.
 *
 * Everything `runServe()` needs between `parseEnv()` and `compose()`:
 * store construction, bridge registry, per-namespace datasets, migration
 * tracking, and the two substrate-composition singletons (filter-operator
 * registry, pending MCP tools).
 */

import {
  DEFAULT_NAMESPACE,
  kernelMigrationTracking,
  SYSTEM_NAMESPACE
} from '@mnmal-ai/substrate-compose';
import {
  type Engine,
  HttpBridgeClient,
  type MemoryBridgeCredentialStore,
  MemoryBridgeRegistry,
  MemoryEdgesStore
} from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import {
  type FieldDefLookup,
  type IndexedListField,
  PgDataset,
  PgEdgesStore,
  runMigrations,
  type TypeDefLookup
} from '@mnmal-ai/substrate-dataset-pg';
import { getExtensionOperator, registerExtensionOperator } from '@mnmal-ai/substrate-filter';
import { makeAuthorizationProvider } from '@mnmal-ai/substrate-policy';
import { RESERVED_AUTOCRUD_FIELDS } from '@mnmal-ai/substrate-sdk';
import type {
  CoordinatorPlugin,
  Dataset,
  EdgesStore,
  FilterOperatorDef,
  McpToolRegistration,
  NamespaceDefinition,
  Registry as RegistryInterface
} from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';
import { openSql } from '../pg-client.js';
import { type BridgeSpec, EnvConfigError } from './config.js';

// Filter-operator registry. Substrate-plugin filterOperators are registered
// into the shared @mnmal-ai/substrate-filter registry that substrate-core's validator
// and substrate-dataset-pg's pre-resolver both consult. Throws on a duplicate name.
export const filterRegistry = {
  register(name: string, op: FilterOperatorDef): void {
    if (getExtensionOperator(name) !== undefined) {
      throw new EnvConfigError(`Filter operator '${name}' already registered`);
    }
    registerExtensionOperator(name, op);
  }
};

// Substrate-plugin `registerMcpTool` registrations, recorded but not exposed:
// `substrate serve` has no MCP transport by design (the stdio server is the
// separate `substrate mcp`), so there is deliberately no "never exposed" warning.
export const pendingMcpTools: McpToolRegistration[] = [];

export interface StoreWiring {
  dataset: Dataset;
  edges: EdgesStore;
  /**
   * When pg-backed, the `_system` namespace dataset, so `Key` /
   * `Invite` rows survive restarts (§5.12). `null` on memory storeSpec —
   * compose() allocates a MemoryDataset and keys are ephemeral.
   */
  substrateNamespaceDataset: Dataset | null;
  /**
   * §5.13: the underlying `postgres` Sql handle when pg-backed. Threaded out
   * here (rather than re-opened downstream) so the idempotency store shares
   * the same pool as the rest of the pg wiring. `null` on memory storeSpec.
   */
  sql: Sql | null;
  /** Non-null when the store holds resources that must be released on shutdown. */
  close: (() => Promise<void>) | null;
}

export async function wireStore(
  storeSpec: string,
  fieldDefLookupFor: (namespace: string) => FieldDefLookup,
  typeDefLookupFor?: (namespace: string) => TypeDefLookup
): Promise<StoreWiring> {
  if (storeSpec === 'memory') {
    return {
      dataset: new MemoryDataset({
        namespace: DEFAULT_NAMESPACE,
        fieldDefLookup: fieldDefLookupFor(DEFAULT_NAMESPACE)
      }),
      edges: new MemoryEdgesStore({ now: () => new Date() }),
      substrateNamespaceDataset: null,
      sql: null,
      close: null
    };
  }
  if (storeSpec.startsWith('postgres://') || storeSpec.startsWith('postgresql://')) {
    const sql: Sql = openSql(storeSpec);
    await runMigrations(sql);
    // Edges store linked in via `edgesStore` so the dataset's
    // `withScopedTransaction` can enlist edge mutations into the same pg
    // transaction.
    const edges = new PgEdgesStore({ sql });
    return {
      dataset: new PgDataset({
        namespace: DEFAULT_NAMESPACE,
        sql,
        edgesStore: edges,
        fieldDefLookup: fieldDefLookupFor(DEFAULT_NAMESPACE),
        ...(typeDefLookupFor ? { typeDefLookup: typeDefLookupFor(DEFAULT_NAMESPACE) } : {})
      }),
      edges,
      substrateNamespaceDataset: new PgDataset({
        namespace: SYSTEM_NAMESPACE,
        sql,
        edgesStore: edges,
        fieldDefLookup: fieldDefLookupFor(SYSTEM_NAMESPACE),
        ...(typeDefLookupFor ? { typeDefLookup: typeDefLookupFor(SYSTEM_NAMESPACE) } : {})
      }),
      sql,
      close: (): Promise<void> => sql.end()
    };
  }
  throw new EnvConfigError(
    `SUBSTRATE_DATABASE_URL: invalid value '${storeSpec}' — expected 'memory' or a postgres:// URL`
  );
}

/**
 * Builds a bridge registry from `specs`, returning it with a `dispose` that
 * releases every client. Throws if a spec has no credential, a malformed
 * url, or a url whose origin differs from its credential's.
 */
export function buildBridgeRegistry(
  specs: Array<BridgeSpec>,
  creds: MemoryBridgeCredentialStore
): { registry: MemoryBridgeRegistry; dispose: () => void } {
  const registry = new MemoryBridgeRegistry();
  const clients: Array<HttpBridgeClient> = [];
  for (const spec of specs) {
    const cred = creds.get(spec.name);
    if (cred === undefined) {
      // parseEnv is the boot-time gate; this keeps the invariant true for
      // direct callers (tests, embedders) that bypass env parsing.
      throw new Error(`bridge '${spec.name}' has no credential`);
    }
    // …and the same for the ORIGIN half: a credential must not be presented to
    // a host it was never provisioned for.
    let specOrigin: string;
    try {
      specOrigin = new URL(spec.url).origin;
    } catch {
      throw new Error(`bridge '${spec.name}' has a malformed url '${spec.url}'`);
    }
    if (specOrigin !== cred.origin) {
      throw new Error(
        `bridge '${spec.name}' url origin '${specOrigin}' does not match its credential origin '${cred.origin}'`
      );
    }
    // Throws here on a SET-but-unreadable keyPath rather than inside the bridge
    // client's try-block, where a LOCAL misconfiguration would be reported as a
    // REMOTE outage (`BridgeUnreachableError`).
    const auth = makeAuthorizationProvider(cred, { audience: cred.origin });
    const client = new HttpBridgeClient({
      name: spec.name,
      baseUrl: spec.url,
      auth
    });
    clients.push(client);
    registry.register(spec.ns, client);
  }
  return {
    registry,
    dispose: (): void => {
      for (const c of clients) c.dispose();
    }
  };
}

/**
 * Build a per-namespace {@link FieldDefLookup} factory backed by a mutable
 * registry of loaded namespace definitions. The default + `_system` datasets are
 * constructed (in `wireStore`) BEFORE plugins load, so the returned closures
 * resolve lazily — the same late-binding contract as `datasetRegistryRef` /
 * `engineRef`. `runServe` populates `nsDefs` once plugins are loaded and well
 * before the server listens, so every query resolves against a populated map.
 *
 * A miss (namespace absent, or a hand-crafted `NamespaceDefinition` whose
 * `types` is undefined because it bypassed `defineNamespace`) returns
 * `undefined`, and the dataset falls back to lexicographic text compare.
 */
export function makeFieldDefLookupFactory(nsDefs: {
  get(namespace: string): NamespaceDefinition | undefined;
}): (namespace: string) => FieldDefLookup {
  return (namespace) => (type, field) => nsDefs.get(namespace)?.types?.[type]?.fields?.[field];
}

/**
 * Build a {@link TypeDefLookup} factory over the same late-bound `nsDefs`
 * registry as {@link makeFieldDefLookupFactory}: a type's fields and declared
 * indexes, which `PgDataset.ensureTypeStorage` builds indexes from. Once
 * `registryFor` resolves, the live registry's fields, which include proposed
 * ones, are merged over the declared fields, and the declared `indexes` are
 * kept; a type no definition declares (proposed at runtime, or registered at
 * install) has the registry's fields alone. The engine's reserved fields are
 * left out where autoCRUD registered them, since they are not body fields.
 * The lookup answers for the namespace it is asked about, so clones made by
 * `forNamespace` resolve their own types.
 */
export function makeTypeDefLookupFactory(
  nsDefs: { get(namespace: string): NamespaceDefinition | undefined },
  registryFor: (namespace: string) => RegistryInterface | undefined = () => undefined
): (namespace: string) => TypeDefLookup {
  const lookup: TypeDefLookup = (type, namespace) => {
    const declared = nsDefs.get(namespace)?.types?.[type];
    const entry = registryFor(namespace)?.get(type);
    if (entry?.kind !== 'type') return declared;
    // autoCRUD registers the reserved descriptor itself; a type without
    // autoCRUD may declare a body field of the same name.
    const live = Object.fromEntries(
      Object.entries(entry.fields).filter(
        ([f, def]) =>
          !Object.hasOwn(RESERVED_AUTOCRUD_FIELDS, f) || RESERVED_AUTOCRUD_FIELDS[f] !== def
      )
    );
    return declared === undefined
      ? { fields: live }
      : { ...declared, fields: { ...declared.fields, ...live } };
  };
  return () => lookup;
}

/**
 * Prepares storage for every type the namespace definitions declare: its
 * partition and its unique indexes, through `Dataset.ensureTypeStorage`. Runs
 * before any kernel migration, so a migration can rely on a declared unique
 * index. Non-unique indexes are left to {@link buildDeferredIndexes}. Errors
 * propagate and fail the boot, among them `UniqueIndexDuplicatesError` and
 * `IndexDefinitionConflictError`, which name the index, and a declared
 * namespace with no dataset. Index builds run CONCURRENTLY, so the process
 * must hold no open transaction meanwhile.
 */
export async function reconcileDeclaredStorage(
  datasetFor: (ns: string) => Dataset | undefined,
  nsDefs: Map<string, NamespaceDefinition>
): Promise<void> {
  for (const [ns, def] of nsDefs) {
    const dataset = datasetFor(ns);
    if (dataset === undefined) {
      throw new Error(
        `namespace '${ns}' is declared but has no dataset; its storage cannot be prepared`
      );
    }
    for (const type of Object.keys(def.types ?? {})) {
      await dataset.ensureTypeStorage?.(type, { indexes: 'unique' });
    }
  }
}

type ComposedDatasets = { has(ns: string): boolean; get(ns: string): Dataset | undefined };

/** Every type registered in a namespace with a local dataset, with that dataset. */
function* registeredTypes(
  engine: Pick<Engine, 'federatedSchema' | 'registryFor'>,
  datasets: ComposedDatasets
): Generator<{ ns: string; type: string; dataset: Dataset | undefined }> {
  for (const ns of Object.keys(engine.federatedSchema())) {
    // `has`, not `get`: `get` would allocate a dataset for a virtual namespace.
    if (!datasets.has(ns)) continue;
    const dataset = datasets.get(ns);
    for (const [type, entry] of engine.registryFor(ns)?.all() ?? []) {
      if (entry.kind === 'type') yield { ns, type, dataset };
    }
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Prepares storage, partition and unique indexes, for every type registered in
 * every local namespace once compose has run: `_system`, install-time types
 * such as the proposals plugin's, and proposed types replayed at start.
 * Namespaces without a local dataset (bridged, virtual) are skipped. A type the
 * operator's `nsDefs` declares fails the boot on error, since its unique
 * indexes must exist. A type only the registry knows (proposed by a principal
 * who can merely propose) logs the error naming it and the boot continues.
 */
export async function reconcileRegisteredStorage(
  engine: Pick<Engine, 'federatedSchema' | 'registryFor'>,
  datasets: ComposedDatasets,
  nsDefs: { get(ns: string): NamespaceDefinition | undefined }
): Promise<void> {
  for (const { ns, type, dataset } of registeredTypes(engine, datasets)) {
    try {
      await dataset?.ensureTypeStorage?.(type, { indexes: 'unique' });
    } catch (err) {
      if (nsDefs.get(ns)?.types?.[type] !== undefined) throw err;
      process.stderr.write(
        `storage for registered type ${ns}/${type} was not prepared: ${message(err)}\n`
      );
    }
  }
}

/**
 * Builds the non-unique indexes of every registered type, one type at a time.
 * Started after the server listens: until an index is valid, filters it would
 * serve scan. Never rejects: a type whose build fails is logged, and reported
 * `failed`, until the next boot retries it. `signal` cancels the build in
 * flight, whose INVALID leftover the next reconcile drops, and skips the rest.
 */
export async function buildDeferredIndexes(
  engine: Pick<Engine, 'federatedSchema' | 'registryFor'>,
  datasets: ComposedDatasets,
  signal?: AbortSignal
): Promise<void> {
  for (const { ns, type, dataset } of registeredTypes(engine, datasets)) {
    if (signal?.aborted === true) return;
    try {
      await dataset?.ensureTypeStorage?.(type, {
        indexes: 'nonUnique',
        ...(signal !== undefined ? { signal } : {})
      });
    } catch (err) {
      process.stderr.write(
        `indexes of ${ns}/${type} were not built and will be retried at the next boot: ${message(err)}\n`
      );
    }
  }
}

/**
 * Walk loaded namespace definitions for `field.list({ indexed: true })` and
 * `field.json({ indexed: true })` fields. Each becomes an auto-derived GIN
 * migration so the `indexed` flag — the validator's queryability contract —
 * can't drift from the physical index.
 */
export function extractIndexedListFields(
  nsDefs: Map<string, NamespaceDefinition>
): IndexedListField[] {
  const out: IndexedListField[] = [];
  for (const [namespace, def] of nsDefs) {
    const types = def.types;
    if (types === undefined) continue;
    for (const [type, typeDef] of Object.entries(types)) {
      for (const [field, fieldDef] of Object.entries(typeDef.fields)) {
        // An indexed json field wants the identical index — a GIN over
        // `(body -> field)` — serving path-filter containment.
        const indexedJson =
          fieldDef.kind === 'scalar' && fieldDef.type === 'json' && fieldDef.indexed === true;
        if ((fieldDef.kind === 'list' && fieldDef.indexed === true) || indexedJson) {
          out.push({ namespace, type, field });
        }
      }
    }
  }
  return out;
}

/**
 * Pick per-namespace datasets for plugin-contributed namespaces.
 *
 * When the store is pg (`sharedSql` is non-null) every plugin namespace is
 * backed by a `PgDataset` pointing at the same connection pool — they
 * coexist in one `rows` table keyed by the `namespace` column, which
 * is the core multi-namespace model. Multi-pg (namespace → distinct DB)
 * deployments should override `datasets` on the `compose()` call site
 * directly; this helper only covers the common single-pg-many-namespaces
 * shape.
 *
 * When the store is memory, every plugin namespace gets a fresh
 * `MemoryDataset` so the contribution boots cleanly without reaching
 * across to the default substrate.
 *
 * `fieldDefLookupFor` yields the namespace-scoped lookup that lets pg datasets
 * cast numeric/date/boolean body fields in orderBy + range + cursor compares.
 * Memory datasets ignore it.
 */
export function buildPluginDatasetMap(
  plugins: Array<CoordinatorPlugin>,
  defaultDataset: Dataset,
  sharedSql: Sql | null,
  sharedEdges: PgEdgesStore | null,
  fieldDefLookupFor: (namespace: string) => FieldDefLookup,
  typeDefLookup?: TypeDefLookup
): Record<string, Dataset> {
  const datasets: Record<string, Dataset> = {};
  for (const plugin of plugins) {
    for (const nsDef of plugin.namespaces) {
      const ns = nsDef.namespace;
      if (ns === DEFAULT_NAMESPACE) {
        datasets[ns] = defaultDataset;
        continue;
      }
      if (datasets[ns] !== undefined) continue;
      datasets[ns] =
        sharedSql !== null
          ? new PgDataset({
              namespace: ns,
              sql: sharedSql,
              fieldDefLookup: fieldDefLookupFor(ns),
              typeDefLookup: typeDefLookup ?? ((type) => nsDef.types?.[type]),
              ...(nsDef.promotedColumns !== undefined
                ? { promotedColumns: nsDef.promotedColumns }
                : {}),
              // Thread the shared edges store so every plugin-contributed
              // namespace on the same pg pool can enlist edge ops into the
              // substrate tx.
              ...(sharedEdges !== null ? { edgesStore: sharedEdges } : {})
            })
          : new MemoryDataset({ namespace: ns, fieldDefLookup: fieldDefLookupFor(ns) });
    }
  }
  return datasets;
}

/**
 * Redact the password component of a `SUBSTRATE_DATABASE_URL` value so it can be safely
 * written to stdout / journald at boot. Operates on postgres URLs; passes
 * `memory` (and any other non-URL value) through unchanged.
 */
export function redactStoreSpec(spec: string): string {
  if (!spec.startsWith('postgres://') && !spec.startsWith('postgresql://')) {
    return spec;
  }
  // Match: scheme://user:password@rest. Replace the password with `<redacted>`.
  // The user component is preserved (not sensitive on its own; useful for ops).
  return spec.replace(/^(postgres(?:ql)?:\/\/[^:@/]+):[^@]*@/, '$1:<redacted>@');
}

/**
 * Ensure the `kernel_migrations` tracking table exists. Distinct
 * from `migrations` (which the dataset-pg framework owns for its own
 * `version`/`checksum`-keyed migrations) — this table tracks
 * KernelPlugin-contributed migrations by `(plugin_name, migration_id)`.
 * Idempotent CREATE-IF-NOT-EXISTS. No-op on memory-backed deployments.
 */
export async function ensureMigrationsTable(sql: Sql | null): Promise<void> {
  await kernelMigrationTracking(sql).ensure();
}

/**
 * Return the set of migration IDs already recorded as applied for the given
 * plugin. Returns an empty Set on memory-backed deployments (sql null).
 */
export async function getAppliedMigrationIds(
  sql: Sql | null,
  pluginName: string
): Promise<Set<string>> {
  return kernelMigrationTracking(sql).getAppliedMigrationIds(pluginName);
}

/**
 * Record a migration as applied. ON CONFLICT DO NOTHING makes this safe to
 * call even if the row already exists (concurrent boot, retry after a partial
 * failure). No-op on memory-backed deployments.
 */
export async function recordMigrationApplied(
  sql: Sql | null,
  pluginName: string,
  migrationId: string
): Promise<void> {
  await kernelMigrationTracking(sql).recordMigrationApplied(pluginName, migrationId);
}
