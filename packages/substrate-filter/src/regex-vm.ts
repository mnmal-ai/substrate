/**
 * A Pike VM (Thompson NFA simulation with thread priorities and capture slots)
 * for exactly the portable subset `checkRegexSubset` accepts. Matching is
 * O(subject length x program length) with no recursion over the subject, so a
 * caller's pattern cannot block the event loop. It works over code points; `.`
 * matches any code point including a newline, `^` and `$` match only at the
 * subject's start and end, and priorities give the leftmost-first match a
 * backtracking engine (JavaScript under flags `us`) would report.
 */
import { checkRegexSubset } from './regex-subset.js';

type Node =
  | { t: 'char'; c: number }
  | { t: 'any' }
  | { t: 'class'; neg: boolean; ranges: [number, number][] }
  | { t: 'bol' }
  | { t: 'eol' }
  | { t: 'group'; cap: number | null; body: Node }
  | { t: 'cat'; items: Node[] }
  | { t: 'alt'; items: Node[] }
  | { t: 'rep'; body: Node; min: number; max: number };

type Inst =
  | { op: 'char'; c: number }
  | { op: 'any' }
  | { op: 'class'; neg: boolean; ranges: [number, number][] }
  | { op: 'bol' }
  | { op: 'eol' }
  | { op: 'split'; x: number; y: number }
  | { op: 'jmp'; x: number }
  | { op: 'save'; slot: number }
  | { op: 'match' };

export interface RegexProgram {
  insts: Inst[];
  groups: number;
}

export interface RegexMatch {
  /** UTF-16 offsets into the subject, as `String.prototype.slice` takes. */
  index: number;
  end: number;
  groups: (string | undefined)[];
}

function parse(pattern: string): { node: Node; groups: number } {
  const cps = Array.from(pattern, (c) => c.codePointAt(0) as number);
  let i = 0;
  let groups = 0;
  const ch = (c: string): number => c.codePointAt(0) as number;
  const peek = (): number | undefined => cps[i];

  const alt = (): Node => {
    const items = [seq()];
    while (peek() === ch('|')) {
      i++;
      items.push(seq());
    }
    return items.length === 1 ? (items[0] as Node) : { t: 'alt', items };
  };
  const seq = (): Node => {
    const items: Node[] = [];
    for (;;) {
      const c = peek();
      if (c === undefined || c === ch('|') || c === ch(')')) break;
      items.push(quant(atom()));
    }
    return { t: 'cat', items };
  };
  const atom = (): Node => {
    const c = cps[i++] as number;
    if (c === ch('(')) {
      let cap: number | null = null;
      if (peek() === ch('?')) i += 2;
      else cap = groups++;
      const body = alt();
      i++; // ')'
      return { t: 'group', cap, body };
    }
    if (c === ch('[')) return cls();
    if (c === ch('.')) return { t: 'any' };
    if (c === ch('^')) return { t: 'bol' };
    if (c === ch('$')) return { t: 'eol' };
    if (c === ch('\\')) return { t: 'char', c: cps[i++] as number };
    return { t: 'char', c };
  };
  const cls = (): Node => {
    const neg = peek() === ch('^');
    if (neg) i++;
    const ranges: [number, number][] = [];
    const cchar = (): number => {
      const c = cps[i++] as number;
      return c === ch('\\') ? (cps[i++] as number) : c;
    };
    while (peek() !== ch(']')) {
      const lo = cchar();
      if (peek() === ch('-') && cps[i + 1] !== ch(']')) {
        i++;
        ranges.push([lo, cchar()]);
      } else ranges.push([lo, lo]);
    }
    i++;
    return { t: 'class', neg, ranges };
  };
  const quant = (body: Node): Node => {
    const c = peek();
    const simple: Record<number, [number, number]> = {
      [ch('*')]: [0, Number.POSITIVE_INFINITY],
      [ch('+')]: [1, Number.POSITIVE_INFINITY],
      [ch('?')]: [0, 1]
    };
    const bounds = c === undefined ? undefined : simple[c];
    if (bounds) {
      i++;
      return { t: 'rep', body, min: bounds[0], max: bounds[1] };
    }
    if (c !== ch('{')) return body;
    const close = cps.indexOf(ch('}'), i);
    const [lo, comma, hi] = String.fromCodePoint(...cps.slice(i + 1, close)).split(/(,)/);
    i = close + 1;
    const min = Number(lo);
    return {
      t: 'rep',
      body,
      min,
      max: comma ? (hi ? Number(hi) : Number.POSITIVE_INFINITY) : min
    };
  };

  return { node: alt(), groups };
}

