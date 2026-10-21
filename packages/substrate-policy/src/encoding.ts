/**
 * Comma-separated string-list encoding. Spec §5.12.
 *
 * The `_system` namespace stores `Key.namespaces`, `Key.capabilities`,
 * `Invite.namespaces`, and `Invite.capabilities` as comma-separated
 * scalar strings rather than list-typed fields. The two helpers below are the
 * only allowed encode/decode path — use sites must NOT hand-roll `.split(',')`
 * because the empty-input → `[]` rule lives here.
 */

/**
 * Canonicalise a string array for persistence. Trims each entry, rejects
 * embedded commas (no quoting in the substrate column), and joins with `,`.
 * Empty input returns `''` — keeping the column non-null and trivially
 * round-trippable through `decodeList`.
 */
export function encodeList(items: Array<string>): string {
  const out: Array<string> = [];
  for (const raw of items) {
    const item = raw.trim();
    if (item.length === 0) continue;
    if (item.includes(',')) {
      throw new Error(
        `encodeList: item '${item}' contains a comma — embedded commas are not supported`
      );
    }
    out.push(item);
  }
  return out.join(',');
}

/**
 * Inverse of `encodeList`. Accepts the stored scalar (possibly `''` for an
 * empty list), splits on `,`, trims, drops empties. Non-string inputs — the
 * dataset shouldn't emit these, but defence-in-depth — yield `[]`.
 */
export function decodeList(raw: unknown): Array<string> {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const out: Array<string> = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}
