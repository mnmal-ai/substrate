import {
  decodeList,
  describeGrant,
  encodeGrant,
  flattenGrant,
  type Grant,
  parseGrantEntries
} from '@mnmal-ai/substrate/client';

const SHORT: Readonly<Record<string, string>> = { read: 'r', mutate: 'm', admin: 'a' };

/** The legend for {@link compactGrant}'s short forms, one per entry of `SHORT`. */
export const GRANT_LEGEND = Object.entries(SHORT)
  .map(([cap, s]) => `${s}=${cap}`)
  .join(' · ');

const CANONICAL = Object.keys(SHORT);

/** read, mutate, admin, then any other capability alphabetically: one order wherever a grant is shown or sent. */
function canonicalCaps(caps: Iterable<string>): string[] {
  const rank = (c: string) => {
    const i = CANONICAL.indexOf(c);
    return i < 0 ? CANONICAL.length : i;
  };
  return [...caps].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * One cell for the key table: `journal:r+m,*:r+m+a`. A capability without a short form stays
 * spelled out. Like `describeGrant` it is total: an unparseable grant renders as its description.
 */
export function compactGrant(namespaces: string, capabilities: string): string {
  let grant: ReadonlyMap<string, ReadonlySet<string>>;
  try {
    grant = parseGrantEntries(decodeList(namespaces), decodeList(capabilities));
  } catch {
    return describeGrant(namespaces, capabilities).join(' ');
  }
  if (grant.size === 0) return '(none)';
  return [...grant]
    .map(
      ([ns, caps]) =>
        `${ns}:${canonicalCaps(caps)
          .map((c) => SHORT[c] ?? c)
          .join('+')}`
    )
    .join(',');
}

/** A stored row's grant, or null when it does not parse (the table still renders it). */
export function rowGrant(row: { namespaces: string; capabilities: string }): Grant | null {
  try {
    return parseGrantEntries(decodeList(row.namespaces), decodeList(row.capabilities));
  } catch {
    return null;
  }
}

/** The request form: the capability union as the default, so a bare entry reads back as it. */
export function toWire(grant: Grant): { namespaces: string[]; capabilities: string[] } {
  const capabilities = canonicalCaps(flattenGrant(grant).capabilities);
  return { namespaces: encodeGrant(grant, capabilities), capabilities };
}

/**
 * The namespaces a `GET /substrate/v1/federated-schema` response hosts. The route adds one key that is
 * not a namespace, `_enumVerdicts`, for a caller who can read `_system`; the server judges
 * unhosted names against the schema without it, so this does too.
 */
export function hostedNamespaces(schema: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(schema).filter((k) => k !== '_enumVerdicts');
}
