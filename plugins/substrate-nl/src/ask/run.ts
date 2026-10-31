import type { Dropped, PlanClause, Query, SubstrateRequest } from '@mnmal-ai/substrate/sdk';
import type { NlEngineAccess, NlEnvelope } from '../access.js';
import { type Judge, type JudgedResult, parseWithJudge } from '../judge/judge.js';
import { own } from '../own.js';
import type { ServedPack } from '../pack/service.js';
import { type Candidate, type ParseContext, parseQuestion } from '../parse/parse.js';
import type { AskRequest, NlEvent, NlOutcome } from './events.js';

export interface AskDeps {
  pack: ServedPack;
  engine: NlEngineAccess;
  judge?: Judge;
  judgeTimeoutMs?: number;
  now?: () => Date;
}

const RECALL_K = 10;

/**
 * The frame a candidate needs to run. A count is the server's `count: true`
 * over the reading's where; `paged` is the rows frame with every projectable
 * field, which a count falls back to when the server cannot count.
 */
function executable(c: Candidate, pack: ServedPack, paged = c.answer !== 'count'): Query {
  const [key, value] = Object.entries(c.frame)[0] as [string, { params: Record<string, unknown> }];
  const { count: _count, ...params } = value.params;
  if (!paged) {
    // Ordering never changes a count, and the engine refuses one beside `count`.
    const { orderBy: _o, limit: _l, derive: _d, ...counted } = params;
    return { [key]: { params: { ...counted, count: true }, fields: { id: true } } } as Query;
  }
  const fields: Record<string, true> = { id: true };
  for (const [name, f] of Object.entries(own(pack.types, c.type)?.fields ?? {})) {
    if (f.kind !== 'metadata') fields[name] = true;
  }
  return { [key]: { params, fields } } as Query;
}

/** The engine refused `count: true`: walks are off, or the seed is under a row policy. */
const COUNT_REFUSED = new Set(['walks_disabled', 'row_policy_blocks_walk']);

/**
 * The parser's plan with the engine's `served`/`recommend` where the engine
 * planned the same clause (matched by path: the engine's path is a prefix of
 * the parser's labelled one, or, for a NOT, extends it). Parser-only clauses
 * keep their entries; engine-only clauses are appended.
 */
export function mergePlan(parsed: PlanClause[], engine: PlanClause[] | undefined): PlanClause[] {
  if (engine === undefined) return parsed;
  const kindOf = (c: PlanClause) =>
    c.kind === 'derive' && c.path[0] === 'orderBy' ? 'order' : c.kind;
  const prefix = (a: string[], b: string[]) =>
    a.length <= b.length && a.every((x, i) => x === b[i]);
  const used = new Set<PlanClause>();
  const out = parsed.map((p) => {
    const same = engine.filter((e) => kindOf(e) === kindOf(p));
    const under = same
      .filter((e) => prefix(e.path, p.path))
      .sort((x, y) => y.path.length - x.path.length);
    const matches =
      under.length > 0
        ? [under[0] as PlanClause]
        : same.filter((e) => prefix(p.path.slice(0, -1), e.path));
    if (matches.length === 0) return p;
    for (const m of matches) used.add(m);
    const { recommend: _r, ...rest } = p;
    const recommend = matches.find((m) => !m.served)?.recommend;
    return {
      ...rest,
      served: matches.every((m) => m.served),
      ...(recommend !== undefined ? { recommend } : {})
    };
  });
  return [...out, ...engine.filter((e) => !used.has(e))];
}

async function rows(
  c: Candidate,
  source: 'parser' | 'judge' | 'handoff',
  question: string,
  http: SubstrateRequest,
  deps: AskDeps,
  handoff?: string,
  leftovers: Dropped[] = []
): Promise<NlOutcome> {
  const dropped = [...c.dropped, ...leftovers];
  if (c.strict && dropped.some((d) => d.kind === 'filter'))
    return { kind: 'unknown', question, dropped, plan: c.plan };
  let frame = executable(c, deps.pack);
  const key = Object.keys(frame)[0] as string;
  let env = await deps.engine.query(frame, http);
  const refused = (env.errors ?? []).some((e) =>
    COUNT_REFUSED.has((e as { code?: string }).code ?? '')
  );
  const paging = c.answer === 'count' && !(key in (env.data ?? {})) && refused;
  if (paging) {
    frame = executable(c, deps.pack, true);
    env = await deps.engine.query(frame, http);
  }
  const present = env.data !== undefined && key in env.data;
  const data = present ? env.data?.[key] : undefined;
  const errors = [...(env.errors ?? [])];
  let count: number | undefined;
  if (paging && Array.isArray(data)) {
    const counted = await countRest(frame, key, data.length, env, http, deps);
    if (typeof counted === 'number') count = counted;
    else errors.push(counted);
  } else if (c.answer === 'count' && typeof (data as { count?: unknown })?.count === 'number') {
    count = (data as { count: number }).count;
  }
  return {
    kind: 'rows',
    frame,
    answer: c.answer,
    data,
    ...(count !== undefined ? { count } : {}),
    ...(errors.length > 0 ? { errors } : {}),
    source,
    ...(handoff !== undefined ? { handoff } : {}),
    dropped,
    plan: mergePlan(c.plan, env._diagnostics?.[key]?.plan)
  };
}

