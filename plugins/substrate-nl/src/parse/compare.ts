/**
 * The comparison lexicon (typed edge walks spec §6): a small, closed set of
 * phrases. Anything comparative outside it is dropped by the caller, never
 * approximated.
 *
 * - "N% over / above / more than / slower" -> gte, times (100+N)/100
 * - "N% faster"                            -> lte, times (100-N)/100
 * - "at least N× / Nx / N times"           -> gte, times N
 * - "$N over / more than <field>"          -> gte, plus N
 * - "over / more than X"                   -> gt X;  "under / less than X" -> lt X
 *   (without a number after them the operand is the field phrase that follows)
 */

export interface Comparison {
  op: 'gt' | 'gte' | 'lt' | 'lte';
  times?: number;
  plus?: number;
  /** A literal operand read with the phrase ("over $50"). */
  value?: number;
  /** Words the phrase took. */
  length: number;
}

const NUMBER = /^\$?(\d+(?:\.\d+)?)$/;

/** The comparison phrase starting at `words[0]`, or null. */
export function parseComparison(words: string[]): Comparison | null {
  const [a = '', b = '', c = ''] = words;
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(a);
  if (pct !== null) {
    const n = Number(pct[1]);
    const up = (100 + n) / 100;
    if (b === 'over' || b === 'above') return { op: 'gte', times: up, length: 2 };
    if (b === 'more' && c === 'than') return { op: 'gte', times: up, length: 3 };
    const length = c === 'than' ? 3 : 2;
    if (b === 'slower') return { op: 'gte', times: up, length };
    if (b === 'faster') return { op: 'lte', times: (100 - n) / 100, length };
    return null;
  }
  const lead = a === 'at' && b === 'least' ? 2 : 0;
  const w = words[lead] ?? '';
  const mult = /^(\d+(?:\.\d+)?)(?:x|×)$/.exec(w);
  if (mult !== null) return { op: 'gte', times: Number(mult[1]), length: lead + 1 };
  const next = words[lead + 1];
  if (/^\d+(?:\.\d+)?$/.test(w) && (next === 'times' || next === 'x' || next === '×'))
    return { op: 'gte', times: Number(w), length: lead + 2 };
  if (lead > 0) return null;
  const amount = /^\$(\d+(?:\.\d+)?)$/.exec(a);
  if (amount !== null) {
    const plus = Number(amount[1]);
    if (b === 'over') return { op: 'gte', plus, length: 2 };
    if (b === 'more' && c === 'than') return { op: 'gte', plus, length: 3 };
    return null;
  }
  const head: [Comparison['op'], number] | null =
    a === 'over'
      ? ['gt', 1]
      : a === 'under'
        ? ['lt', 1]
        : a === 'more' && b === 'than'
          ? ['gt', 2]
          : a === 'less' && b === 'than'
            ? ['lt', 2]
            : null;
  if (head === null) return null;
  const [op, length] = head;
  const lit = NUMBER.exec(words[length] ?? '');
  return lit !== null ? { op, value: Number(lit[1]), length: length + 1 } : { op, length };
}
