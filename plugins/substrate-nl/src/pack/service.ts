import { createHash } from 'node:crypto';
import type { NlServedPack, Schema, SubstrateRequest } from '@mnmal-ai/substrate/sdk';
import type { NlEngineAccess } from '../access.js';
import { own } from '../own.js';
import { readRulings } from '../rulings/schema.js';
import { buildNamespacePack } from './build.js';
import { profileNamespace, type ReadPage } from './profile.js';
import type { NamespaceRulings } from './rulings.js';

export type ServedPack = NlServedPack;

export interface PackServiceOptions {
  engine: NlEngineAccess;
  rulings?: Record<string, NamespaceRulings>;
  ttlMs?: number;
  /** Cache capacity; least-recently-used entries are evicted. Default 256. */
  maxEntries?: number;
  now?: () => number;
  log?: (line: string) => void;
}

interface Entry {
  pack: ServedPack;
  etag: string;
  at: number;
}

/**
 * Packs are built under the CALLER's request: the profile reads distinct
 * values through `engine.query(frame, req)`, so row policy applies and a
 * pack can never disclose a value its caller could not read. Hence the
 * principal is part of the cache key.
 */
export class PackService {
  readonly #opts: PackServiceOptions;
  readonly #cache = new Map<string, Entry>();
  readonly #inflight = new Map<string, Promise<Entry>>();
  readonly #warned = new Set<string>();

  constructor(opts: PackServiceOptions) {
    this.#opts = opts;
  }

  async get(
    ns: string,
    req: SubstrateRequest
  ): Promise<{ pack: ServedPack; etag: string } | undefined> {
    const schemas = this.#opts.engine.federatedSchema();
    const schema = Object.hasOwn(schemas, ns) ? schemas[ns] : undefined;
    if (schema === undefined) return undefined;
    const now = (this.#opts.now ?? Date.now)();
    const ttl = this.#opts.ttlMs ?? 300_000;
    const key = `${ns}\u0000${schema.schemaVersion}\u0000${principalKey(req)}`;
    const hit = this.#cache.get(key);
    if (hit !== undefined && now - hit.at < ttl) {
      this.#cache.delete(key);
      this.#cache.set(key, hit); // re-insert: most recently used
      return { pack: hit.pack, etag: hit.etag };
    }
    let pending = this.#inflight.get(key);
    if (pending === undefined) {
      pending = this.#build(ns, schema, req, now).finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, pending);
    }
    const entry = await pending;
    this.#cache.delete(key);
    this.#cache.set(key, entry);
    const max = this.#opts.maxEntries ?? 256;
    while (this.#cache.size > max) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    return { pack: entry.pack, etag: entry.etag };
  }

  async #build(ns: string, schema: Schema, req: SubstrateRequest, now: number): Promise<Entry> {
    const { rulings, warnings } = readRulings(schema, own(this.#opts.rulings, ns));
    const warnKey = `${ns}\u0000${schema.schemaVersion}`;
    if (warnings.length > 0 && !this.#warned.has(warnKey)) {
      this.#warned.add(warnKey);
      (this.#opts.log ?? console.warn)(`substrate-nl: ${ns}: ${warnings.join('; ')}`);
    }
    const read: ReadPage = async (type, fields, cursor) => {
      const frameKey = `${ns}/${type}`;
      const env = await this.#opts.engine.query(
        {
          [frameKey]: {
            // No limit: the host's page bounds size each page.
            params: cursor !== undefined ? { cursor } : {},
            fields: Object.fromEntries(fields.map((f) => [f, true]))
          }
        },
        req
      );
      const rows = env.data?.[frameKey];
      const page = env._pagination?.[frameKey];
      return {
        rows: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [],
        nextCursor: page?.hasMore === true ? page.nextCursor : undefined
      };
    };
    const profile = await profileNamespace({ schema, read });
    const built = buildNamespacePack({
      namespace: ns,
      schema,
      operators: this.#opts.engine.operators(ns) ?? {},
      profile
    });
    const pack: ServedPack = { ...built, rulings, warnings };
    const etag = `"${createHash('sha256').update(JSON.stringify(pack)).digest('hex').slice(0, 16)}"`;
    return { pack, etag, at: now };
  }
}

/**
 * The Identity canonicalised, less `expiresAt`: a custom row policy may key on
 * any claim (a tenant, say), so no other subset is safe to share a cached pack
 * across, while a token's expiry changes with every refresh.
 */
function principalKey(req: SubstrateRequest): string {
  const id = req.identity;
  if (id === undefined) return '\u0000anon';
  const { expiresAt: _expiresAt, ...stable } = id;
  return JSON.stringify(canonical(stable));
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x)])
    );
  }
  return v;
}