// shortcut: the fallback when the server refuses `count: true` pages ids at the
// engine's default page size, so a type past MAX_COUNT_PAGES pages gets no
// count; deleted in Task 23 except for row-policy seeds.
const MAX_COUNT_PAGES = 1000;

/** The population a count candidate matches: `seen` rows from page one, then id-only pages after its cursor. */
async function countRest(
  frame: Query,
  key: string,
  seen: number,
  first: NlEnvelope,
  http: SubstrateRequest,
  deps: AskDeps
): Promise<number | { code: string; message: string }> {
  const params = (frame as Record<string, { params: Record<string, unknown> }>)[key]?.params ?? {};
  let count = seen;
  let page = first._pagination?.[key];
  for (let pages = 1; page?.hasMore === true; pages++) {
    if (pages >= MAX_COUNT_PAGES || page.nextCursor === undefined || isAborted(http)) {
      return {
        code: 'count_incomplete',
        message: `counted ${count} rows and stopped before the end; the true count is higher`
      };
    }
    const env = await deps.engine.query(
      { [key]: { params: { ...params, cursor: page.nextCursor }, fields: { id: true } } } as Query,
      http
    );
    const rows = env.data?.[key];
    if (!Array.isArray(rows)) {
      return {
        code: 'count_incomplete',
        message: `counted ${count} rows, then a page failed: ${JSON.stringify(env.errors ?? [])}`
      };
    }
    count += rows.length;
    page = env._pagination?.[key];
  }
  return count;
}

async function recall(
  query: string,
  ns: string,
  type: string,
  http: SubstrateRequest,
  deps: AskDeps
): Promise<NlOutcome> {
  const frame = {
    'recall/Hit': {
      params: { to: query, namespace: ns, type, k: RECALL_K },
      fields: { id: true, namespace: true, type: true, score: true, row: true }
    }
  } as Query;
  const env = await deps.engine.query(frame, http);
  const hits = env.data?.['recall/Hit'];
  return {
    kind: 'recall',
    query,
    // Absent key means the engine rejected the frame, not that nothing matched.
    hits: Array.isArray(hits) ? hits : undefined,
    ...(env.errors !== undefined && env.errors.length > 0 ? { errors: env.errors } : {})
  };
}

function clarify(
  question: string,
  reason: string,
  candidates: Candidate[],
  pack: ServedPack
): NlOutcome {
  const seen = new Set<string>();
  const options = [];
  for (const c of candidates) {
    if (seen.has(c.type)) continue;
    seen.add(c.type);
    const phrase = own(pack.types, c.type)?.phrases[0] ?? c.type;
    options.push({ label: `${phrase} (${c.type})`, question, type: c.type });
  }
  return { kind: 'clarify', question, reason, options };
}

// A function call, so TS does not narrow `signal.aborted` across the awaits between checks.
const isAborted = (http: SubstrateRequest): boolean => http.signal?.aborted === true;

