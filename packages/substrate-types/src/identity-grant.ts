/**
 * The single resolver for "what is this identity granted", read from
 * `Identity.grants`. Do not hand-roll another reader of `grants`; route every
 * gate through these helpers so they cannot disagree.
 *
 * A `null` grant means the identity makes NO CLAIM, which the two gates read
 * in opposite directions:
 *
 *     engine per-frame gate   no claim -> PASS. Direct-call tests and system
 *                             actors reach resolvers with a bare `{ id }`, and
 *                             the route wrapper is authoritative for HTTP.
 *     route gate              no claim -> REFUSE. A caller that presented a
 *                             token conferring nothing gets nothing.
 *
 * Do not replace `null` with an empty grant (would REFUSE every no-claim
 * caller) or a wildcard grant (would invent authority).
 */

/** A resolved grant: namespace -> capabilities. `'*'` is a legal key. */
export type IdentityGrant = Record<string, string[]>;

/** The shape this reads; structural so this module need not import `Identity`. */
interface GrantBearing {
  grants?: unknown;
}

function stringsOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * The grant this identity carries, or `null` when it claims nothing (no
 * identity, or `grants` absent or not an object — e.g. a bare `{ id }`).
 *
 * An array `grants` passes the `typeof` check and resolves to a table with no
 * real namespace in it, which refuses: fail-closed on malformed data.
 * Non-string capability entries are dropped.
 */
export function grantOf(identity: GrantBearing | null | undefined): IdentityGrant | null {
  if (identity === null || identity === undefined) return null;

  const grants = identity.grants;
  if (grants !== null && grants !== undefined && typeof grants === 'object') {
    // No prototype: a namespace named `constructor` or `__proto__` is data here,
    // never an inherited member or the prototype setter.
    const out: IdentityGrant = Object.create(null);
    for (const [ns, caps] of Object.entries(grants as Record<string, unknown>)) {
      out[ns] = stringsOf(caps) ?? [];
    }
    return out;
  }
  return null;
}

/** An OWN entry only: a grant built as a plain object literal still inherits `toString`. */
function entry(resolved: IdentityGrant, ns: string): string[] | undefined {
  return Object.hasOwn(resolved, ns) ? resolved[ns] : undefined;
}

/**
 * Capabilities conferred in `ns` — explicit entry, else the wildcard.
 *
 * Restates `@mnmal-ai/substrate-policy`'s `grant.ts` `capabilitiesFor` at the zero-dep layer;
 * substrate-policy's `test/grant-parity.test.ts` pins the two to identical verdicts.
 */
export function grantedIn(resolved: IdentityGrant | null, ns: string): string[] {
  if (resolved === null) return [];
  return entry(resolved, ns) ?? entry(resolved, '*') ?? [];
}

/** Does the grant name `ns` at all, explicitly or by wildcard? */
export function coversNamespace(resolved: IdentityGrant | null, ns: string): boolean {
  if (resolved === null) return false;
  return entry(resolved, ns) !== undefined || entry(resolved, '*') !== undefined;
}

/** A per-frame grant check's verdict, naming which dimension refused. */
/**
 * True when the identity holds `capability` in every namespace: a `*` entry
 * holding it that no explicit entry narrows. An explicit entry beats the
 * wildcard, so `*` alone does not answer for a namespace the grant also names.
 */
export function holdsEverywhere(
  identity: GrantBearing | null | undefined,
  capability: string
): boolean {
  const resolved = grantOf(identity);
  if (resolved === null || !Object.hasOwn(resolved, '*')) return false;
  return Object.keys(resolved).every((ns) => resolved[ns]?.includes(capability));
}

/**
 * True when the identity may read every namespace: no grant claim at all, or
 * `read` held everywhere.
 */
export function readsEveryNamespace(identity: GrantBearing | null | undefined): boolean {
  return grantOf(identity) === null || holdsEverywhere(identity, 'read');
}

export type GrantVerdict =
  | { ok: true }
  | { ok: false; reason: 'namespace' | 'capability'; required?: string };

/**
 * Per-frame authorisation gate (§5.12): checks that `identity`'s grant covers
 * `ns` AND allows `operation` there (`mutate` needs `mutate`; everything else
 * needs `read`). Returns which dimension failed.
 *
 * An absent identity, or one with no grant (a bare `{ id }`), passes: those
 * are direct-call tests and system actors. So an authenticator must give every
 * remote caller a `grants` object (`{}` for none), or that caller reaches
 * every namespace on transports that rely on this gate.
 */
export function checkIdentityGrant(
  identity: GrantBearing | null | undefined,
  ns: string,
  operation: 'query' | 'mutate' | 'subscribe' | 'stream'
): GrantVerdict {
  if (identity === null || identity === undefined) return { ok: true };

  // `null` is the no-claim population and PASSES; fabricating an empty grant
  // instead would refuse every direct-call test and system actor.
  const resolved = grantOf(identity);
  if (resolved === null) return { ok: true };

  // An explicit entry beats the wildcard — the resolution `grantedIn` shares
  // with `coversNamespace`, so the two cannot disagree about what a grant means.
  if (!coversNamespace(resolved, ns)) return { ok: false, reason: 'namespace' };

  // `mutate` is the only writing operation; subscribe and stream are reads, the
  // same mapping the route layer applies by method.
  const required = operation === 'mutate' ? 'mutate' : 'read';
  return grantedIn(resolved, ns).includes(required)
    ? { ok: true }
    : { ok: false, reason: 'capability', required };
}

/**
 * Refusal prose for a {@link checkIdentityGrant} refusal. A missing namespace
 * and a namespace narrowed to the wrong capability are different operator
 * problems, so they get different messages.
 */
export function grantRefusal(
  ns: string,
  verdict: { reason: 'namespace' | 'capability'; required?: string }
): string {
  return verdict.reason === 'capability'
    ? `identity's grant for namespace '${ns}' does not include '${verdict.required ?? 'the required capability'}'`
    : `namespace '${ns}' not in identity's allowed namespaces`;
}

/** Error code for a grant refusal: `unauthorized_capability` or `unauthorized_namespace`. */
export function grantRefusalCode(verdict: {
  reason: 'namespace' | 'capability';
}): 'unauthorized_capability' | 'unauthorized_namespace' {
  return verdict.reason === 'capability' ? 'unauthorized_capability' : 'unauthorized_namespace';
}

/**
 * Is `capability` conferred in ANY namespace?
 *
 * Only for the route gate, which runs before any frame is parsed and so has
 * no namespace. For "what am I granted in `ns`", use `grantedIn`.
 */
export function confersAnywhere(resolved: IdentityGrant | null, capability: string): boolean {
  if (resolved === null) return false;
  for (const caps of Object.values(resolved)) if (caps.includes(capability)) return true;
  return false;
}

/** Every capability conferred anywhere — the union, for error messages only. */
export function allCapabilities(resolved: IdentityGrant | null): string[] {
  return resolved === null ? [] : [...new Set(Object.values(resolved).flat())];
}
