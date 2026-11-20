import type { StepResult, Transcript } from '../../examples/_harness.ts';

/** The Shiki theme of every code block: slate and cyan, near the page's own tokens. */
export const THEME = 'poimandres';

/** One block of a worked example as the page shows it. */
export type PageStep =
  | { kind: 'seed'; summary: string }
  /** A request and its response. `opens` marks a subscription opening its stream. */
  | { kind: 'request'; step: StepResult; opens: boolean }
  /** A frame arriving on the subscription `on` opened, with no request of its own. */
  | { kind: 'frame'; step: StepResult; on: StepResult };

type Frame = { params?: unknown; fields?: Record<string, unknown> };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

function flat(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(flat).join(', ')}]`;
  if (!isObject(v)) return JSON.stringify(v) ?? 'null';
  const entries = Object.entries(v);
  return entries.length === 0
    ? '{}'
    : `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${flat(x)}`).join(', ')} }`;
}

/**
 * JSON for reading: a value that fits in `width` columns from where it starts stays on one line,
 * anything longer opens one level per line. `JSON.parse` gives back the same value.
 */
export function pretty(v: unknown, width = 64, indent = '', start = indent.length): string {
  const one = flat(v);
  if (!isObject(v) || start + one.length <= width) return one;
  const inner = `${indent}  `;
  const lines = Array.isArray(v)
    ? v.map((x) => inner + pretty(x, width, inner))
    : Object.entries(v).map(([k, x]) => {
        const key = `${inner}${JSON.stringify(k)}: `;
        return key + pretty(x, width, inner, key.length);
      });
  if (lines.length === 0) return one;
  const [open, close] = Array.isArray(v) ? ['[', ']'] : ['{', '}'];
  return `${open}\n${lines.join(',\n')}\n${indent}${close}`;
}

// `app/createCustomer` → `customer`.
const noun = (key: string) => (key.split('/create')[1] ?? key).toLowerCase();

/**
 * The page's view of a transcript. The first run of steps labelled as the shared seed becomes
 * one summary line, a `stream` step opens a subscription, and a `receive` step is a frame
 * arriving on it.
 */
export function pageSteps(t: Transcript, seedLabels: Set<string>): PageStep[] {
  const out: PageStep[] = [];
  const counts = new Map<string, number>();
  const seed = { kind: 'seed' as const, summary: '' };
  let seeding: 'before' | 'in' | 'after' = 'before';
  for (const step of t.steps) {
    if (seeding !== 'after' && seedLabels.has(step.label)) {
      if (seeding === 'before') out.push(seed);
      seeding = 'in';
      const key = noun(Object.keys(isObject(step.body) ? step.body : {})[0] ?? step.label);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      continue;
    }
    if (seeding === 'in') seeding = 'after';
    const on =
      step.receive === undefined ? undefined : t.steps.find((s) => s.stream === step.receive);
    out.push(
      on === undefined
        ? { kind: 'request', step, opens: step.stream !== undefined }
        : { kind: 'frame', step, on }
    );
  }
  seed.summary = `seed: ${[...counts].map(([n, c]) => `${c} ${n}${c === 1 ? '' : 's'}`).join(', ')}`;
  return out;
}

// The params a subscription accepts (docs/surface-parity.md §4); anything else it refuses.
const SUBSCRIBE_PARAMS = ['where', 'orderBy'];

/**
 * One query frame as three surfaces take it: the HTTP body, the MCP `query` tool's arguments, and
 * a `POST /substrate/v1/subscribe` body, all the same object. Throws at build time on a frame a
 * subscription would refuse (an edge walk, or a param beyond `where` and `orderBy`), so the page
 * never shows one.
 */
export function threeWays(frame: Record<string, Frame>) {
  for (const [key, f] of Object.entries(frame)) {
    if (/"_(walk|agg)":/.test(JSON.stringify(f))) {
      throw new Error(`threeWays: ${key} walks an edge, which a subscription refuses.`);
    }
    const extra = Object.keys(isObject(f.params) ? f.params : {}).filter(
      (p) => !SUBSCRIBE_PARAMS.includes(p)
    );
    if (extra.length > 0) {
      throw new Error(`threeWays: ${key} sends ${extra.join(', ')}, which a subscription refuses.`);
    }
  }
  return { http: frame, mcp: { payload: frame }, subscribe: frame };
}
