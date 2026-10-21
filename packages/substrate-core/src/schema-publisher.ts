/**
 * Schema publisher. Spec: §4.2, §6.1, §7.1.
 *
 * Walks the registry, emits a `Schema` with a deterministic
 * `schemaVersion` — the 12-char SHA-256 prefix of the canonicalized schema
 * content. Identical registries produce identical versions; adding a type or
 * changing a field shifts it.
 *
 * Type-vs-mutation routing is driven by `RegistryEntry.kind`, set explicitly at
 * registration. No name-case heuristics.
 */

import { createHash } from 'node:crypto';
import type {
  FieldDef,
  MutationSchema,
  Registry,
  Schema,
  TypeSchema
} from '@mnmal-ai/substrate-types';
import { canonicalize } from './canonicalize.js';

/**
 * Sentinel "unknown return shape" descriptor. A mutation registered without an
 * explicit `returns` field still needs a publishable entry so the envelope
 * carries return metadata; consumers that see this sentinel should treat the
 * response as JSON-passthrough (no positional reconstruction attempted).
 */
const UNKNOWN_RETURNS: FieldDef = { kind: 'scalar', type: 'string', nullable: true };

/** Return the first 12 hex chars of the SHA-256 hash of `content`. */
export function sha256Short(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 12);
}

function hashContent(
  types: Record<string, TypeSchema>,
  mutations: Record<string, MutationSchema>
): string {
  const canonical = JSON.stringify(canonicalize({ types, mutations }));
  return sha256Short(canonical);
}

export function publishSchema(registry: Registry): Schema {
  const types: Record<string, TypeSchema> = {};
  const mutations: Record<string, MutationSchema> = {};

  for (const [name, entry] of registry.all()) {
    if (entry.kind === 'mutation') {
      mutations[name] = {
        params: entry.params,
        returns: entry.returns ?? UNKNOWN_RETURNS
      };
    } else {
      types[name] = { fields: entry.fields };
    }
  }

  return {
    schemaVersion: hashContent(types, mutations),
    types,
    mutations
  };
}
