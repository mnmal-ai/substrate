/**
 * `defineNamespace` helper. Spec: §5.11.
 *
 * Wraps a flat `{ typeName → TypeInput }` map in a `NamespaceDefinition` that
 * installs the whole type surface in one `install(ctx)` call. Each type
 * round-trips through `installAutoCrud` unless the caller opts out with
 * `autoCrud: false`.
 *
 * Policy composition — three layers, composed via `and(...)`:
 *   1. `ctx.pluginPolicy` — plugin-global (from CoordinatorPlugin.policies,
 *      pre-composed by the loader). Applies to every resolver in every
 *      namespace the owning plugin contributes.
 *   2. `opts.policy` — namespace-global. Applies to every type in THIS
 *      namespace only.
 *   3. `typeInput.policy` — per-type. Narrows further.
 *
 * Short-circuit on first deny (§4.4). When no layer is present the registry's
 * default (`allowAll`) applies.
 *
 * Purgeable / adminCapability are threaded through per-type so a namespace
 * can mix purge-disabled application types with a purge-enabled admin type
 * without declaring two plugins.
 *
 * Types opting out of autoCRUD (`autoCrud: false`) are ignored by this
 * helper — callers wanting custom resolvers for the same type must register
 * them against `ctx.registry` inside a wrapping `install()` or a dedicated
 * plugin.
 */

import { and } from '@mnmal-ai/substrate-policy';
import type {
  EmbedSourceContext,
  FieldDef,
  IndexDecl,
  NamespaceDefinition,
  NamespaceInstallContext,
  NamespaceTypeDef,
  OrderedBy,
  Policy,
  PostWriteHook,
  Row
} from '@mnmal-ai/substrate-types';
import { installAutoCrud } from './autocrud/index.js';
import { assertServerSetFieldsFillable } from './autocrud/internal.js';
import { RESERVED_AUTOCRUD_FIELD_NAMES, RESERVED_AUTOCRUD_FIELDS } from './autocrud/reserved.js';

export type { PostWriteHook };

export interface TypeInput {
  fields: Record<string, FieldDef>;
  policy?: Policy;
  /** Opt out of autoCRUD entirely. Default true (autoCRUD is installed). */
  autoCrud?: boolean;
  /** Install the admin-only purge<T> mutation. Default false. */
  purgeable?: boolean;
  /** Rename the admin capability (default 'admin'). */
  adminCapability?: string;
  /**
   * Optional hook called after every successful create or update write.
   * Receives the persisted row and request context. Under the engine it runs
   * once the write's transaction commits, on the committed row, and a failure
   * is reported rather than failing the write; on a direct resolver call,
   * errors propagate to the caller.
   */
  postWrite?: PostWriteHook;
  /**
   * Optional embeddable-type metadata. When present, substrate plugins
   * (such as substrate-recall) inspect this slot at coordinator-namespace
   * install time and chain an appropriate postWrite hook that runs
   * `source(row, ctx?)` to produce the text fed to the embedder. The SDK
   * does not interpret this slot — it stores the metadata and exposes it
   * via the namespace introspection used by substrate plugins.
   *
   * `ctx` is optional — when the composing substrate has a dataset
   * resolver wired, source functions may call
   * `ctx.read(ns, type, { id })` to inline related-entity context.
   * Async return is supported so source can await crossRef reads.
   *
   * Returning `null` / `undefined` declares the row un-indexable — the
   * substrate skips the embed AND removes any embedding the row already
   * has. `''` is NOT the sentinel; it embeds normally. See
   * `NamespaceTypeDef.embed.source` in @mnmal-ai/substrate-types, which this
   * signature must stay identical to — `embedSourceSignaturesAgree` in
   * test/embed-source-contract.test.ts fails the build if they drift.
   */
  embed?: {
    source: (
      row: Row,
      ctx?: EmbedSourceContext
    ) => string | null | undefined | Promise<string | null | undefined>;
  };
  /**
   * Optional lexical (keyword) source. Sibling of `embed`, and it exists
   * BECAUSE the two indexes want different text from the same row: `embed`
   * conventionally takes a handle — `synopsis || body`, often the question a
   * row answers — and that handle drops the proper nouns the body holds.
   *
   * Same `null` / `undefined` un-indexable sentinel as `embed.source`, and `''`
   * is likewise NOT the sentinel.
   *
   * NOTE THE SIGNATURE IS NOT IDENTICAL TO EMBED'S: there is no `ctx`. A
   * lexical source works from `row` alone. `lexicalSourceSignaturesAgree` in
   * test/embed-source-contract.test.ts fails the build if this drifts from
   * `NamespaceTypeDef.lexical.source` in @mnmal-ai/substrate-types.
   */
  lexical?: {
    source: (row: Row) => string | null | undefined | Promise<string | null | undefined>;
  };
  /**
   * Composite and unique indexes, built by the engine with the filter
   * compiler's own expressions. Keys and predicate fields must be declared
   * scalar (not json) or crossRef fields. See `IndexDecl`.
   */
  indexes?: IndexDecl[];
  /**
   * The type's natural order: what a read with no `orderBy` returns. Exactly
   * one key, a declared date or number field or a metadata column
   * (`createdAt`, `updatedAt`, or `seq` on a visible-order type). Absent
   * means newest first by `createdAt`.
   */
  orderedBy?: OrderedBy;
  /**
   * `'visible'`: each inserted row gets `_metadata.seq`, strictly increasing
   * per type in commit order, so a reader paging by `seq` never sees a higher
   * seq before a lower one becomes visible. An upsert of an existing row keeps
   * its seq. `seq` is filterable, sortable, and valid in `orderedBy`.
   *
   * Cost: writes to the type are serialised. Each insert holds a per-type
   * transaction lock from seq assignment to commit, so one writer's open
   * transaction blocks every other writer of the type until it ends. Other
   * types are unaffected and pay nothing.
   */
  ordering?: 'visible';
  /**
   * Expected size. `large` lets the index advisor recommend for this type
   * from its profile's lower `minRowsLargeHint` rather than `minRows`.
   */
  expectedSize?: 'small' | 'large';
}

