/**
 * A Pike VM (Thompson NFA simulation with thread priorities and capture slots)
 * for exactly the portable subset `checkRegexSubset` accepts. Matching is
 * O(subject length x program length) with no recursion over the subject, and a
 * call past MAX_STEPS throws, so a caller's pattern cannot block the event loop. It works over code points; `.`
 * matches any code point including a newline, `^` and `$` match only at the
 * subject's start and end. The match is the leftmost-longest one Postgres (POSIX
 * ARE) reports; among equally long matches, thread priority picks the captures.
 */

import { REGEX_BUDGET_EXCEEDED, ResolverFrameError } from '@mnmal-ai/substrate-types';
import { type Node, nullable, parse, programSize } from './regex-ast.js';
import { checkRegexSubset, MAX_PROGRAM } from './regex-subset.js';

type Inst =
  | { op: 'char'; c: number }
  | { op: 'any' }
  | { op: 'class'; neg: boolean; ranges: [number, number][] }
  | { op: 'bol' }
  | { op: 'eol' }
  | { op: 'split'; x: number; y: number }
  | { op: 'jmp'; x: number }
  | { op: 'save'; slot: number }
  | { op: 'mark'; slot: number }
  | { op: 'progress'; slot: number }
  | { op: 'match' };

export interface RegexProgram {
  insts: Inst[];
  groups: number;
  /** Capture slots plus the scratch slots of empty-iteration guards. */
  slots: number;
}

export interface RegexMatch {
  /** UTF-16 offsets into the subject, as `String.prototype.slice` takes. */
  index: number;
  end: number;
  groups: (string | undefined)[];
}

function emit(node: Node, out: Inst[], base: number): void {
  switch (node.t) {
    case 'char':
      out.push({ op: 'char', c: node.c });
      return;
    case 'any':
    case 'bol':
    case 'eol':
      out.push({ op: node.t });
      return;
    case 'class':
      out.push({ op: 'class', neg: node.neg, ranges: node.ranges });
      return;
    case 'group':
      if (node.cap === null) {
        emit(node.body, out, base);
        return;
      }
      out.push({ op: 'save', slot: 2 * node.cap + 2 });
      emit(node.body, out, base);
      out.push({ op: 'save', slot: 2 * node.cap + 3 });
      return;
    case 'cat':
      for (const n of node.items) emit(n, out, base);
      return;
    case 'alt': {
      const jumps: number[] = [];
      node.items.forEach((n, k) => {
        if (k < node.items.length - 1) {
          const split = out.length;
          out.push({ op: 'split', x: split + 1, y: 0 });
          emit(n, out, base);
          jumps.push(out.length);
          out.push({ op: 'jmp', x: 0 });
          (out[split] as { y: number }).y = out.length;
        } else emit(n, out, base);
      });
      for (const j of jumps) (out[j] as { x: number }).x = out.length;
      return;
    }
    case 'rep': {
      for (let k = 0; k < node.min; k++) emit(node.body, out, base);
      // An optional iteration that matched nothing is refused, as a backtracking engine does.
      const slot = base + node.id;
      const guarded = nullable(node.body);
      const iteration = (): void => {
        if (guarded) out.push({ op: 'mark', slot });
        emit(node.body, out, base);
        if (guarded) out.push({ op: 'progress', slot });
      };
      if (node.max === Number.POSITIVE_INFINITY) {
        const split = out.length;
        out.push({ op: 'split', x: split + 1, y: 0 });
        iteration();
        out.push({ op: 'jmp', x: split });
        (out[split] as { y: number }).y = out.length;
        return;
      }
      const splits: number[] = [];
      for (let k = node.min; k < node.max; k++) {
        splits.push(out.length);
        out.push({ op: 'split', x: out.length + 1, y: 0 });
        iteration();
      }
      for (const s of splits) (out[s] as { y: number }).y = out.length;
    }
  }
}

/** Compiles a pattern the subset accepts; throws on one it refuses. */
export function compileRegex(pattern: string): RegexProgram {
  const bad = checkRegexSubset(pattern);
  if (bad) throw new Error(`invalid regex: ${bad}`);
  const { node, groups, reps } = parse(pattern);
  if (programSize(node) > MAX_PROGRAM) throw new Error('invalid regex: program too large');
  const insts: Inst[] = [{ op: 'save', slot: 0 }];
  emit(node, insts, 2 * groups + 2);
  insts.push({ op: 'save', slot: 1 }, { op: 'match' });
  return { insts, groups: groups, slots: 2 * groups + 2 + reps };
}

