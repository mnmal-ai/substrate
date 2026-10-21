/**
 * Policy combinators: and / or / not. Spec: §4.4.
 *
 * Invariants (do not drift):
 *
 *   1. Combinators catch errors from inner policies and convert them to
 *      `{ allow: false, reason: 'policy error' }`. Policies MUST NOT throw;
 *      catching is defense-in-depth for composition outside the engine.
 *   2. Caught errors always deny AND surface their reason, regardless of
 *      outer combinator:
 *        - `not(boom)` stays denied (`'policy error'`).
 *        - `or(boom, denyAll('X'))` returns `'policy error'`, not `'X'`.
 *      Inverting a caught error into allow would turn policy bugs into
 *      silent permission grants.
 *   3. `and(...)` accumulates obligations from all allow decisions; `or(...)`
 *      returns only the winning policy's obligations.
 *   4. Empty obligation arrays are omitted entirely (not `obligations: []`)
 *      so decisions stay `exactOptionalPropertyTypes`-clean.
 *   5. `not(allow-with-no-reason)` returns `{ allow: false }` — no fabricated
 *      reason.
 */

import type {
  Obligation,
  Policy,
  PolicyDecision,
  RequestContext,
  ResolverArgs
} from '@mnmal-ai/substrate-types';

interface Evaluated {
  decision: PolicyDecision;
  /** True when the inner policy threw and we synthesised a deny. */
  caught: boolean;
}

/**
 * Evaluate one policy, catching throws and representing the outcome uniformly
 * so combinators can reason about "genuine deny" vs "caught error" without
 * leaking an extra field onto the public PolicyDecision shape.
 */
function evaluate(p: Policy, ctx: RequestContext, args: ResolverArgs): Evaluated {
  try {
    return { decision: p(ctx, args), caught: false };
  } catch {
    return { decision: { allow: false, reason: 'policy error' }, caught: true };
  }
}

/**
 * Build a PolicyDecision while honouring invariant #4: omit `obligations`
 * entirely when the merged array is empty (rather than emitting
 * `obligations: []`).
 */
function buildAllow(obligations: Obligation[]): PolicyDecision {
  return obligations.length > 0 ? { allow: true, obligations } : { allow: true };
}

/**
 * AND combinator. Allow iff every policy allows; short-circuits on first deny.
 * Empty `and()` is the identity element and returns allow (per §4.4).
 */
export function and(...policies: Policy[]): Policy {
  return (ctx, args) => {
    const obligations: Obligation[] = [];
    for (const p of policies) {
      const { decision } = evaluate(p, ctx, args);
      if (!decision.allow) {
        // First deny wins. Caught errors already carry 'policy error' as the
        // reason, so we don't need a separate branch here — just return.
        return decision;
      }
      if (decision.obligations && decision.obligations.length > 0) {
        obligations.push(...decision.obligations);
      }
    }
    return buildAllow(obligations);
  };
}

/**
 * OR combinator. Allow iff any policy allows; short-circuits on first allow.
 * When all deny, the LAST deny's reason is returned — EXCEPT a caught
 * `'policy error'` from any position always wins over sibling deny reasons
 * (invariant #2).
 */
export function or(...policies: Policy[]): Policy {
  return (ctx, args) => {
    if (policies.length === 0) {
      return { allow: false, reason: 'or(): no policies' };
    }

    let sawCaught = false;
    let lastDecision: PolicyDecision | null = null;

    for (const p of policies) {
      const { decision, caught } = evaluate(p, ctx, args);
      if (decision.allow) {
        // Winner's obligations only (invariant #3). Re-build to drop empty
        // obligation arrays (invariant #4).
        return buildAllow(
          decision.obligations && decision.obligations.length > 0 ? [...decision.obligations] : []
        );
      }
      if (caught) {
        sawCaught = true;
      }
      lastDecision = decision;
    }

    // If ANY sub-policy threw, a caught-error deny takes precedence over
    // whatever the last policy's deny reason was.
    if (sawCaught) {
      return { allow: false, reason: 'policy error' };
    }

    // All-deny branch: return last deny's decision verbatim.
    // lastDecision is non-null here because policies.length > 0.
    return lastDecision as PolicyDecision;
  };
}

/**
 * NOT combinator. Inverts allow/deny, EXCEPT caught errors propagate through
 * unchanged (invariant #2). Preserves the inner decision's `reason` on the
 * returned deny so callers can see it; omits `reason` entirely when the inner
 * allow had no reason (invariant #5).
 */
export function not(p: Policy): Policy {
  return (ctx, args) => {
    const { decision, caught } = evaluate(p, ctx, args);

    // Caught errors never flip — they always deny with 'policy error'.
    if (caught) {
      return { allow: false, reason: 'policy error' };
    }

    if (decision.allow) {
      // Flip to deny; carry the inner `reason` through if it was set (rare but
      // possible — allow decisions may annotate themselves). Skip `reason`
      // entirely when absent to stay exactOptionalPropertyTypes-clean.
      return decision.reason !== undefined
        ? { allow: false, reason: decision.reason }
        : { allow: false };
    }

    // Flip to allow; preserve the inner deny's reason on the decision object.
    // Obligations are not expected on denies (§4.4: "Obligations on allow
    // decisions accumulate") so we don't carry them through.
    return decision.reason !== undefined
      ? { allow: true, reason: decision.reason }
      : { allow: true };
  };
}