export interface DefineNamespaceOptions {
  /**
   * Plugin-global policy applied to every type's autoCRUD surface. Composes
   * with per-type policies via `and()` — the combined gate must allow.
   */
  policy?: Policy;
  /**
   * Opaque metadata for consumers of this namespace's schema, keyed by
   * consumer (`nl` for substrate-nl's rulings). Must be JSON-serialisable.
   */
  annotations?: Record<string, unknown>;
  /** See `NamespaceDefinition.promotedColumns`. */
  promotedColumns?: NamespaceDefinition['promotedColumns'];
}

/** Throws unless `value` round-trips through JSON unchanged. */
function assertJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) assertJsonValue(v, `${path}[${i}]`);
    return;
  } else if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) assertJsonValue(v, `${path}.${k}`);
    return;
  }
  throw new Error(`namespace annotations must be JSON-serialisable: ${path} is not`);
}

/**
 * A namespace name that cannot be confused with the syntax around it.
 *
 * Two separators depend on this:
 *
 *   `/`  qualified frame keys — `parseQualifiedKey` splits on the FIRST slash,
 *        so a namespace containing one silently truncates the name it parses.
 *   `:`  the per-namespace grant form `--ns notes:read,tasks:read+mutate`,
 *        which only separates a namespace from its capabilities if a namespace
 *        cannot contain a colon.
 */