/** Steps one call may take, about 200 ms: a 10 KB value against the largest program takes ~15M. */
export const MAX_STEPS = 4_000_000;

interface Thread {
  pc: number;
  caps: number[];
}

/** The leftmost-longest match of `prog` in `subject`, as Postgres reports it, or null. */
export function execRegex(prog: RegexProgram, subject: string): RegexMatch | null {
  const { insts } = prog;
  const cps: number[] = [];
  const offsets: number[] = [];
  for (let k = 0; k < subject.length; ) {
    const cp = subject.codePointAt(k) as number;
    offsets.push(k);
    cps.push(cp);
    k += cp > 0xffff ? 2 : 1;
  }
  offsets.push(subject.length);
  const n = cps.length;
  const nslots = prog.slots;
  const seen = new Int32Array(insts.length).fill(-1);
  let clist: Thread[] = [];
  let nlist: Thread[] = [];
  let found: number[] | null = null;

  // Follows empty transitions from pc at subject position `pos`, in priority order.
  let steps = 0;
  const step = (): void => {
    if (++steps > MAX_STEPS)
      throw new ResolverFrameError(
        REGEX_BUDGET_EXCEEDED,
        `regex needs more than ${MAX_STEPS} steps on this value; use a shorter pattern or value`,
        { budget: MAX_STEPS }
      );
  };
  const add = (list: Thread[], startPc: number, startCaps: number[], pos: number, gen: number) => {
    const stack: Thread[] = [{ pc: startPc, caps: startCaps }];
    while (stack.length > 0) {
      step();
      const { pc, caps } = stack.pop() as Thread;
      const inst = insts[pc] as Inst;
      // A refused empty iteration must not mark the pc seen: a later thread may pass it.
      if (inst.op === 'progress' && caps[inst.slot] === pos) continue;
      if (seen[pc] === gen) continue;
      seen[pc] = gen;
      switch (inst.op) {
        case 'jmp':
          stack.push({ pc: inst.x, caps });
          break;
        case 'split':
          stack.push({ pc: inst.y, caps }, { pc: inst.x, caps });
          break;
        case 'progress':
          stack.push({ pc: pc + 1, caps });
          break;
        case 'mark':
        case 'save': {
          const next = caps.slice();
          next[inst.slot] = pos;
          stack.push({ pc: pc + 1, caps: next });
          break;
        }
        case 'bol':
          if (pos === 0) stack.push({ pc: pc + 1, caps });
          break;
        case 'eol':
          if (pos === n) stack.push({ pc: pc + 1, caps });
          break;
        default:
          list.push({ pc, caps });
      }
    }
  };

  const blank = new Array<number>(nslots).fill(-1);
  for (let pos = 0; pos <= n; pos++) {
    // Each position gets a fresh generation; threads already advanced into
    // nlist for this position were added under generation `pos`.
    if (found === null) add(clist, 0, blank, pos, pos);
    if (clist.length === 0 && found !== null) break;
    const cp = pos < n ? (cps[pos] as number) : -1;
    for (const t of clist) {
      step();
      const inst = insts[t.pc] as Inst;
      // A thread that started right of the found match can only lose to it.
      if (found !== null && (t.caps[0] as number) > (found[0] as number)) continue;
      if (inst.op === 'match') {
        // Leftmost wins; at the same start, the longest wins, then the higher priority.
        if (
          found === null ||
          (t.caps[0] as number) < (found[0] as number) ||
          pos > (found[1] as number)
        )
          found = t.caps;
        continue;
      }
      if (cp < 0) continue;
      const ok =
        inst.op === 'char'
          ? inst.c === cp
          : inst.op === 'any'
            ? true
            : inst.op === 'class' &&
              inst.ranges.some(([lo, hi]) => cp >= lo && cp <= hi) !== inst.neg;
      if (ok) add(nlist, t.pc + 1, t.caps, pos + 1, pos + 1);
    }
    [clist, nlist] = [nlist, clist];
    nlist.length = 0;
  }
  if (found === null) return null;
  const at = (s: number | undefined): number => offsets[s as number] as number;
  const groups: (string | undefined)[] = [];
  for (let g = 0; g < prog.groups; g++) {
    const s = found[2 * g + 2];
    const e = found[2 * g + 3];
    groups.push(
      s === undefined || s < 0 || e === undefined || e < 0 ? undefined : subject.slice(at(s), at(e))
    );
  }
  return { index: at(found[0]), end: at(found[1]), groups };
}
