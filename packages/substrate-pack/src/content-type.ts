/**
 * Content-type negotiation. Spec: §7.0.
 *
 * A request that advertises `Accept: application/vnd.substrate.pack` gets the binary
 * envelope; anything else falls back to JSON. We deliberately skip RFC 7231
 * q-value ranking — the useful scenarios are exact match, the `; q=…` form,
 * and comma-separated clauses. A real parser is overkill for a single-mime
 * negotiation.
 */

export const PACK_MIME = 'application/vnd.substrate.pack';

export function acceptsPack(acceptHeader: string | undefined): boolean {
  if (acceptHeader === undefined || acceptHeader.length === 0) return false;
  // Split on comma so `application/json, application/vnd.substrate.pack` works.
  for (const rawClause of acceptHeader.split(',')) {
    const clause = rawClause.trim();
    if (clause.length === 0) continue;
    // Strip params (e.g. `application/vnd.substrate.pack; q=1.0`).
    const semi = clause.indexOf(';');
    const mime = (semi === -1 ? clause : clause.slice(0, semi)).trim();
    if (mime === PACK_MIME) return true;
  }
  return false;
}