const NAMESPACE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export function defineNamespace(
  namespace: string,
  types: Record<string, TypeInput>,
  opts: DefineNamespaceOptions = {}
): NamespaceDefinition {
  if (!NAMESPACE_NAME_PATTERN.test(namespace)) {
    throw new Error(
      `invalid namespace name '${namespace}': expected ${NAMESPACE_NAME_PATTERN.source}. ` +
        "A namespace must not contain '/' (it would truncate every qualified frame key) " +
        "or ':' (it would be ambiguous with the per-namespace grant form, e.g. --ns notes:read)."
    );
  }
  // Validate at definition time — catch reserved field names and unfillable
  // serverSet fields before install.
  // Reserved only for types that go through autoCRUD (where engine fields
  // would be injected); autoCrud:false types may declare any field name
  // they like because no injection touches them.
  for (const [typeName, typeInput] of Object.entries(types)) {
    if (typeInput.autoCrud === false) continue;
    for (const reserved of RESERVED_AUTOCRUD_FIELD_NAMES) {
      if (Object.hasOwn(typeInput.fields, reserved)) {
        throw new Error(
          `\`${reserved}\` is a reserved field name, auto-injected by the engine (type: ${typeName})`
        );
      }
    }
    assertServerSetFieldsFillable(typeName, typeInput.fields);
  }

  for (const [typeName, typeInput] of Object.entries(types)) {
    for (const decl of typeInput.indexes ?? []) assertIndexDecl(typeName, typeInput.fields, decl);
    const ordering: unknown = typeInput.ordering;
    if (ordering !== undefined && ordering !== 'visible') {
      throw new Error(`ordering on ${typeName} must be 'visible', got '${String(ordering)}'`);
    }
    if (typeInput.orderedBy !== undefined) assertOrderedBy(typeName, typeInput);
    const size: unknown = typeInput.expectedSize;
    if (size !== undefined && size !== 'small' && size !== 'large') {
      throw new Error(
        `expectedSize on ${typeName} must be 'small' or 'large', got '${String(size)}'`
      );
    }
  }

  if (opts.annotations !== undefined) assertJsonValue(opts.annotations, 'annotations');
  const globalPolicy = opts.policy;
  return {
    namespace,
    // Cast required: TypeInput lacks `[key: string]: unknown` (it has only
    // specific optional fields), so TS cannot prove TypeInput ⊆ NamespaceTypeDef
    // under exactOptionalPropertyTypes even though every named slot aligns.
    // NamespaceTypeDef's index signature is intentional — it lets substrate
    // plugins consume fields + embed + postWrite without depending on the SDK.
    types: types as Readonly<Record<string, NamespaceTypeDef>>,
    ...(opts.annotations !== undefined ? { annotations: opts.annotations } : {}),
    ...(opts.promotedColumns !== undefined ? { promotedColumns: opts.promotedColumns } : {}),
    install(ctx: NamespaceInstallContext): void {
      for (const [typeName, typeInput] of Object.entries(types)) {
        if (typeInput.autoCrud === false) continue;

        // Inject reserved engine fields without mutating the caller-supplied
        // fields object. Single source of truth lives in
        // `./autocrud/reserved.ts` so external callers (substrate-proposals)
        // can spread the same descriptors.
        const augmentedFields: Record<string, FieldDef> = {
          ...typeInput.fields,
          ...RESERVED_AUTOCRUD_FIELDS
        };

        const combined = composePolicyLayers(ctx.pluginPolicy, globalPolicy, typeInput.policy);
        const installOpts: Parameters<typeof installAutoCrud>[4] = {
          fields: augmentedFields
        };
        if (typeInput.orderedBy !== undefined) installOpts.orderedBy = typeInput.orderedBy;
        if (combined !== undefined) installOpts.policy = combined;
        if (typeInput.purgeable === true) installOpts.purgeable = true;
        if (typeInput.adminCapability !== undefined) {
          installOpts.adminCapability = typeInput.adminCapability;
        }
        const contributions = ctx.postWriteContributions?.[typeName] ?? [];
        const chain: PostWriteHook[] = [];
        if (typeInput.postWrite !== undefined) chain.push(typeInput.postWrite);
        chain.push(...contributions);
        if (chain.length > 0) {
          installOpts.postWrite = composeChain(chain);
        }

        installAutoCrud(ctx.registry, typeName, ctx.dataset, ctx.edges, installOpts);
      }
    }
  };
}

