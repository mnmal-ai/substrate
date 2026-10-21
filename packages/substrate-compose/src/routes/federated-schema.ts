/**
 * GET /substrate/v1/federated-schema — return the full federated schema view
 * (§4.7). Shape: `Record<ns, Schema>`. Clients that drive multi-ns
 * frames call this at cold-start to build their `nsIndex` map.
 *
 * Plus, when the caller may read them, enum verification verdicts under the
 * `_enumVerdicts` key: per-field {@link EnumVerdictView} from
 * `_system/EnumCheckVerdict` rows.
 */

import type { Engine } from '@mnmal-ai/substrate-core';
import { grantedIn, grantOf, type HttpHandler, type Row } from '@mnmal-ai/substrate-types';
import { buildContext, jsonResponse } from './helpers.js';

/** One field's verification state, as surfaced alongside the schema. */
export interface EnumVerdictView {
  /** ISO-8601 of the check run. Consumers judge staleness; the server does not expire. */
  checkedAt: string;
  /** sha256 of the vocabulary the run checked — a vocab edit invalidates structurally. */
  vocabHash: string;
  /** Rows scanned. */
  rowsScanned: number;
  /** Distinct stored values outside the vocabulary. 0 + truncated:false is the clean verdict. */
  outlierCount: number;
  /** True when the run stopped at maxRows — counts are a floor. */
  truncated: boolean;
}

export function federatedSchemaRoute(
  engine: Engine,
  trustedProxies?: Set<string>,
  authEnabled?: boolean
): HttpHandler {
  return async (req) => {
    const schema = engine.federatedSchema();
    const verdicts = await readVerdicts(engine, req, trustedProxies, authEnabled);
    if (verdicts === null) return jsonResponse(200, schema);
    return jsonResponse(200, { ...schema, _enumVerdicts: verdicts });
  };
}

/**
 * Best-effort verdict join. Returns null (key omitted) whenever the verdicts
 * cannot be read — refused policy, missing type, transport error. Absent key
 * is UNKNOWN, never "unverified": the caller may simply lack `_system` read,
 * and an anonymous schema fetch must not render every enum as suspect.
 */
async function readVerdicts(
  engine: Engine,
  req: Parameters<HttpHandler>[0],
  trustedProxies: Set<string> | undefined,
  authEnabled: boolean | undefined
): Promise<Record<string, EnumVerdictView> | null> {
  // Don't probe for a caller whose grant is certain to be refused: the engine records every
  // refused frame in /substrate/v1/errors, so each fresh non-admin client logged one. A caller
  // with no grant at all is still asked, since how that resolves is the engine's call.
  const grant = grantOf(req.identity);
  if (grant !== null && !grantedIn(grant, '_system').includes('read')) return null;
  try {
    const envelope = await engine.query({
      frame: {
        '_system/EnumCheckVerdict': {
          params: { limit: 500 },
          fields: {
            namespace: true,
            type: true,
            field: true,
            vocabHash: true,
            checkedAt: true,
            rowsScanned: true,
            outlierCount: true,
            truncated: true
          }
        }
      },
      ctx: buildContext(req, trustedProxies ?? new Set(), authEnabled)
    });
    const data = (envelope as { data?: Record<string, unknown> }).data?.[
      '_system/EnumCheckVerdict'
    ];
    if (!Array.isArray(data)) return null;
    const out: Record<string, EnumVerdictView> = {};
    for (const row of data as Row[]) {
      if (
        typeof row.namespace !== 'string' ||
        typeof row.type !== 'string' ||
        typeof row.field !== 'string' ||
        typeof row.vocabHash !== 'string' ||
        typeof row.checkedAt !== 'string' ||
        typeof row.rowsScanned !== 'number' ||
        typeof row.outlierCount !== 'number' ||
        typeof row.truncated !== 'boolean'
      ) {
        continue;
      }
      out[`${row.namespace}/${row.type}.${row.field}`] = {
        checkedAt: row.checkedAt,
        vocabHash: row.vocabHash,
        rowsScanned: row.rowsScanned,
        outlierCount: row.outlierCount,
        truncated: row.truncated
      };
    }
    return out;
  } catch {
    return null;
  }
}
