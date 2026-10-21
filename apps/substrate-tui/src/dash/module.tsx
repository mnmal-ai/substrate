import type { RuntimeMetrics } from '@mnmal-ai/substrate/sdk';
import { defineModule, type ModuleCtx, type Size, type TuiModule } from '@mnmal-ai/surface-core';
import { cellWidth, Panel, padCells, sparkline, truncateCells } from '@mnmal-ai/surface-kit';
import type { Theme, Tone } from '@mnmal-ai/surface-theme';
import { Box, Text } from 'ink';
import type { TuiDeps } from '../deps.js';
import { clean } from '../text.js';
import {
  classify,
  type DashState,
  DENIAL_EVENT,
  type EmbedStats,
  type Health,
  initialDash,
  latencyTone,
  nextSort,
  type Sample,
  type Src,
  sortKeys,
  step,
  type Why
} from './derive.js';

export const DASH_INTERVAL_MS = 5_000;
/** Per source: one hung source must not hold up the others past this. */
export const DASH_TIMEOUT_MS = 4_000;
/** TRAFFIC inner width from which a per-key row also shows calls and p50. */
export const WIDE_KEY_ROW = 40;

type Panels = { dash: DashState };
type Ctx = ModuleCtx<Panels>;

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function healthOf(raw: unknown): Health {
  const h = raw as { version?: unknown; uptimeSeconds?: unknown } | null;
  return {
    ...(typeof h?.version === 'string' ? { version: h.version } : {}),
    ...(typeof h?.uptimeSeconds === 'number' ? { uptimeSeconds: h.uptimeSeconds } : {})
  };
}
function embedOf(raw: unknown): EmbedStats {
  const e = raw as Record<string, unknown> | null;
  return {
    ...(typeof e?.enabled === 'boolean' ? { enabled: e.enabled } : {}),
    writes: num(e?.writes),
    failures: num(e?.failures),
    expansionFailures: num(e?.expansionFailures)
  };
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

interface Seg {
  readonly t: string;
  readonly tone: Tone;
}
type Line = readonly Seg[];
const seg = (t: string, tone: Tone = 'text'): Seg => ({ t, tone });

/** Segments cut to `max` cells in total, the cut marked with `…`. */
function fit(line: Line, max: number): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  const total = line.reduce((n, s) => n + cellWidth(s.t), 0);
  if (total <= max) return [...line];
  for (const s of line) {
    const room = max - used;
    if (room <= 0) break;
    const w = cellWidth(s.t);
    if (w < room) {
      out.push(s);
      used += w;
    } else {
      out.push({ ...s, t: truncateCells(`${s.t}…`, room) });
      break;
    }
  }
  return out;
}

const na = (label: string, why: Why): Line => [
  seg(`${label} `, 'dim'),
  seg(`n/a (${why})`, why === 'down' ? 'warn' : 'dim')
];
const ms = (v: number): string =>
  v >= 100 ? `${Math.round(v)}ms` : `${Math.round(v * 10) / 10}ms`;
const rate = (v: number): string =>
  v >= 100 ? `${Math.round(v)}/s` : `${Math.round(v * 10) / 10}/s`;
