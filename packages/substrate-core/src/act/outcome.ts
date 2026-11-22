/**
 * The executor's pieces that need no engine state: what a step's envelope
 * says it did, the one-line ack, result ids, and the throws that unwind the
 * transaction.
 */

import { createHash, randomBytes } from 'node:crypto';
import type {
  ActMode,
  ActPlan,
  ActPlanStep,
  ActStepOutcome,
  Identity,
  PackEnvelope,
  Row
} from '@mnmal-ai/substrate-types';
import { callerDedupComponent } from '../engine/internals.js';

/** Most rows one result record keeps, across all its `find` steps. */
export const MAX_STORED_ROWS = 1000;
/** Most rows a reply carries in `found`, across all its `find` steps. */
export const MAX_INLINE_ROWS = 100;

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

/** Lowercase hex SHA-256 of the caller's id, roles, scopes and grant: what owns a result record. */
export function ownerKeyOf(identity: Identity): string {
  return createHash('sha256').update(callerDedupComponent(identity), 'utf8').digest('hex');
}

/**
 * What `step` did, read from its envelope. A `find` keeps at most `rowBudget`
 * rows, each cut to the step's field selection.
 */
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
    const keep = Object.keys(step.fields);
    const rows = all
      .slice(0, rowBudget)
      .map((row) => Object.fromEntries(keep.filter((k) => k in row).map((k) => [k, row[k]])));
    const hasMore = envelope._pagination?.[step.key]?.hasMore === true;
    return { ...base, rows, truncated: hasMore || rows.length < all.length };
  }
  const row = data as Row | null | undefined;
  if (row === null || row === undefined) return { ...base, touched: [] };
  const shortId = typeof row.shortId === 'number' ? { shortId: row.shortId } : {};
  return { ...base, touched: [{ id: String(row.id), ...shortId }] };
}

/** The `find` outcomes for a reply's `found`: none when there are none, or more than `MAX_INLINE_ROWS` rows. */
export function inlineFinds(outcomes: ActStepOutcome[]): { found?: ActStepOutcome[] } {
  const finds = outcomes.filter((o) => o.action === 'find');
  const rows = finds.reduce((n, o) => n + (o.rows?.length ?? 0), 0);
  return finds.length > 0 && rows <= MAX_INLINE_ROWS ? { found: finds } : {};
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
