/**
 * `POST /substrate/v1/_system/backfill-field` — write per-row values of one field,
 * computed by the caller (e.g. a resolution inferred from each row's title),
 * WITHOUT making the rows look edited.
 *
 * `normalise-vocab` covers one value map applied to a whole field; this is
 * the per-row companion. Values are validated against the field the way a
 * write would be (vocabulary aliases canonicalised, unknowns refused on a
 * strict field), but written through the dataset with each row's existing
 * `_metadata`, so `updatedAt` / `updatedBy` stay as they were.
 *
 * Dry run by default. Fills only rows where the field is empty unless
 * `overwrite: true`: a backfill that silently replaced values someone wrote
 * on purpose would be an edit wearing a migration's clothes.
 */

import type {
  Dataset,
  FieldDef,
  HttpHandler,
  Row,
  Schema,
  SubstrateResponse
} from '@mnmal-ai/substrate-types';
import { canonicalVocabValue } from '@mnmal-ai/substrate-types';
import { extractClientIp, jsonResponse } from '../routes/helpers.js';
import { buildAuditRow } from './install.js';
import { AUDIT_EVENT_TYPE, SYSTEM_NAMESPACE } from './types.js';

export interface BackfillFieldRouteDeps {
  resolveDataset: (namespace: string) => Dataset | null;
  schemaFor: (namespace: string) => Schema | null;
  now: () => Date;
  trustedProxies: string[] | Set<string>;
}

/** Rows per request: enough for any one-off, small enough to review. */
export const BACKFILL_MAX_ROWS = 5000;
/** Row ids named in the audit event; the rest are counted, not listed. */
export const AUDIT_ID_LIMIT = 500;
const BATCH = 200;

const badRequest = (code: string, message: string, extra: object = {}): SubstrateResponse =>
  jsonResponse(400, { code, message, ...extra });

const SCALAR_TYPEOF: Record<string, string> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  date: 'string'
};