/** Lower-snake, within pg's 63-byte identifier limit. */
const INDEX_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/** Throws unless every key is a btree-indexable declared field or `createdAt`/`updatedAt`, and every predicate field a declared one. */
export function assertIndexDecl(
  typeName: string,
  fields: Record<string, FieldDef>,
  decl: IndexDecl
): void {
  const where = `index on ${typeName}`;
  const assertField = (name: string): void => {
    const def = fields[name];
    if (def === undefined) throw new Error(`${where}: unknown field '${name}'`);
    const ok = def.kind === 'crossRef' || (def.kind === 'scalar' && def.type !== 'json');
    if (!ok) {
      throw new Error(
        `${where}: field '${name}' is ${def.kind}; only scalar and crossRef fields index`
      );
    }
  };
  if (!Array.isArray(decl.fields) || decl.fields.length === 0) {
    throw new Error(`${where}: fields must be a non-empty array`);
  }
  // A key may also be a metadata column, which an index keys as natural order does.
  const assertKey = (name: string): void => {
    if (name !== 'createdAt' && name !== 'updatedAt') assertField(name);
  };
  for (const f of decl.fields) {
    if (typeof f === 'string') {
      assertKey(f);
      continue;
    }
    assertKey(f.field);
    if (f.dir !== 'asc' && f.dir !== 'desc') {
      throw new Error(
        `${where}: dir of '${f.field}' must be 'asc' or 'desc', got '${String(f.dir)}'`
      );
    }
  }
  if (decl.where !== undefined && decl.where !== 'live') {
    for (const [name, value] of Object.entries(decl.where)) {
      assertField(name);
      if (value !== null && typeof value !== 'boolean') {
        throw new Error(`${where}: where.${name} must be a boolean or null`);
      }
      const def = fields[name];
      if (value !== null && !(def?.kind === 'scalar' && def.type === 'boolean')) {
        throw new Error(
          `${where}: where.${name} compares a boolean, but '${name}' is not a boolean field`
        );
      }
    }
  }
  if (decl.name?.endsWith('__swap') === true) {
    throw new Error(
      `${where}: name '${decl.name}' must not end in '__swap', the reconciler's temporary suffix`
    );
  }
  if (decl.name !== undefined && !INDEX_NAME_PATTERN.test(decl.name)) {
    throw new Error(`${where}: name '${decl.name}' must match ${INDEX_NAME_PATTERN.source}`);
  }
}

/** Metadata columns a type may take as its natural order. */
const ORDERED_BY_METADATA_COLUMNS: ReadonlySet<string> = new Set(['createdAt', 'updatedAt']);

/**
 * Throws unless `orderedBy` is one key, on a date or number field or a metadata
 * column; `seq` only on a type declared `ordering: 'visible'`.
 */
export function assertOrderedBy(
  typeName: string,
  def: Pick<TypeInput, 'fields' | 'orderedBy' | 'ordering'>
): void {
  const where = `orderedBy on ${typeName}`;
  const entries = Object.entries(def.orderedBy ?? {});
  if (entries.length !== 1) {
    throw new Error(`${where}: must name exactly one field, got ${entries.length}`);
  }
  const [name, dir] = entries[0] as [string, unknown];
  if (dir !== 'asc' && dir !== 'desc') {
    throw new Error(`${where}: dir of '${name}' must be 'asc' or 'desc', got '${String(dir)}'`);
  }
  if (ORDERED_BY_METADATA_COLUMNS.has(name)) return;
  if (name === 'seq') {
    if (def.ordering === 'visible') return;
    throw new Error(`${where}: 'seq' needs the type to declare ordering: 'visible'`);
  }
  const field = def.fields[name];
  if (field === undefined) throw new Error(`${where}: unknown field '${name}'`);
  if (!(field.kind === 'scalar' && (field.type === 'date' || field.type === 'number'))) {
    const kind = field.kind === 'scalar' ? field.type : field.kind;
    throw new Error(
      `${where}: field '${name}' is ${kind}; only date and number fields, ` +
        `or ${[...ORDERED_BY_METADATA_COLUMNS].join(', ')}, can be a natural order`
    );
  }
}

function composePolicyLayers(
  pluginLevel: Policy | undefined,
  namespaceLevel: Policy | undefined,
  typeLevel: Policy | undefined
): Policy | undefined {
  const layers = [pluginLevel, namespaceLevel, typeLevel].filter(
    (p): p is Policy => p !== undefined
  );
  if (layers.length === 0) return undefined;
  if (layers.length === 1) return layers[0];
  return and(...layers);
}

/**
 * Composes an array of PostWriteHooks into a single hook that runs them
 * sequentially. An error from any hook propagates immediately and stops
 * downstream hooks (matching the single-hook propagation semantic).
 */
function composeChain(hooks: PostWriteHook[]): PostWriteHook {
  if (hooks.length === 1) return hooks[0]!;
  return async (row, ctx) => {
    for (const hook of hooks) {
      await hook(row, ctx);
    }
  };
}
