/**
 * `POST /substrate/v1/_system/normalise-vocab` — rewrite stored values of a governed
 * vocabulary field to their canonical form, using the field's own alias table.
 *
 * Dry run by default: returns the plan (alias -> canonical, with counts) and
 * the values no alias explains. `apply: true` runs scan -> apply -> verify
 * through the value-map migration's raw dataset writes, which leave
 * `updatedAt` alone: a normalisation is not an edit, and bumping it would
 * make every rewritten row look recently changed. On a strict field, an
 * unmapped value must be listed in `reject` (knowingly left as is) before
 * anything is written.
 */

import type {
  Dataset,
  FieldDef,
  HttpHandler,
  Schema,
  SubstrateResponse
} from '@mnmal-ai/substrate-types';
import { canonicalVocabValue } from '@mnmal-ai/substrate-types';
import { extractClientIp, jsonResponse } from '../routes/helpers.js';
import { AUDIT_ID_LIMIT } from './backfill-field.js';
import { buildAuditRow } from './install.js';
import { AUDIT_EVENT_TYPE, SYSTEM_NAMESPACE } from './types.js';
import { migrateFieldValues, scanNonconforming, type ValueMap } from './value-map-migration.js';

export interface NormaliseVocabRouteDeps {
  resolveDataset: (namespace: string) => Dataset | null;
  schemaFor: (namespace: string) => Schema | null;
  now: () => Date;
  trustedProxies: string[] | Set<string>;
}

const badRequest = (code: string, message: string): SubstrateResponse =>
  jsonResponse(400, { code, message });

export function normaliseVocabRoute(deps: NormaliseVocabRouteDeps): HttpHandler {
  const proxySet =
    deps.trustedProxies instanceof Set ? deps.trustedProxies : new Set(deps.trustedProxies);
  return async (req) => {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(req.body?.toString('utf8') ?? '') as Record<string, unknown>;
    } catch {
      return badRequest('invalid_body', 'request body must be valid JSON');
    }
    const { namespace, type, field } = body;
    if (typeof namespace !== 'string' || typeof type !== 'string' || typeof field !== 'string') {
      return badRequest('invalid_params', 'namespace, type and field are required strings');
    }
    const reject = Array.isArray(body.reject)
      ? body.reject.filter((v): v is string => typeof v === 'string')
      : [];
    if (namespace === SYSTEM_NAMESPACE) {
      return jsonResponse(403, {
        code: 'forbidden_namespace',
        message: '_system cannot be normalised'
      });
    }
    const apply = body.apply === true;

    const dataset = deps.resolveDataset(namespace);
    const def = deps.schemaFor(namespace)?.types[type]?.fields[field] as FieldDef | undefined;
    if (dataset === null)
      return jsonResponse(404, {
        code: 'unknown_namespace',
        message: `no namespace '${namespace}'`
      });
    if (def === undefined)
      return jsonResponse(404, {
        code: 'unknown_field',
        message: `${namespace}/${type} has no field '${field}'`
      });
    if (def.kind !== 'scalar' || def.enum === undefined) {
      return badRequest('not_a_vocabulary', `${type}.${field} declares no vocabulary`);
    }
    const strict = def.strict !== false;
    const vocabulary = def.enum;

    // Every stored value outside the vocabulary, sorted by alias-derivable or not.
    const scan = await scanNonconforming({ dataset, namespace, type, field, vocabulary });
    const plan: Array<{ from: string; to: string; count: number }> = [];
    const unmapped: Array<{ value: string; count: number }> = [];
    const admitted: string[] = [];
    for (const o of [...scan.offenders].sort((a, b) =>
      a.value < b.value ? -1 : a.value > b.value ? 1 : 0
    )) {
      const target = canonicalVocabValue(def, o.value);
      if (typeof target === 'string' && target !== o.value && vocabulary.includes(target)) {
        plan.push({ from: o.value, to: target, count: o.count });
      } else if (strict) {
        unmapped.push({ value: o.value, count: o.count });
      } else {
        admitted.push(o.value);
      }
    }
    const summary = {
      namespace,
      type,
      field,
      strict,
      scanned: scan.rowsScanned,
      truncated: scan.truncated,
      plan,
      unmapped
    };
    if (!apply) return jsonResponse(200, { ...summary, applied: false });

    const unrejected = unmapped.filter((u) => !reject.includes(u.value));
    if (unrejected.length > 0) {
      return jsonResponse(409, {
        code: 'unmapped_values',
        message:
          `${unrejected.length} stored value(s) match no alias. Add an alias, widen the vocabulary, ` +
          'or list them in `reject` to leave them as they are.',
        unmapped: unrejected
      });
    }

    const valueMap: ValueMap = Object.fromEntries([
      ...plan.map((p) => [p.from, p.to] as const),
      ...unmapped.map((u) => [u.value, null] as const)
    ]);
    // A non-strict field admits unknown values, so they are not offenders here.
    const result = await migrateFieldValues(
      { dataset, namespace, type, field, vocabulary: [...vocabulary, ...admitted] },
      valueMap,
      { oldVocabulary: strict ? vocabulary : null, preserveMetadata: true }
    );

    const byValue = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const migrated = [...result.migrated].sort((a, b) => byValue(a.from, b.from));
    const stranded = [...result.stranded].sort((a, b) => byValue(a.value, b.value));
    const actorKid = typeof req.identity?.kid === 'string' ? req.identity.kid : 'unknown';
    const now = deps.now();
    const substrateDs = deps.resolveDataset(SYSTEM_NAMESPACE);
    if (substrateDs !== null && migrated.length > 0) {
      await substrateDs.write(
        AUDIT_EVENT_TYPE,
        [
          buildAuditRow({
            actorKid,
            kind: 'vocab_normalised',
            targetKid: undefined,
            clientIp: extractClientIp(req, proxySet) ?? undefined,
            details: {
              namespace,
              type,
              field,
              migrated,
              stranded,
              ids: result.ids.slice(0, AUDIT_ID_LIMIT),
              idsTruncated: result.ids.length > AUDIT_ID_LIMIT
            },
            now
          })
        ],
        { identity: { kind: 'agent', id: actorKid }, now }
      );
    }
    return jsonResponse(200, {
      ...summary,
      applied: true,
      migrated,
      stranded,
      unmapped: strict ? unmapped : []
    });
  };
}
