import type { Query, SubstrateRequest } from '@mnmal-ai/substrate/sdk';
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

/** The frame a candidate needs to run: its params plus every projectable field of its type. */
function executable(c: Candidate, pack: ServedPack): Query {
  const [key, value] = Object.entries(c.frame)[0] as [string, { params: Record<string, unknown> }];
  const fields: Record<string, true> = { id: true };
  for (const [name, f] of Object.entries(own(pack.types, c.type)?.fields ?? {})) {
    if (f.kind !== 'metadata') fields[name] = true;
  }
  return { [key]: { params: value.params, fields } } as Query;
}

async function rows(
  c: Candidate,
  source: 'parser' | 'judge' | 'handoff',
  http: SubstrateRequest,
  deps: AskDeps,
  handoff?: string
): Promise<NlOutcome> {
  const frame = executable(c, deps.pack);
  const key = Object.keys(frame)[0] as string;
  const env = await deps.engine.query(frame, http);
  const present = env.data !== undefined && key in env.data;
  const data = present ? env.data?.[key] : undefined;
  const errors = [...(env.errors ?? [])];
  let count: number | undefined;
  if (c.answer === 'count' && Array.isArray(data)) {
    const counted = await countRest(frame, key, data.length, env, http, deps);
    if (typeof counted === 'number') count = counted;
    else errors.push(counted);
  }
  return {
    kind: 'rows',
    frame,
    answer: c.answer,
    data,
    ...(count !== undefined ? { count } : {}),
    ...(errors.length > 0 ? { errors } : {}),
    source,
    ...(handoff !== undefined ? { handoff } : {})
  };
}

// shortcut: counts by paging ids at the engine's default page size, so a type
// past MAX_COUNT_PAGES pages gets no count; upgrade to a server-side count
// aggregate when one exists.
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

  let outcome: NlOutcome;
  if (first.status === 'resolved' && best !== undefined) {
    outcome = await rows(best, 'parser', http, deps);
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
    outcome =
      best !== undefined
        ? await rows(best, 'handoff', http, deps, 'judge not configured')
        : clarify(req.question, 'judge not configured', first.candidates, deps.pack);
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
      outcome =
        best !== undefined
          ? await rows(best, 'handoff', http, deps, 'judge unavailable')
          : clarify(req.question, 'judge unavailable', first.candidates, deps.pack);
    } else {
      yield { event: 'judged', status: judged.status, trail: judged.trail };
      switch (judged.status) {
        case 'resolved':
          outcome = await rows(judged.candidate, 'judge', http, deps);
          break;
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
          outcome =
            best !== undefined
              ? await rows(best, 'handoff', http, deps, 'judge could not decide')
              : clarify(req.question, 'judge could not decide', first.candidates, deps.pack);
          break;
      }
    }
  }
  yield { event: 'outcome', outcome };
  yield { event: 'done' };
}
