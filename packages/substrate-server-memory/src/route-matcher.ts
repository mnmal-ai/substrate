/**
 * Pure path-pattern matcher used by `MemorySubstrateServer`.
 *
 * Supported syntax:
 *   - Literal segments: `/foo/bar`
 *   - Named captures: `/users/:id` → params.id
 *   - Trailing wildcard: `/files/*` → params.rest (captures joined tail, may be empty)
 *
 * Design calls:
 *   - Matching is exact on segment count unless the last registered segment is `*`.
 *   - Trailing slash is significant. `/foo` does not match `/foo/`, and vice-versa.
 *     Networked servers normalise this in their own idiomatic way; keeping the
 *     matcher strict makes test assertions unambiguous.
 *   - The matcher does NOT strip or parse querystrings. Callers pre-strip.
 *   - The matcher does NOT decode URI components. Tests that need encoded values
 *     can assert against the raw bytes; decoding is a per-caller policy.
 */

/**
 * @internal — used by `MemorySubstrateServer.inject` for path-pattern matching.
 * Treat as package-private.
 */
export function matchRoute(registered: string, actual: string): Record<string, string> | null {
  const regSegs = splitPath(registered);
  const actSegs = splitPath(actual);

  const lastReg = regSegs.length > 0 ? regSegs[regSegs.length - 1] : undefined;
  const hasWildcard = lastReg === '*';

  if (hasWildcard) {
    // Wildcard requires at least the literal prefix segments to match; the rest
    // collapses into `params.rest` (possibly empty).
    const prefixLen = regSegs.length - 1;
    if (actSegs.length < prefixLen) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < prefixLen; i++) {
      const r = regSegs[i];
      const a = actSegs[i];
      if (r === undefined || a === undefined) return null;
      const paramMatch = paramName(r);
      if (paramMatch !== null) {
        params[paramMatch] = a;
      } else if (r !== a) {
        return null;
      }
    }
    params.rest = actSegs.slice(prefixLen).join('/');
    return params;
  }

  if (regSegs.length !== actSegs.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < regSegs.length; i++) {
    const r = regSegs[i];
    const a = actSegs[i];
    if (r === undefined || a === undefined) return null;
    const paramMatch = paramName(r);
    if (paramMatch !== null) {
      params[paramMatch] = a;
    } else if (r !== a) {
      return null;
    }
  }
  return params;
}

function splitPath(p: string): string[] {
  // Preserve the trailing-slash distinction: '/foo/' becomes ['foo', ''].
  // Leading slash is stripped so '/' and '' are equivalent (root has zero segs).
  if (p === '' || p === '/') return [];
  const stripped = p.startsWith('/') ? p.slice(1) : p;
  return stripped.split('/');
}

function paramName(seg: string): string | null {
  if (seg.length >= 2 && seg.startsWith(':')) return seg.slice(1);
  return null;
}
