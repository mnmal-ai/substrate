/**
 * Policy primitives. Spec: §4.4.
 *
 * These are the leaf policies — they do not compose other policies. Combinators
 * (and/or/not) live in ./combinators.ts.
 */

import type { AutoCrudVerb, Policy } from '@mnmal-ai/substrate-types';
import { coversNamespace, grantOf } from '@mnmal-ai/substrate-types';

/**
 * Always allows. Useful as an explicit identity element for `and(...)` and as a
 * default for resolvers that have no access constraints.
 */
export function allowAll(): Policy {
  return () => ({ allow: true });
}

/**
 * Always denies. Reason defaults to `'denyAll'` when none is supplied so the
 * caller surface always has something to log.
 */
export function denyAll(reason?: string): Policy {
  const finalReason = reason ?? 'denyAll';
  return () => ({ allow: false, reason: finalReason });
}

/**
 * Returns a suffix for a no-identity refusal saying the deployment has auth
 * disabled, so the reader stops checking a credential that was never examined.
 *
 * Only appended when `authEnabled` is explicitly `false`: undefined means the
 * transport did not say, and a guess would point at the wrong layer.
 */
function authDisabledSuffix(authEnabled: boolean | undefined): string {
  return authEnabled === false
    ? ' — and this deployment has auth DISABLED, so no credential would have been accepted. Set SUBSTRATE_AUTH_MODE and restart; presenting a key changes nothing until you do.'
    : '';
}

/**
 * Allow when the request has a verified identity attached. The most common
 * minimum bar for authenticated resolvers; composes with role / rate / row
 * policies via `and(...)`.
 */
export function requireIdentity(): Policy {
  return (ctx) =>
    ctx.identity !== null
      ? { allow: true }
      : {
          allow: false,
          reason: `requireIdentity: no identity${authDisabledSuffix(ctx.authEnabled)}`
        };
}

/**
 * Allow when the identity carries the named capability in its
 * `capabilities: string[]` claim. Admin gates on `purge<T>` and other
 * sensitive mutations compose with this. Per §5.12, the capability name
 * comes from `SUBSTRATE_ADMIN_CAPABILITY` (default `'admin'`).
 *
 * Rejects both when no identity is attached and when identity lacks the
 * capability — callers don't need to stack `requireIdentity()` first.
 */
export function requireCapability(name: string): Policy {
  return (ctx) => {
    const id = ctx.identity;
    if (id === null) {
      return {
        allow: false,
        reason: `requireCapability(${name}): no identity${authDisabledSuffix(ctx.authEnabled)}`
      };
    }

    // Scoped to `ctx.namespace`: for `purge<T>` this is the only gate, so a
    // capability granted in another namespace must not pass. An explicit entry
    // beats the wildcard, matching the grant module and the engine gate.
    const grants = id.grants;
    if (grants !== undefined && grants !== null && typeof grants === 'object') {
      const table = grants as Record<string, unknown>;
      const caps = table[ctx.namespace] ?? table['*'];
      if (Array.isArray(caps) && caps.includes(name)) return { allow: true };
      return {
        allow: false,
        reason: `requireCapability(${name}): not granted in namespace '${ctx.namespace}'`
      };
    }

    // No grant means no claim, and no claim gets nothing.
    return { allow: false, reason: `requireCapability(${name}): missing capability` };
  };
}

/**
 * Allow when the identity's grant covers `ns` — explicit entry or wildcard.
 * Resolved through `grantOf`, the same function the engine gate uses, so the
 * two cannot disagree.
 *
 * Rejects when no identity is attached or when the grant does not cover `ns`;
 * composes with `requireCapability` via `and` for resolver policies that need
 * both a capability and a namespace grant.
 */
export function requireNamespace(ns: string): Policy {
  return (ctx) => {
    const id = ctx.identity;
    if (id === null) {
      return { allow: false, reason: `requireNamespace(${ns}): no identity` };
    }
    if (!coversNamespace(grantOf(id), ns)) {
      return { allow: false, reason: `requireNamespace(${ns}): not in allowed namespaces` };
    }
    return { allow: true };
  };
}

/**
 * Deny dispatches whose autoCRUD verb is in `verbs`; allow everything else.
 * Keys on `ctx.verb` — the semantic verb the engine threads from
 * the registry entry — so the intent survives entry renames. Entries WITHOUT
 * a verb (type entries, custom mutations) are allowed by this primitive;
 * gate those by `ctx.entry` name or compose additional policies.
 *
 * `purge<T>` is stamped `verb: 'delete'` by autoCRUD, so `denyVerbs(['delete'])`
 * covers both soft- and hard-delete surfaces.
 */
export function denyVerbs(verbs: ReadonlyArray<AutoCrudVerb>, reason?: string): Policy {
  const set = new Set(verbs);
  return (ctx) =>
    ctx.verb !== undefined && set.has(ctx.verb)
      ? { allow: false, reason: reason ?? `denyVerbs: '${ctx.verb}' is denied` }
      : { allow: true };
}

/**
 * Allow ONLY dispatches whose autoCRUD verb is in `verbs`.
 * Stricter complement of `denyVerbs`: entries WITHOUT a verb (type entries,
 * custom mutations) are DENIED — an allow-list should not silently pass
 * surfaces it cannot classify. Compose with `or(...)` if reads-via-type-entry
 * must also pass: `or(allowVerbs(['get']), <type-entry policy>)`.
 */
export function allowVerbs(verbs: ReadonlyArray<AutoCrudVerb>, reason?: string): Policy {
  const set = new Set(verbs);
  return (ctx) =>
    ctx.verb !== undefined && set.has(ctx.verb)
      ? { allow: true }
      : {
          allow: false,
          reason: reason ?? `allowVerbs: '${ctx.verb ?? ctx.entry ?? 'unknown'}' not in allow-list`
        };
}
