/**
 * The portable regex subset as a syntax tree, shared by the validator (which
 * sizes the program a pattern compiles to) and the matcher. Input must already
 * satisfy the subset grammar.
 */
export type Node =
  | { t: 'char'; c: number }
  | { t: 'any' }
  | { t: 'class'; neg: boolean; ranges: [number, number][] }
  | { t: 'bol' }
  | { t: 'eol' }
  | { t: 'group'; cap: number | null; body: Node }
  | { t: 'cat'; items: Node[] }
  | { t: 'alt'; items: Node[] }
  | { t: 'rep'; body: Node; min: number; max: number; id: number };

export function parse(pattern: string): { node: Node; groups: number; reps: number } {
  const cps = Array.from(pattern, (c) => c.codePointAt(0) as number);
  let i = 0;
  let groups = 0;
  let reps = 0;
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
      return { t: 'rep', body, min: bounds[0], max: bounds[1], id: reps++ };
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
      max: comma ? (hi ? Number(hi) : Number.POSITIVE_INFINITY) : min,
      id: reps++
    };
  };

  return { node: alt(), groups, reps };
}

/** True when the node can match the empty string. */
export function nullable(n: Node): boolean {
  switch (n.t) {
    case 'bol':
    case 'eol':
      return true;
    case 'group':
      return nullable(n.body);
    case 'cat':
      return n.items.every(nullable);
    case 'alt':
      return n.items.some(nullable);
    case 'rep':
      return n.min === 0 || nullable(n.body);
    default:
      return false;
  }
}

/** The number of instructions the matcher emits for a node (counted repeats are unrolled). */
export function nodeSize(n: Node): number {
  switch (n.t) {
    case 'group':
      return nodeSize(n.body) + (n.cap === null ? 0 : 2);
    case 'cat':
      return n.items.reduce((s, x) => s + nodeSize(x), 0);
    case 'alt':
      return n.items.reduce((s, x) => s + nodeSize(x), 0) + 2 * (n.items.length - 1);
    case 'rep': {
      const b = nodeSize(n.body);
      // An optional iteration of a body that can match empty adds a mark and a progress check.
      const opt = b + (nullable(n.body) ? 2 : 0);
      const tail = n.max === Number.POSITIVE_INFINITY ? opt + 2 : (n.max - n.min) * (opt + 1);
      return n.min * b + tail;
    }
    default:
      return 1;
  }
}

/** Instructions in a whole program: the node plus the two capture saves and the match. */
/**
 * True when the pattern has both a capturing group and an alternation. Postgres
 * then assigns captures by POSIX subexpression rules the VM does not follow, so
 * `regexpReplace` refuses it.
 */
export function capturesWithAlternation(pattern: string): boolean {
  const { node, groups } = parse(pattern);
  const alt = (n: Node): boolean =>
    n.t === 'alt' ||
    ((n.t === 'group' || n.t === 'rep') && alt(n.body)) ||
    (n.t === 'cat' && n.items.some(alt));
  return groups > 0 && alt(node);
}

export const programSize = (n: Node): number => nodeSize(n) + 3;