export async function* runAsk(
  req: AskRequest,
  http: SubstrateRequest,
  deps: AskDeps
): AsyncGenerator<NlEvent> {
  const ctx: ParseContext = {
    asOf: (deps.now ?? (() => new Date()))().toISOString(),
    rulings: deps.pack.rulings,
    ...(req.project !== undefined ? { project: req.project } : {}),
    ...(req.type !== undefined ? { forceType: req.type } : {})
  };
  const first = parseQuestion(req.question, deps.pack, ctx);
  const best = first.candidates[0];
  yield {
    event: 'parsed',
    status: first.status,
    ...(best !== undefined ? { frame: executable(best, deps.pack) } : {}),
    evidence: best?.evidence ?? first.evidence ?? [],
    residual: first.residual,
    ...(first.reason !== undefined ? { reason: first.reason } : {})
  };
  if (isAborted(http)) return yield { event: 'done' };

  /**
   * No judge decided: the parser's reading runs as it stands. Its unexplained
   * words are dropped, so a strict reading with any is `unknown`, never a number.
   */
  const handoff = async (reason: string, parsed = first): Promise<NlOutcome> => {
    const best = parsed.candidates[0];
    if (best === undefined) return clarify(req.question, reason, parsed.candidates, deps.pack);
    const leftovers = best.residual.map((w) => ({
      span: w,
      reason: `not understood (${reason})`,
      kind: 'filter' as const
    }));
    return rows(best, 'handoff', req.question, http, deps, reason, leftovers);
  };

  let outcome: NlOutcome;
  if (first.status === 'resolved' && best !== undefined) {
    outcome = await rows(best, 'parser', req.question, http, deps);
  } else if (first.status === 'refuse') {
    outcome = { kind: 'refuse', reason: first.reason ?? 'refused' };
  } else if (first.status === 'clarify') {
    outcome = clarify(
      req.question,
      first.reason ?? 'which did you mean?',
      first.candidates,
      deps.pack
    );
  } else if (deps.judge === undefined) {
    outcome = await handoff('judge not configured');
  } else {
    yield { event: 'judging', reason: first.reason ?? first.status };
    // setTimeout rather than AbortSignal.timeout: the latter runs on Node's
    // internal timers, which vitest's fake timers cannot advance.
    const ac = new AbortController();
    const timer = setTimeout(
      () => ac.abort(new Error('judge timeout')),
      deps.judgeTimeoutMs ?? 20_000
    );
    const onAbort = () => ac.abort(http.signal?.reason);
    http.signal?.addEventListener('abort', onAbort, { once: true });
    if (isAborted(http)) onAbort();
    let judged: JudgedResult | undefined;
    try {
      const judging = parseWithJudge(req.question, deps.pack, ctx, deps.judge, {
        signal: ac.signal,
        exists: async (type, where) => {
          if (ac.signal.aborted) return false;
          const key = `${deps.pack.namespace}/${type}`;
          const env = await deps.engine.query(
            { [key]: { params: { where, limit: 1 }, fields: { id: true } } } as Query,
            http
          );
          const r = env.data?.[key];
          return Array.isArray(r) && r.length > 0;
        }
      });
      // A judge that ignores its signal must not hold the run open: its
      // promise is abandoned, and a late rejection is swallowed.
      judging.catch(() => {});
      const gone = new Promise<never>((_, reject) => {
        const fire = () => reject(ac.signal.reason);
        if (ac.signal.aborted) fire();
        else ac.signal.addEventListener('abort', fire, { once: true });
      });
      judged = await Promise.race([judging, gone]);
    } catch {
      judged = undefined;
    } finally {
      clearTimeout(timer);
      http.signal?.removeEventListener('abort', onAbort);
    }
    if (isAborted(http)) return yield { event: 'done' };
    if (judged === undefined) {
      outcome = await handoff('judge unavailable');
    } else {
      yield { event: 'judged', status: judged.status, trail: judged.trail };
      switch (judged.status) {
        case 'resolved': {
          // Words the judge's pick called noise are still lost from the answer: say so.
          const noise = judged.candidate.residual.map((w) => ({
            span: w,
            reason: 'judge: noise',
            kind: 'filter' as const
          }));
          outcome = await rows(
            judged.candidate,
            'judge',
            req.question,
            http,
            deps,
            undefined,
            noise
          );
          break;
        }
        case 'recall':
          // A type the caller forced outranks the judge's pick, as it does for rows.
          outcome = await recall(
            judged.query,
            deps.pack.namespace,
            ctx.forceType ?? judged.type,
            http,
            deps
          );
          break;
        case 'refuse':
          outcome = { kind: 'refuse', reason: judged.reason };
          break;
        case 'clarify':
          outcome = clarify(req.question, judged.reason, first.candidates, deps.pack);
          break;
        case 'escalated':
          // The judge's reading, not the parser's first: an escalated pick carries only its choice.
          // A re-parse (type, bind) that left no reading falls back to the parser's, under the same rule.
          outcome = await handoff(
            'judge could not decide',
            judged.result.candidates.length > 0 ? judged.result : first
          );
          break;
      }
    }
  }
  yield { event: 'outcome', outcome };
  yield { event: 'done' };
}
