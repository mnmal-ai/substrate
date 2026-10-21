/**
 * Policy evaluator. Spec: §4.4.
 *
 * Two responsibilities:
 *   1. `evaluatePolicy` — invoke a policy, catching any throw and surfacing
 *      `{ allow: false, reason: 'policy error' }`. Mirrors the SDK combinator
 *      invariant so bare (uncomposed) policies get the same safety net.
 *   2. `applyObligations` — walk a decision's obligations and apply row-filter
 *      obligations to a row array (delegates to the SDK's `applyRowFilters`).
 */

import { applyRowFilters } from '@mnmal-ai/substrate-policy';
import type {
  Policy,
  PolicyDecision,
  RequestContext,
  ResolverArgs
} from '@mnmal-ai/substrate-types';

export function evaluatePolicy(
  policy: Policy,
  ctx: RequestContext,
  args: ResolverArgs
): PolicyDecision {
  try {
    return policy(ctx, args);
  } catch {
    // Fail closed. The reason reaches the caller, so it names the failure
    // without the thrown text (which may carry internals).
    return { allow: false, reason: 'policy error' };
  }
}

export function applyObligations<T>(decision: PolicyDecision, rows: T[], ctx: RequestContext): T[] {
  return applyRowFilters(decision, rows, ctx);
}