function uptime(s: number): string {
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(s)}s`;
}
const last = (h: readonly number[]): number => h[h.length - 1] ?? 0;

function serviceLines(s: DashState, theme: Theme): Line[] {
  const out: Line[] = [];
  if (s.health === null) out.push([seg('…', 'dim')]);
  else if (s.health.ok) {
    const h = s.health.value;
    out.push([
      seg(`${theme.glyph.live} live`, 'ok'),
      ...(h.version !== undefined ? [seg(`  v${clean(h.version)}`, 'text')] : []),
      ...(h.uptimeSeconds !== undefined ? [seg(`  up ${uptime(h.uptimeSeconds)}`, 'dim')] : [])
    ]);
  } else out.push([seg(`${theme.glyph.fail} offline`, 'error'), seg(`  (${s.health.why})`, 'dim')]);

  const m = s.metrics;
  if (m === null) out.push([seg('metrics …', 'dim')]);
  else if (!m.ok) out.push(na('metrics', m.why));
  else {
    const sub = m.value.subscriptions;
    out.push([
      seg('subs ', 'dim'),
      seg(String(num(sub?.active))),
      ...(sub?.maxQueueDepth !== undefined
        ? [seg('  queue max ', 'dim'), seg(String(num(sub.maxQueueDepth)))]
        : [])
    ]);
  }

  const e = s.embed;
  if (e === null) out.push([seg('embed …', 'dim')]);
  else if (!e.ok) out.push(na('embed', e.why));
  else if (e.value.enabled === false) out.push([seg('embed ', 'dim'), seg('off', 'dim')]);
  else {
    const failures = num(e.value.failures);
    out.push([
      seg('embed ', 'dim'),
      seg('on ', 'ok'),
      seg(`${theme.glyph.fail}${failures}`, failures > 0 ? 'error' : 'dim'),
      seg(` · ${num(e.value.writes)} writes`, 'dim')
    ]);
  }

  const p = m?.ok === true ? m.value.process : undefined;
  if (p !== undefined) {
    out.push([
      seg('rss ', 'dim'),
      seg(`${Math.round(num(p.rssMB))}MB`),
      seg(' heap ', 'dim'),
      seg(`${Math.round(num(p.heapUsedMB))}MB`)
    ]);
    const lag = num(p.eventLoopLagP99Ms);
    out.push([seg('loop p99 ', 'dim'), seg(ms(lag), latencyTone(lag))]);
    const inFlight = num(p.inFlight);
    out.push([seg('in flight ', 'dim'), seg(String(inFlight), inFlight > 0 ? 'info' : 'text')]);
  }
  return out;
}

function opLines(
  label: string,
  glyph: string,
  tone: Tone,
  op: RuntimeMetrics['requests']['query'] | undefined,
  rates: readonly number[],
  errs: readonly number[],
  theme: Theme,
  compact: boolean
): Line[] {
  const total = num(op?.total);
  const mean = total > 0 ? num(op?.durationMsSum) / total : 0;
  const max = num(op?.durationMsMax);
  const newErr = last(errs);
  if (compact) {
    return [
      [
        seg(`${glyph} ${label} `, tone),
        seg(rate(last(rates))),
        seg(` ${theme.glyph.fail}${newErr}`, newErr > 0 ? 'error' : 'dim'),
        seg(' avg(all) ', 'dim'),
        seg(ms(mean), latencyTone(mean)),
        seg('  ', 'dim'),
        seg(sparkline(rates, theme.glyph.spark), 'spark')
      ]
    ];
  }
  return [
    [
      seg(`${glyph} ${label} `, tone),
      seg(rate(last(rates))),
      seg('  ', 'dim'),
      seg(sparkline(rates, theme.glyph.spark), 'spark')
    ],
    [
      seg(`  ${theme.glyph.fail}${newErr}`, newErr > 0 ? 'error' : 'dim'),
      // Cumulative since the server started, not per poll: labelled so.
      seg(' avg(all) ', 'dim'),
      seg(ms(mean), latencyTone(mean)),
      seg(' max ', 'dim'),
      seg(ms(max), latencyTone(max))
    ]
  ];
}

/**
 * Exported for tests: tones are not visible in a rendered frame. `compact` gives each op one line
 * (no max) and drops the KEYS header, so a short pane still reaches the per-key rows.
 */
export function trafficLines(s: DashState, theme: Theme, width: number, compact = false): Line[] {
  const m = s.metrics;
  if (m === null) return [[seg('…', 'dim')]];
  if (!m.ok) return [na('metrics', m.why)];
  const v = m.value;
  const out: Line[] = [
    ...opLines(
      'query',
      theme.glyph.query,
      'query',
      v.requests?.query,
      s.hist.queryRate,
      s.hist.queryErr,
      theme,
      compact
    ),
    ...opLines(
      'mutate',
      theme.glyph.mutation,
      'mutation',
      v.requests?.mutate,
      s.hist.mutateRate,
      s.hist.mutateErr,
      theme,
      compact
    )
  ];
  // Compact drops the KEYS header for one more key row: the footer already names the sort.
  if (!compact) out.push([seg(`KEYS · by ${s.sort}`, 'dimMid')]);
  const empty = compact ? 'keys ' : '  ';
  const keys = sortKeys(v.resolvers ?? {}, s.sort);
  // A server before 7.5 sends no `resolvers` at all: that is not "no traffic yet".
  if (v.resolvers === undefined) out.push([seg(`${empty}n/a (server)`, 'dim')]);
  else if (keys.length === 0) out.push([seg(`${empty}none yet`, 'dim')]);
  // The tail (numbers + sparkline) is measured first and the key gets what is left, so the
  // numbers never fall off the end. Narrow columns drop calls and p50.
  const wide = width >= WIDE_KEY_ROW;
  const tails = keys.map(([key, st]): Seg[] => {
    const p99 = num(st.p99Ms);
    return [
      ...(wide ? [seg(` ${num(st.calls)}`, 'dim'), seg(` ${ms(num(st.p50Ms))}/`, 'dim')] : []),
      seg(wide ? ms(p99) : ` ${ms(p99)}`, latencyTone(p99)),
      seg(` ${theme.glyph.fail}${num(st.errors)} `, s.keyErrRose.has(key) ? 'error' : 'dim'),
      seg(sparkline((s.hist.p99.get(key) ?? []).slice(wide ? -8 : -6), theme.glyph.spark), 'spark')
    ];
  });
  const tailW = Math.max(0, ...tails.map((t) => t.reduce((n, sg) => n + cellWidth(sg.t), 0)));
  // As wide as the longest key, so the numbers sit next to the names on a wide panel.
  const longest = Math.max(
    0,
    ...keys.map(([key]) => cellWidth(clean(key))),
    ...(v.slowest ?? []).slice(0, 5).map((r) => cellWidth(clean(r.key)))
  );
  const keyW = Math.max(4, Math.min(width - 2 - tailW, longest));
  keys.forEach(([key], i) => {
    out.push([
      seg(`${theme.glyph.query} `, 'dim'),
      seg(padCells(clean(key), keyW)),
      ...(tails[i] ?? [])
    ]);
  });
  const slow = v.slowest ?? [];
  if (slow.length > 0) {
    out.push([seg('SLOWEST', 'dimMid')]);
    for (const r of slow.slice(0, 5)) {
      const d = num(r.durationMs);
      out.push([seg(`  ${padCells(clean(r.key), keyW)} `), seg(ms(d), latencyTone(d))]);
    }
  }
  return out;
}

/** `compact` folds denials and errors onto one line, so RECENT ERRORS survives a short pane. */
function engineLines(s: DashState, theme: Theme, compact = false): Line[] {
  const out: Line[] = [];
  const m = s.metrics;
  if (m === null) out.push([seg('…', 'dim')]);
  else if (!m.ok) out.push(na('events', m.why));
  else {
    const den = last(s.hist.denials);
    const errHist = s.hist.queryErr.map((q, i) => q + (s.hist.mutateErr[i] ?? 0));
    const err = last(errHist);
    if (compact) {
      out.push([
        seg('denials ', 'dim'),
        seg(`+${den}`, den > 0 ? 'error' : 'text'),
        seg(' · errors ', 'dim'),
        seg(`+${err}`, err > 0 ? 'error' : 'text')
      ]);
    } else {
      out.push([
        seg('denials ', 'dim'),
        seg(`+${den} `, den > 0 ? 'error' : 'text'),
        seg(sparkline(s.hist.denials, theme.glyph.spark), 'spark')
      ]);
      out.push([
        seg('errors  ', 'dim'),
        seg(`+${err} `, err > 0 ? 'error' : 'text'),
        seg(sparkline(errHist, theme.glyph.spark), 'spark')
      ]);
    }
  }

  // Sections in priority order: a short panel cuts from the bottom, so the tallies go last.
  const e = s.errors;
  out.push([seg('RECENT ERRORS', 'dimMid')]);
  if (e === null) out.push([seg('  …', 'dim')]);
  else if (!e.ok) out.push(na(' ', e.why));
  else if ((e.value.errors ?? []).length === 0) out.push([seg('  none', 'dim')]);
  else {
    for (const r of e.value.errors.slice(0, 5)) {
      const at = typeof r.at === 'string' ? clean(r.at).slice(11, 19) : '';
      out.push([
        seg(`  ${at} `, 'dim'),
        seg(`${clean(String(r.code))} `, 'error'),
        seg(`${clean(String(r.key))} `),
        ...(typeof r.caller === 'string' ? [seg(`${clean(r.caller)} `, 'dimMid')] : []),
        seg(clean(String(r.message)), 'dim'),
        ...(num(r.count) > 1 ? [seg(` ×${num(r.count)}`, 'dim')] : [])
      ]);
    }
  }

  if (m?.ok === true) {
    const events = Object.entries(m.value.events ?? {})
      .filter(([k]) => k !== DENIAL_EVENT)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [name, total] of events) {
      const d = Object.hasOwn(s.eventDelta, name) ? (s.eventDelta[name] ?? 0) : 0;
      out.push([
        seg(`${clean(name)} `, 'dim'),
        seg(String(num(total))),
        ...(d > 0 ? [seg(` +${d}`, 'warn')] : [])
      ]);
    }
  }
  return out;
}

function Lines({ lines, width, theme }: { lines: readonly Line[]; width: number; theme: Theme }) {
  return (
    <>
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate">
          {fit(line, width).map((sg, j) => (
            <Text key={j} color={theme.color[sg.tone]}>
              {sg.t}
            </Text>
          ))}
        </Text>
      ))}
    </>
  );
}

/** Rows a bordered Panel spends on its border and title. */
const PANEL_CHROME = 3;
/** Fewest body lines a bordered panel gets; below it the dash renders compact. */
export const MIN_BODY = 3;
/** SERVICE is short and steady: it never takes more than this many body lines. */
const SERVICE_CAP = 4;
/** ENGINE's tallies are the tail of a long list: past this, LIVE TRAFFIC gets the rows. */
const ENGINE_CAP = 10;
/** Compact: SERVICE keeps its first three lines (liveness, subscriptions, embed). */
const COMPACT_SERVICE_CAP = 3;

/** `total` lines dealt round-robin to sections wanting `want[i]` each, none past `caps[i]`. */
export function share(
  want: readonly number[],
  total: number,
  caps: readonly number[] = []
): number[] {
  const got = want.map(() => 0);
  let left = Math.max(0, total);
  let grew = true;
  while (left > 0 && grew) {
    grew = false;
    for (let i = 0; i < want.length && left > 0; i++) {
      const cap = Math.min(want[i] ?? 0, caps[i] ?? Number.POSITIVE_INFINITY);
      if ((got[i] ?? 0) < cap) {
        got[i] = (got[i] ?? 0) + 1;
        left--;
        grew = true;
      }
    }
  }
  return got;
}

const TITLES = ['service', 'engine', 'live traffic'] as const;
const TONES: readonly Tone[] = ['accentAlt', 'error', 'accent'];

/**
 * The dash panel, never taller than `size.rows`: SERVICE, ENGINE and LIVE TRAFFIC stacked, each
 * the full width. SERVICE and ENGINE are capped and LIVE TRAFFIC takes the rows left over; when
 * the rows cannot give each bordered panel MIN_BODY lines, one compact list with a title line
 * per section.
 */
export function DashView({ state, theme, size }: { state: DashState; theme: Theme; size: Size }) {
  const footer = size.rows >= 2 ? 1 : 0;
  const room = size.rows - footer;
  const inner = Math.max(1, size.columns - 4);
  const stackRoom = room - 3 * PANEL_CHROME;
  const bordered = stackRoom >= 3 * MIN_BODY;
  const lines = [
    serviceLines(state, theme),
    engineLines(state, theme, !bordered),
    trafficLines(state, theme, bordered ? inner : size.columns, !bordered)
  ];
  const foot =
    footer === 1 ? (
      <Text color={theme.color.dim} wrap="truncate">
        {truncateCells(`  r refresh · s sort (${state.sort}) · esc close`, size.columns)}
      </Text>
    ) : null;

  if (!bordered) {
    // Each section's first line rides on its title row: two more rows for the traffic keys.
    const got = share(
      lines.map((l) => Math.max(1, l.length)),
      room,
      [COMPACT_SERVICE_CAP]
    );
    const flat: Line[] = [];
    lines.forEach((l, i) => {
      const n = got[i] ?? 0;
      if (n === 0) return;
      const title = seg(`${theme.glyph.title} ${TITLES[i]?.toUpperCase()} `, TONES[i] ?? 'accent');
      flat.push([title, ...(l[0] ?? [])]);
      flat.push(...l.slice(1, n));
    });
    return (
      <Box flexDirection="column" width={size.columns}>
        <Lines lines={flat} width={size.columns} theme={theme} />
        {foot}
      </Box>
    );
  }

  const bodies = share(
    lines.map((l) => l.length),
    stackRoom,
    [SERVICE_CAP, ENGINE_CAP]
  );
  return (
    <Box flexDirection="column" width={size.columns}>
      {lines.map((l, i) => (
        <Panel
          key={TITLES[i]}
          title={TITLES[i] ?? ''}
          theme={theme}
          tone={TONES[i] ?? 'accent'}
          width={size.columns}
        >
          <Lines lines={l.slice(0, Math.max(1, bodies[i] ?? 1))} width={inner} theme={theme} />
        </Panel>
      ))}
      {foot}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

interface Run {
  readonly timer: ReturnType<typeof setInterval>;
  /** Aborted when the poller stops: in-flight fetches for a closed panel give up. */
  readonly abort: AbortController;
  busy: boolean;
  /** An `r` arrived mid-tick: run exactly one more tick when this one finishes. */
  again: boolean;
}

export function dashModule(
  deps: TuiDeps,
  opts: {
    intervalMs?: number;
    timeoutMs?: number;
    /** Monotonic ms, for timing metrics samples. Default performance.now. */
    clock?: () => number;
  } = {}
): TuiModule<Panels> {
  const clock = opts.clock ?? (() => performance.now());
  const every = opts.intervalMs ?? DASH_INTERVAL_MS;
  const limit = opts.timeoutMs ?? DASH_TIMEOUT_MS;
  let run: Run | null = null;
  let disposed = false;

  const stop = () => {
    if (run === null) return;
    clearInterval(run.timer);
    run.abort.abort();
    run = null;
  };

  /** `f` with its own deadline: it settles by `limit` whether or not it honours the signal. */
  const within = <T,>(
    f: (signal: AbortSignal) => Promise<T>,
    parents: readonly AbortSignal[]
  ): Promise<Src<T>> => {
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_res, rej) => {
      timer = setTimeout(() => {
        deadline.abort();
        rej(new Error('timed out'));
      }, limit);
    });
    const signal = AbortSignal.any([...parents, deadline.signal]);
    return Promise.race([Promise.resolve().then(() => f(signal)), timeout])
      .then(
        (value): Src<T> => ({ ok: true, value }),
        (err): Src<T> => ({ ok: false, why: classify(err) })
      )
      .finally(() => clearTimeout(timer));
  };

  const sampleOf = async (parents: readonly AbortSignal[]): Promise<Sample> => {
    // `within` never rejects, so every source reports, each by its own deadline.
    let metricsAt: number | undefined;
    const metricsP = within(async (sg) => {
      const m = await deps.metrics(sg);
      metricsAt = clock();
      return m;
    }, parents);
    const [health, metrics, embed, errors] = await Promise.all([
      within(async (sg) => healthOf(await deps.getJson('/health', sg)), parents),
      metricsP,
      within(async (sg) => embedOf(await deps.getJson('/substrate/v1/embed-stats', sg)), parents),
      within((sg) => deps.errors(sg), parents)
    ]);
    return {
      health,
      metrics,
      embed,
      errors,
      ...(metricsAt !== undefined ? { metricsAt } : {})
    };
  };

  /**
   * Whether the dash panel is the open one: ctx.update only calls back for an open panel. Core
   * has no close hook, so this probe is what lets a tick stop BEFORE fetching once the panel has
   * gone. It costs one re-render per tick (core rebuilds the overlay even for an unchanged
   * state); folding it into the post-fetch update would leave one fetch after every close.
   */
  const isOpen = (ctx: Ctx): boolean => {
    let open = false;
    ctx.update('dash', (s) => {
      open = true;
      return s;
    });
    return open;
  };

  const tick = async (ctx: Ctx, queue = false) => {
    const cur = run;
    if (cur === null || disposed) return;
    if (!isOpen(ctx)) return stop();
    if (cur.busy) {
      if (queue) cur.again = true;
      return;
    }
    cur.busy = true;
    try {
      const sample = await sampleOf([ctx.signal, cur.abort.signal]);
      if (run !== cur || disposed) return;
      let applied = false;
      ctx.update('dash', (s) => {
        applied = true;
        return step(s, sample, Date.now());
      });
      if (!applied) stop();
    } finally {
      cur.busy = false;
    }
    if (cur.again && run === cur && !disposed) {
      cur.again = false;
      void tick(ctx);
    }
  };

  return defineModule<Panels>('substrate.dash', {
    commands: [
      {
        name: 'dash',
        summary: 'service, traffic and engine metrics, live while open',
        args: [],
        run(_args, ctx) {
          if (disposed) return;
          stop();
          ctx.open('dash', initialDash());
          run = {
            timer: setInterval(() => void tick(ctx), every),
            abort: new AbortController(),
            busy: false,
            again: false
          };
          void tick(ctx);
        }
      }
    ],
    panels: {
      dash: {
        view: ({ state, theme, size }) => <DashView state={state} theme={theme} size={size} />,
        keymap: [
          { key: 'r', act: 'refresh' },
          { key: 's', act: 'sort' }
        ],
        on: {
          refresh: (_s, ctx) => {
            void tick(ctx, true);
            return undefined;
          },
          sort: (s) => ({ ...s, sort: nextSort(s.sort) })
        }
      }
    },
    init() {
      disposed = false;
      return () => {
        disposed = true;
        stop();
      };
    }
  });
}