export function backfillFieldRoute(deps: BackfillFieldRouteDeps): HttpHandler {
  const proxySet =
    deps.trustedProxies instanceof Set ? deps.trustedProxies : new Set(deps.trustedProxies);
  return async (req) => {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(req.body?.toString('utf8') ?? '') as Record<string, unknown>;
    } catch {
      return badRequest('invalid_body', 'request body must be valid JSON');
    }
    const { namespace, type, field, values } = body;
    if (typeof namespace !== 'string' || typeof type !== 'string' || typeof field !== 'string') {
      return badRequest('invalid_params', 'namespace, type and field are required strings');
    }
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      return badRequest('invalid_params', '`values` must be an object of row id -> value');
    }
    const entries = Object.entries(values as Record<string, unknown>);
    if (entries.length === 0) return badRequest('invalid_params', '`values` is empty');
    if (entries.length > BACKFILL_MAX_ROWS) {
      return badRequest('too_many_rows', `at most ${BACKFILL_MAX_ROWS} rows per request`);
    }
    if (namespace === SYSTEM_NAMESPACE) {
      return jsonResponse(403, {
        code: 'forbidden_namespace',
        message: '_system cannot be backfilled'
      });
    }
    const apply = body.apply === true;
    const overwrite = body.overwrite === true;

    const dataset = deps.resolveDataset(namespace);
    if (dataset === null) {
      return jsonResponse(404, {
        code: 'unknown_namespace',
        message: `no namespace '${namespace}'`
      });
    }
    const def = deps.schemaFor(namespace)?.types[type]?.fields[field] as FieldDef | undefined;
    if (def === undefined) {
      return jsonResponse(404, {
        code: 'unknown_field',
        message: `${namespace}/${type} has no field '${field}'`
      });
    }
    if (def.kind !== 'scalar' || def.readonly === true) {
      return badRequest('not_backfillable', `${type}.${field} is not a writable scalar`);
    }

    // Validate every value BEFORE reading anything: a bad map is an authoring error.
    const target = new Map<string, unknown>();
    const invalid: Array<{ id: string; value: unknown; reason: string }> = [];
    for (const [id, raw] of entries) {
      if (raw === null) {
        if (def.nullable === true) target.set(id, null);
        else invalid.push({ id, value: raw, reason: 'field is not nullable' });
        continue;
      }
      const value = canonicalVocabValue(def, raw);
      if (typeof value !== SCALAR_TYPEOF[def.type]) {
        invalid.push({ id, value: raw, reason: `expected ${def.type}` });
      } else if (
        def.enum !== undefined &&
        def.strict !== false &&
        !def.enum.includes(value as string)
      ) {
        invalid.push({ id, value: raw, reason: `not in ${def.enum.join(', ')}` });
      } else target.set(id, value);
    }
    if (invalid.length > 0) {
      return badRequest('invalid_values', `${invalid.length} value(s) cannot be written`, {
        invalid: invalid.slice(0, 50)
      });
    }

    // Read current state: which rows exist, which already hold a value.
    const ids = [...target.keys()];
    const current = new Map<string, Row>();
    for (let i = 0; i < ids.length; i += BATCH) {
      for (const r of (await dataset.read(type, { ids: ids.slice(i, i + BATCH) })).rows) {
        current.set(String(r.id), r);
      }
    }
    const missing = ids.filter((id) => !current.has(id)).sort();
    const kept: string[] = [];
    const unchanged: string[] = [];
    const toWrite: string[] = [];
    for (const id of ids) {
      const row = current.get(id);
      if (row === undefined) continue;
      const existing = row[field];
      if (existing === target.get(id)) unchanged.push(id);
      else if (existing !== null && existing !== undefined && !overwrite) kept.push(id);
      else toWrite.push(id);
    }
    const counts: Record<string, number> = {};
    for (const id of toWrite) {
      const key = String(target.get(id));
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const summary = {
      namespace,
      type,
      field,
      requested: ids.length,
      write: toWrite.length,
      counts,
      missing,
      kept: kept.length,
      unchanged: unchanged.length
    };
    if (!apply) return jsonResponse(200, { ...summary, applied: false });

    for (let i = 0; i < toWrite.length; i += BATCH) {
      await dataset.write(
        type,
        toWrite.slice(i, i + BATCH).map((id) => {
          const meta = current.get(id)?._metadata;
          return (
            meta === undefined
              ? { id, [field]: target.get(id) }
              : { id, [field]: target.get(id), _metadata: meta }
          ) as Row;
        })
      );
    }

    // Verify: every written row now holds exactly its target.
    const wrong: string[] = [];
    for (let i = 0; i < toWrite.length; i += BATCH) {
      for (const r of (await dataset.read(type, { ids: toWrite.slice(i, i + BATCH) })).rows) {
        if (r[field] !== target.get(String(r.id))) wrong.push(String(r.id));
      }
    }
    if (wrong.length > 0) {
      return jsonResponse(500, {
        code: 'verify_failed',
        message: `${wrong.length} row(s) do not hold their target after the write`,
        ids: wrong.slice(0, 50)
      });
    }

    const actorKid = typeof req.identity?.kid === 'string' ? req.identity.kid : 'unknown';
    const now = deps.now();
    const substrateDs = deps.resolveDataset(SYSTEM_NAMESPACE);
    if (substrateDs !== null && toWrite.length > 0) {
      await substrateDs.write(
        AUDIT_EVENT_TYPE,
        [
          buildAuditRow({
            actorKid,
            kind: 'field_backfilled',
            targetKid: undefined,
            clientIp: extractClientIp(req, proxySet) ?? undefined,
            details: {
              namespace,
              type,
              field,
              written: toWrite.length,
              counts,
              overwrite,
              ids: toWrite.slice(0, AUDIT_ID_LIMIT),
              idsTruncated: toWrite.length > AUDIT_ID_LIMIT
            },
            now
          })
        ],
        { identity: { kind: 'agent', id: actorKid }, now }
      );
    }
    return jsonResponse(200, { ...summary, applied: true });
  };
}