function emit(node: Node, out: Inst[]): void {
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
        emit(node.body, out);
        return;
      }
      out.push({ op: 'save', slot: 2 * node.cap + 2 });
      emit(node.body, out);
      out.push({ op: 'save', slot: 2 * node.cap + 3 });
      return;
    case 'cat':
      for (const n of node.items) emit(n, out);
      return;
    case 'alt': {
      const jumps: number[] = [];
      node.items.forEach((n, k) => {
        if (k < node.items.length - 1) {
          const split = out.length;
          out.push({ op: 'split', x: split + 1, y: 0 });
          emit(n, out);
          jumps.push(out.length);
          out.push({ op: 'jmp', x: 0 });
          (out[split] as { y: number }).y = out.length;
        } else emit(n, out);
      });
      for (const j of jumps) (out[j] as { x: number }).x = out.length;
      return;
    }
    case 'rep': {
      for (let k = 0; k < node.min; k++) emit(node.body, out);
      if (node.max === Number.POSITIVE_INFINITY) {
        const split = out.length;
        out.push({ op: 'split', x: split + 1, y: 0 });
        emit(node.body, out);
        out.push({ op: 'jmp', x: split });
        (out[split] as { y: number }).y = out.length;
        return;
      }
      const splits: number[] = [];
      for (let k = node.min; k < node.max; k++) {
        splits.push(out.length);
        out.push({ op: 'split', x: out.length + 1, y: 0 });
        emit(node.body, out);
      }
      for (const s of splits) (out[s] as { y: number }).y = out.length;
    }
  }
}

/** Compiles a pattern the subset accepts; throws on one it refuses. */
export function compileRegex(pattern: string): RegexProgram {
  const bad = checkRegexSubset(pattern);
  if (bad) throw new Error(`invalid regex: ${bad}`);
  const { node, groups } = parse(pattern);
  const insts: Inst[] = [{ op: 'save', slot: 0 }];
  emit(node, insts);
  insts.push({ op: 'save', slot: 1 }, { op: 'match' });
  return { insts, groups };
}

interface Thread {
  pc: number;
  caps: number[];
}

/** The leftmost-first match of `prog` in `subject`, or null. */
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
  const nslots = 2 * prog.groups + 2;
  const seen = new Int32Array(insts.length).fill(-1);
  let clist: Thread[] = [];
  let nlist: Thread[] = [];
  let found: number[] | null = null;

  // Follows empty transitions from pc at subject position `pos`, in priority order.
  const add = (list: Thread[], startPc: number, startCaps: number[], pos: number, gen: number) => {
    const stack: Thread[] = [{ pc: startPc, caps: startCaps }];
    while (stack.length > 0) {
      const { pc, caps } = stack.pop() as Thread;
      if (seen[pc] === gen) continue;
      seen[pc] = gen;
      const inst = insts[pc] as Inst;
      switch (inst.op) {
        case 'jmp':
          stack.push({ pc: inst.x, caps });
          break;
        case 'split':
          stack.push({ pc: inst.y, caps }, { pc: inst.x, caps });
          break;
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
      const inst = insts[t.pc] as Inst;
      if (inst.op === 'match') {
        found = t.caps;
        break; // lower-priority threads lose
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
