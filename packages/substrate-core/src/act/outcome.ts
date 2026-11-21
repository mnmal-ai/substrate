/**
 * The executor's pieces that need no engine state: what a step's envelope
 * says it did, the one-line ack, result ids, and the throws that unwind the
 * transaction.
 */

import { randomBytes } from 'node:crypto';
import type {
  ActMode,
  ActPlan,
  ActPlanStep,
  ActStepOutcome,
  PackEnvelope,
  Row
} from '@mnmal-ai/substrate-types';

/** Most rows one result record keeps, across all its `find` steps. */
export const MAX_STORED_ROWS = 1000;

const BUILT_IN_PAST = new Map([
  ['create', 'created'],
  ['update', 'updated']
]);

/** A step refused or failed; unwinds the transaction. */
export class ActStepFailure extends Error {
  override readonly name = 'ActStepFailure';
  constructor(readonly error: { code: string; message: string; step: number }) {
    super(error.message);
  }
}

/** Every step of a dry run succeeded; unwinds the transaction. */
export class ActDryRunRollback extends Error {
  override readonly name = 'ActDryRunRollback';
}

export function newResultId(): string {
  return `r_${randomBytes(9).toString('base64url')}`;
}

/** What `step` did, read from its envelope. A `find` keeps at most `rowBudget` rows. */
export function stepOutcome(
  step: ActPlanStep,
  envelope: PackEnvelope,
  rowBudget: number
): ActStepOutcome {
  const base = { step: step.step, action: step.action, type: step.type };
  const data = envelope.data[step.key];
  if (step.action === 'count') return { ...base, count: (data as { count: number }).count };
  if (step.action === 'find') {
    const all = (data ?? []) as Row[];
    const rows = all.slice(0, rowBudget);
    const hasMore = envelope._pagination?.[step.key]?.hasMore === true;
    return { ...base, rows, truncated: hasMore || rows.length < all.length };
  }
  const row = data as Row | null | undefined;
  if (row === null || row === undefined) return { ...base, touched: [] };
  const shortId = typeof row.shortId === 'number' ? { shortId: row.shortId } : {};
  return { ...base, touched: [{ id: String(row.id), ...shortId }] };
}

/**
 * `logged journal/SessionLog #1; closed work/Todo #1 #2`. Consecutive writes
 * with the same past tense and type share one group.
 */
export function formatAck(plan: ActPlan, outcomes: ActStepOutcome[], mode: ActMode): string {
  const parts: Array<string | { past: string; type: string; refs: string[] }> = [];
  for (const o of outcomes) {
    if (o.action === 'find') {
      parts.push(
        `${o.rows?.length ?? 0} ${o.type} rows${o.truncated === true ? ' (truncated)' : ''}`
      );
    } else if (o.action === 'count') {
      parts.push(`${o.type} count ${o.count}`);
    } else {
      const past =
        plan.steps[o.step - 1]?.past ?? BUILT_IN_PAST.get(o.action) ?? `${o.action} done`;
      const refs = (o.touched ?? []).map((t) => (t.shortId !== undefined ? `#${t.shortId}` : t.id));
      const last = parts.at(-1);
      if (typeof last === 'object' && last.past === past && last.type === o.type) {
        last.refs.push(...refs);
      } else parts.push({ past, type: o.type, refs });
    }
  }
  const text = parts
    .map((p) => (typeof p === 'string' ? p : [p.past, p.type, ...p.refs].join(' ')))
    .join('; ');
  return mode === 'dry-run' ? `dry run: ${text}` : text;
}
