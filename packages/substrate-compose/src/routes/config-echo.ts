/**
 * `GET /substrate/v1/config` — the effective value of every defaulted knob, and
 * whether it came from the operator or from the default. The environment is
 * only the input; this reports what the process resolved it to.
 *
 * Admin-gated: the report maps the deployment. Secret-valued knobs never carry
 * their value — they report `redacted: true` with `value: '<set>'` or `null`.
 * Flat and sorted so two hosts' reports can be compared with `diff`.
 */

import type { HttpHandler, StorageReport, SubstrateRequest } from '@mnmal-ai/substrate-types';
import { jsonResponse } from './helpers.js';

/**
 * Where a knob's effective value came from. `explicit` means the operator set
 * the variable to a non-empty value; everything else — unset, empty string,
 * whitespace-only — is `default`, because that is how the parsers treat it
 * (docker-compose's `${VAR:-}` substitution produces an empty string, and
 * reading that as "operator chose this" is how a knob silently becomes NaN).
 */
export type KnobSource = 'default' | 'explicit';

export interface KnobReport {
  /** The environment variable that sets this knob, e.g. `SUBSTRATE_SWEEP_INTERVAL_MS`. */
  env: string;
  /**
   * The EFFECTIVE value after parsing — not the raw string. `null` means the
   * knob resolves to off/absent, which is a real answer and distinct from the
   * knob being unreported.
   */
  value: string | number | boolean | null;
  source: KnobSource;
  /**
   * Present and `true` only for secret-valued knobs, whose `value` is
   * `'<set>'` or `null` rather than the secret. Flagged rather than omitted so
   * a reader can tell "this is hidden" from "this is genuinely unset".
   */
  redacted?: true;
}

/** Keyed by the `ParsedConfig` field name the knob resolves to. */
export type ConfigReport = Record<string, KnobReport>;

/**
 * Pure handler. Sorted by key so two hosts' reports diff cleanly rather than
 * differing by whatever order the parsers happened to run in.
 */
export function handleConfigRequest(report: ConfigReport): { knobs: ConfigReport } {
  const sorted: ConfigReport = {};
  for (const key of Object.keys(report).sort()) {
    sorted[key] = report[key] as KnobReport;
  }
  return { knobs: sorted };
}

/**
 * Route handler factory. Pass to `gate(configRouteHandler(report), 'admin')`
 * in compose so it inherits the same treatment as `/substrate/v1/_system/invites`.
 */
export function configRouteHandler(
  report: ConfigReport,
  storage?: () => Promise<StorageReport>
): HttpHandler {
  return async (_req: SubstrateRequest) =>
    jsonResponse(200, {
      ...handleConfigRequest(report),
      ...(storage !== undefined ? { storage: await storage() } : {})
    });
}
