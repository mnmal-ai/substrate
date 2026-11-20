import type { StepResult, Transcript } from '../../examples/_harness.ts';

export interface FeedEvent {
  /** `<op> · <frame key>`, e.g. `mutate · app/createTask`. */
  kind: string;
  /** The frame's params on one line of at most 80 characters. */
  line: string;
  /** A short outcome, e.g. `→ created`, `→ 4 rows`, `→ +1 row, live`. */
  result: string;
}

type Frame = { params?: Record<string, unknown> };
type Response = { kind?: string; data?: Record<string, unknown>; errors?: { code?: string }[] };

const MAX = 80;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE: Record<string, string> = { add: '+1 row', update: '1 row updated', remove: '−1 row' };

const pairs = (v: unknown): [string, unknown][] =>
  v !== null && typeof v === 'object' ? Object.entries(v) : [];
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

// `sum(amount)`, `dateTrunc(month, dueAt)`, `count`: an expression as a reader would write it.
function expr(v: unknown): string {
  if (Array.isArray(v)) return v.map(expr).join(', ');
  if (v === null || typeof v !== 'object') return String(v);
  const entries = Object.entries(v);
  if (entries.length !== 1) return JSON.stringify(v);
  const [fn, arg] = entries[0] as [string, unknown];
  return fn === 'lit' ? expr(arg) : arg === true ? fn : `${fn}(${expr(arg)})`;
}

function clause([key, v]: [string, unknown]): string[] {
  switch (key) {
    case 'where':
      return [
        `where ${pairs(v)
          .flatMap(([field, cond]) => pairs(cond).map(([op, x]) => `${field} ${op} ${expr(x)}`))
          .join(' and ')}`
      ];
    case 'orderBy':
      return [
        `orderBy ${[v]
          .flat()
          .flatMap((o) => pairs(o).map(([field, dir]) => `${field} ${dir}`))
          .join(', ')}`
      ];
    case 'aggregate':
      return [
        pairs(v)
          .map(([, a]) => expr(a))
          .join(', ')
      ];
    case 'groupBy':
      return [
        `by ${pairs(v)
          .map(([, g]) => expr(g))
          .join(', ')}`
      ];
    default:
      // An id says nothing to a reader.
      if (typeof v === 'string' && UUID.test(v)) return [];
      return [`${key}: ${typeof v === 'string' ? JSON.stringify(v) : expr(v)}`];
  }
}

// Whole clauses while they fit, then `…`.
function fit(parts: string[]): string {
  let out = '';
  for (const [i, part] of parts.entries()) {
    const next = out === '' ? part : `${out}, ${part}`;
    // Leave room for `, …` unless this is the last part.
    if (next.length > (i === parts.length - 1 ? MAX : MAX - 3)) {
      return out === '' ? `${part.slice(0, MAX - 1)}…` : `${out}, …`;
    }
    out = next;
  }
  return out;
}

function result(step: StepResult, op: string, key: string): string {
  const res = step.response as Response;
  if (step.receive !== undefined) return `→ ${LIVE[res.kind ?? ''] ?? res.kind}, live`;
  const data = res.data?.[key];
  if (data === undefined) {
    const code = res.errors?.[0]?.code;
    return code === undefined ? `→ ${step.status}` : `→ refused, ${code}`;
  }
  if (op === 'mutate') {
    const verb = /\/(create|update|delete)/.exec(key)?.[1];
    const signed = step.as === undefined ? '' : `, signed by ${step.as}`;
    return `→ ${verb === undefined ? 'ok' : `${verb}d`}${signed}`;
  }
  if (Array.isArray(data)) {
    if (key !== 'recall/Hit') return `→ ${count(data.length, 'row')}`;
    const best = (data[0] as { row?: { name?: string } } | undefined)?.row?.name;
    return `→ ${count(data.length, 'hit')}${best === undefined ? '' : `, best ${best}`}`;
  }
  const groups = (data as { groups?: unknown[] }).groups;
  return groups === undefined ? '→ 1 row' : `→ ${count(groups.length, 'group')}`;
}

type AskOutcome = { kind?: string; frame?: Record<string, Frame>; data?: unknown };

// An ask step posts `{ question }` to `nl`: the line is the frame the parser built, if it built one.
function ask(step: StepResult): FeedEvent {
  const question = (step.body as { question?: string } | undefined)?.question ?? '';
  const outcome = (step.response as { outcome?: AskOutcome }).outcome;
  const frame = Object.values(outcome?.frame ?? {})[0];
  const data = outcome?.data;
  const rows = Array.isArray(data) ? data : (data as { groups?: unknown[] } | undefined)?.groups;
  return {
    kind: `ask · ${JSON.stringify(question)}`,
    line: outcome?.kind === 'rows' ? fit(Object.entries(frame?.params ?? {}).flatMap(clause)) : '',
    result:
      outcome?.kind === 'rows' && rows !== undefined
        ? `→ ${count(rows.length, 'row')}`
        : `→ ${outcome?.kind ?? step.status}`
  };
}

/** One event per `feed` step, in order. Harness-only step fields never reach a line. */
export function feedEvents(ts: Transcript[]): FeedEvent[] {
  return ts.flatMap((t) =>
    t.steps
      .filter((s) => s.feed)
      .map((s) => {
        if (s.path.endsWith('/nl')) return ask(s);
        // A received frame has no request of its own: it answers the subscription its stream opened.
        const req =
          s.receive === undefined ? s : (t.steps.find((o) => o.stream === s.receive) ?? s);
        const [key, frame] = Object.entries((req.body ?? {}) as Record<string, Frame>)[0] ?? [''];
        const op = s.path.split('/').pop() ?? '';
        return {
          kind: `${op} · ${key}`,
          line: fit(Object.entries(frame?.params ?? {}).flatMap(clause)),
          result: result(s, op, key)
        };
      })
  );
}
