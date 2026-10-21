/**
 * Per-namespace capability grants (spec §5): a namespace → capabilities map.
 *
 * A flat `(namespaces × capabilities)` grant must expand and intersect exactly
 * as the two independent list intersections did, since stored keys are flat;
 * `test/_system/grant.test.ts` asserts that equivalence.
 *
 * Stored in the comma-separated `Key.namespaces` column as entries like
 * `notes:read` or `tasks:read+mutate`. `+` separates capabilities because `,`
 * is taken by the column and `:` by the namespace separator.
 */

/** A namespace → capabilities map. `'*'` is a legal key: the wildcard grant. */
export type Grant = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * The capabilities this grant confers in `ns`.
 *
 * An EXPLICIT entry beats the wildcard, which is what makes
 * `--ns '*:read,tasks:read+mutate'` mean the obvious thing — read everywhere,
 * and also write tasks — rather than being ambiguous about which entry wins.
 */
export function capabilitiesFor(grant: Grant, ns: string): ReadonlySet<string> {
  return grant.get(ns) ?? grant.get('*') ?? new Set<string>();
}

/** The flat form, expanded. This is the cross product, stated as a map. */
export function expandFlat(namespaces: readonly string[], capabilities: readonly string[]): Grant {
  const caps = new Set(capabilities);
  const out = new Map<string, ReadonlySet<string>>();
  for (const ns of namespaces) out.set(ns, caps);
  return out;
}

/**
 * Parses the CLI/route entry list. An entry without `:` takes
 * `defaultCapabilities`, so a bare `--ns notes` keeps its flat meaning.
 *
 * @throws Error naming the entry when one has an empty namespace or no
 *   capabilities.
 */
export function parseGrantEntries(
  entries: readonly string[],
  defaultCapabilities: readonly string[]
): Grant {
  const out = new Map<string, ReadonlySet<string>>();
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    const colon = entry.indexOf(':');
    if (colon === -1) {
      out.set(entry, new Set(defaultCapabilities));
      continue;
    }
    const ns = entry.slice(0, colon).trim();
    const caps = entry
      .slice(colon + 1)
      .split('+')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (ns.length === 0 || caps.length === 0) {
      // A grant that names no capability is not a narrower grant, it is an
      // unreadable one — and defaulting it would silently re-widen exactly what
      // the caller was trying to narrow.
      throw new Error(
        `invalid grant entry '${entry}': expected '<namespace>' or '<namespace>:<cap>[+<cap>...]'`
      );
    }
    out.set(ns, new Set(caps));
  }
  return out;
}

/**
 * The reason this entry list will not parse, or `null` when it will.
 *
 * Validates by calling {@link parseGrantEntries} so the rules cannot drift
 * from the parser. The message is the parser's own and carries no fix
 * instruction; each caller appends its own vocabulary.
 */
export function grantEntryError(
  entries: readonly string[],
  defaultCapabilities: readonly string[]
): string | null {
  try {
    parseGrantEntries(entries, defaultCapabilities);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Back to entry form for storage. An entry whose capabilities equal
 * `defaultCapabilities` emits BARE, so a flat grant round-trips to the exact
 * csv it came from and an operator reading `substrate-admin list` sees no new
 * syntax until someone actually uses it.
 */
export function encodeGrant(grant: Grant, defaultCapabilities: readonly string[]): string[] {
  const dflt = new Set(defaultCapabilities);
  const out: string[] = [];
  for (const [ns, caps] of grant) {
    out.push(sameSet(caps, dflt) ? ns : `${ns}:${[...caps].sort().join('+')}`);
  }
  return out;
}

/**
 * Claim ∩ row, per namespace.
 *
 * A wildcard claim (`ns: ['*']`, what agent tokens send) yields the row's
 * grant, via `capabilitiesFor` resolving `'*'` for every namespace the row
 * names.
 */
export function intersectGrants(claim: Grant, row: Grant): Grant {
  const keys = new Set<string>([...claim.keys(), ...row.keys()]);
  const out = new Map<string, ReadonlySet<string>>();
  const emptied: string[] = [];
  for (const ns of keys) {
    const claimed = capabilitiesFor(claim, ns);
    const allowed = capabilitiesFor(row, ns);
    const caps = new Set<string>();
    for (const c of claimed) if (allowed.has(c)) caps.add(c);
    // A namespace that resolves to no capability is not granted; keeping it
    // would render reach the holder does not have (§8.1).
    if (caps.size > 0) out.set(ns, caps);
    else if (ns !== '*') emptied.push(ns);
  }
  // ...unless the result holds a wildcard. Then an absent entry would fall back to '*' in
  // capabilitiesFor and hand the namespace the wildcard's reach — so a holder whose row says
  // `*:read+mutate,notes:read` could claim just `mutate` and write notes. An explicit
  // empty entry shadows the wildcard; flattenGrant leaves it out of the namespaces it lists.
  if (out.has('*')) for (const ns of emptied) out.set(ns, new Set<string>());
  return out;
}

/**
 * The flat compatibility view.
 *
 * `namespaces` is every namespace held at ANY level (§8.1) and
 * `capabilities` is the UNION — which is what `withAuth`'s any-namespace
 * pre-check needs. It is deliberately NOT the answer to "what am I granted";
 * `grant` is. Consumers that render this to a human must consult
 * {@link grantIsUniform} first.
 */
export function flattenGrant(grant: Grant): { namespaces: string[]; capabilities: string[] } {
  const capabilities = new Set<string>();
  for (const caps of grant.values()) for (const c of caps) capabilities.add(c);
  // An empty entry is a shadow over the wildcard (see intersectGrants), not a namespace held.
  const namespaces = [...grant].filter(([, caps]) => caps.size > 0).map(([ns]) => ns);
  return { namespaces, capabilities: [...capabilities] };
}

/**
 * Does every namespace in this grant carry the same capabilities?
 *
 * When false, no single flat capability list is honest, and §8.1 renders
 * `null` rather than picking one.
 */
export function grantIsUniform(grant: Grant): boolean {
  let first: ReadonlySet<string> | undefined;
  for (const caps of grant.values()) {
    if (first === undefined) {
      first = caps;
      continue;
    }
    if (!sameSet(first, caps)) return false;
  }
  return true;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
