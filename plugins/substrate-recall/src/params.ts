/**
 * Unknown-parameter refusal, shared by every recall surface. Each surface keeps
 * its own allowed set (the frame spells the search text `to`, the route
 * `query`); the refusal logic is shared.
 *
 * Refused rather than dropped: a silently ignored flag is indistinguishable
 * from one that ran and did nothing.
 */

/** Keys present on `obj` that are not in `allowed`, in the caller's order. */
export function unknownParams(
  obj: Record<string, unknown>,
  allowed: ReadonlyArray<string>
): string[] {
  const ok = new Set(allowed);
  return Object.keys(obj).filter((key) => !ok.has(key));
}

/**
 * The refusal text. Names both the offending keys and the allowed set, the
 * latter generated from the array the parser uses.
 */
export function unknownParamMessage(
  unknown: ReadonlyArray<string>,
  allowed: ReadonlyArray<string>
): string {
  const plural = unknown.length === 1 ? 'parameter' : 'parameters';
  return (
    `unknown ${plural}: ${unknown.join(', ')}. ` +
    `This surface accepts: ${[...allowed].sort().join(', ')}. ` +
    'Unknown parameters are refused rather than ignored: a silently dropped ' +
    'flag is indistinguishable from one that ran and did nothing.'
  );
}

/** `null` when every key is known, otherwise the refusal text. */
export function checkParams(
  obj: Record<string, unknown>,
  allowed: ReadonlyArray<string>
): string | null {
  const unknown = unknownParams(obj, allowed);
  return unknown.length === 0 ? null : unknownParamMessage(unknown, allowed);
}
