import type { FieldDef, Schema } from '@mnmal-ai/substrate/sdk';
import type { FieldProfile, NamespaceProfile } from './types.js';

/** One page of rows for `type`, projecting `fields`. */
export type ReadPage = (
  type: string,
  fields: string[],
  cursor?: string
) => Promise<{ rows: Record<string, unknown>[]; nextCursor: string | undefined }>;

export interface ProfileInput {
  schema: Schema;
  read: ReadPage;
  /** Stop collecting a field past this many distinct values. Default 1000. */
  maxDistinct?: number;
  /**
   * Rows read per type. Default 10 000. The pack is built on the request
   * path, per caller, so an unbounded read would be a full scan of every type.
   * A field's labels that appear only past the budget are left out of its
   * vocabulary.
   */
  maxRows?: number;
}

/**
 * Distinct values of every indexed string field (and indexed list-of-string
 * field) in the namespace, reading up to `maxRows` rows per type. A field that
 * passes `maxDistinct` is marked truncated and stops growing.
 */
export async function profileNamespace(input: ProfileInput): Promise<NamespaceProfile> {
  const maxDistinct = input.maxDistinct ?? 1000;
  const maxRows = input.maxRows ?? 10_000;
  const types: NamespaceProfile['types'] = {};
  for (const typeName of Object.keys(input.schema.types).sort()) {
    const declared = input.schema.types[typeName]?.fields ?? {};
    const fields = Object.keys(declared).filter((f) => profiled(declared[f] as FieldDef));
    if (fields.length === 0) continue;
    const seen = new Map<string, Set<string>>(fields.map((f) => [f, new Set<string>()]));
    const truncated = new Set<string>();
    let cursor: string | undefined;
    let rowsRead = 0;
    do {
      const page = await input.read(typeName, fields, cursor);
      rowsRead += page.rows.length;
      for (const row of page.rows) {
        for (const f of fields) {
          if (truncated.has(f)) continue;
          const raw = row[f];
          const values = Array.isArray(raw) ? raw : [raw];
          const set = seen.get(f) as Set<string>;
          for (const v of values) {
            if (typeof v !== 'string' || v.length === 0) continue;
            set.add(v);
            if (set.size > maxDistinct) {
              truncated.add(f);
              break;
            }
          }
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined && truncated.size < fields.length && rowsRead < maxRows);

    const out: Record<string, FieldProfile> = {};
    for (const f of [...fields].sort()) {
      const values = [...(seen.get(f) as Set<string>)].sort();
      const isTruncated = truncated.has(f);
      if (values.length === 0 && !isTruncated) continue;
      out[f] = {
        values: isTruncated ? values.slice(0, maxDistinct) : values,
        truncated: isTruncated
      };
    }
    types[typeName] = out;
  }
  return { types };
}

function profiled(def: FieldDef): boolean {
  // Only an explicit `indexed: false` opts a scalar out (long-form prose); unset is a handle.
  if (def.kind === 'scalar') return def.type === 'string' && def.indexed !== false;
  return (
    def.kind === 'list' &&
    def.indexed === true &&
    def.of.kind === 'scalar' &&
    def.of.type === 'string'
  );
}
