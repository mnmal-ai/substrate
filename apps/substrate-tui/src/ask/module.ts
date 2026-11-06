import type { NlServedPack, NlWireEvent, TypeSchema } from '@mnmal-ai/substrate/sdk';
import { complete } from '@mnmal-ai/substrate-nl/complete';
import {
  defineModule,
  listPager,
  type ModuleCtx,
  sanitise,
  type TuiModule,
  type TurnUpdate
} from '@mnmal-ai/surface-core';
import type { TuiDeps } from '../deps.js';
import '../events.js';
import { adapt } from './adapt.js';
import { listHooks } from './list.js';
import { own, type Presentation, parseTui } from './present.js';
import { KIND, outcomeChips, type RowsReply, renderers, rowsList } from './render.js';

export interface ClarifyState {
  question: string;
  reason: string;
  options: { label: string; question: string; type: string }[];
}
export interface FrameState {
  lines: string[];
}
export type AskPanels = { clarify: ClarifyState; frame: FrameState };

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

// Duck-typed on purpose: a real NetworkError carries status/code/serverMessage, and
// instanceof would break across a duplicated substrate-client realm.
function explain(err: unknown, endpoint: string): string {
  const e = err as { status?: number; code?: string; serverMessage?: string; message?: string };
  if (e.status === 404 && e.code !== 'nl_unknown_namespace')
    return `substrate-nl is not installed on ${endpoint}`;
  if (e.serverMessage !== undefined) return e.serverMessage;
  if (e.status === 401 || e.status === 403)
    return `not authorised (${e.status}) — check SUBSTRATE_AGENT_KEY_ID / SUBSTRATE_AGENT_KEY_PATH`;
  return e.message ?? String(err);
}

/** What the server accepts for `asOf`: a date-time with an explicit offset. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The ask module. A plain list of rows goes to `pager`, whose module the app must also register;
 * the default is for an app that registers it from here, as the tests do.
 */
export function askModule(
  deps: TuiDeps,
  pager: ReturnType<typeof listPager> = listPager()
): TuiModule<AskPanels> {
  let namespace = deps.namespace;
  let pack: NlServedPack | null = null;
  let forceType: string | undefined;
  /** The clock relative phrases are read against; undefined = the server's. */
  let asOf: string | undefined;
  let last: FrameState = { lines: ['no question asked yet'] };
  let lastPackNote = '';
  /** The namespace's `annotations.tui`; empty until read, and when it cannot be. */
  let present: Presentation = { types: {}, problems: [] };
  /** The namespace's types, for reading a listed row's record whole; empty until read. */
  let types: Record<string, TypeSchema> = {};

  const loadPack = (ctx: ModuleCtx<AskPanels>) => {
    pack = null;
    const ns = namespace;
    present = { types: {}, problems: [] };
    types = {};
    deps.getJson(`/substrate/v1/schema/${encodeURIComponent(ns)}`, ctx.signal).then(
      (s) => {
        if (ns !== namespace) return;
        // A schema the parser cannot read must fall back, never reject this promise unhandled.
        try {
          const t = (s as { types?: unknown } | null)?.types;
          if (t !== null && typeof t === 'object') types = t as Record<string, TypeSchema>;
          present = parseTui((s as { annotations?: { tui?: unknown } } | null)?.annotations?.tui);
        } catch {
          present = { types: {}, problems: [{ text: 'tui ignored: unreadable' }] };
        }
      },
      // Without the schema, rows render generically; nothing to tell.
      () => {}
    );
    deps.nl.pack(ns, { signal: ctx.signal }).then(
      (p) => {
        if (ns === namespace) pack = p;
      },
      (err) => {
        if (ns !== namespace) return;
        // Same failure on repeated /ns would otherwise repeat the same note.
        const note = `completion unavailable for ${ns}: ${explain(err, deps.endpoint)}`;
        if (note === lastPackNote) return;
        lastPackNote = note;
        ctx.print(note, 'dim');
      }
    );
  };

  /** A rows outcome with its frame type's declared view, when the namespace declares one. */
  const withView = (o: Extract<NlWireEvent, { event: 'rows' }>['data']): RowsReply => {
    const [ns, type] = (Object.keys(o.frame)[0] ?? '').split('/');
    const view = ns === namespace && type !== undefined ? own(present.types, type) : undefined;
    return view !== undefined ? { ...o, tui: view } : o;
  };

  /** A rows answer as a list the pager pages, with Enter and `r` wired to the row's type. */
  const asList = (o: RowsReply, ctx: ModuleCtx<AskPanels>) => {
    const list = rowsList(o);
    if (list === undefined) return undefined;
    const [ns = namespace, type = ''] = (Object.keys(o.frame)[0] ?? '').split('/');
    // Keyed as rowsList keys its rows: by id, else by position.
    const answered = new Map(
      (o.data as Record<string, unknown>[]).map((r, i) => [
        typeof r.id === 'string' ? r.id : String(i),
        r
      ])
    );
    const fields = ns === namespace ? own(types, type)?.fields : undefined;
    return pager.present(list, listHooks(deps, ns, type, fields, answered, ctx.signal));
  };

  const pick = (i: number) => (s: ClarifyState, ctx: ModuleCtx<AskPanels>) => {
    const opt = s.options[i];
    if (opt === undefined) return undefined;
    forceType = opt.type;
    ctx.close();
    ctx.submit(opt.question);
    return undefined;
  };

  return defineModule<AskPanels>('substrate.ask', {
    init(ctx) {
      loadPack(ctx);
      ctx.emit('substrate/ns', { namespace });
      return undefined;
    },
    commands: [
      {
        name: 'ns',
        summary: 'switch the namespace questions go to',
        args: [{ name: 'namespace' }],
        run([ns], ctx) {
          if (ns === undefined || ns === '') return ctx.print(`namespace: ${namespace}`);
          namespace = ns;
          loadPack(ctx);
          ctx.emit('substrate/ns', { namespace });
          ctx.print(`namespace → ${namespace}`);
        }
      },
      {
        name: 'asof',
        summary:
          'read "yesterday", "past 2 days" … as of a date-time (ISO-8601 with an offset); off for the server clock',
        args: [{ name: 'datetime|off' }],
        run([v], ctx) {
          if (v === undefined || v === '') return ctx.print(`asOf: ${asOf ?? 'server clock'}`);
          if (v === 'off') {
            asOf = undefined;
            return ctx.print('asOf → server clock');
          }
          if (!ISO_WITH_OFFSET.test(v) || Number.isNaN(Date.parse(v)))
            return ctx.print(
              'asOf needs an ISO-8601 date-time with an offset, e.g. 2026-10-24T23:59:59-05:00'
            );
          asOf = v;
          ctx.print(`asOf → ${asOf}`);
        }
      },
      {
        name: 'frame',
        summary: "show the last answer's query frame, evidence and judge trail",
        args: [],
        run: (_a, ctx) => ctx.open('frame', last)
      }
    ],
    panels: {
      clarify: {
        view: ({ state }) =>
          [
            `? ${sanitise(state.reason)}`,
            ...state.options.slice(0, 9).map((o, i) => `  ${i + 1}. ${sanitise(o.label)}`),
            '  1–9 choose · esc dismiss'
          ].join('\n'),
        keymap: DIGITS.map((d, i) => ({ key: d, act: `pick${i}` })),
        on: Object.fromEntries(DIGITS.map((_d, i) => [`pick${i}`, pick(i)]))
      },
      frame: { view: ({ state }) => sanitise(state.lines.join('\n')) }
    },
    completers: [
      {
        id: 'nl',
        // Match on the text before the cursor; adapt runs the span on to the token end.
        complete: (draft, cursor) => {
          if (pack === null) return [];
          return complete(draft.slice(0, cursor), cursor, pack).map((s) => adapt(draft, cursor, s));
        }
      }
    ],
    turns: [
      {
        id: 'ask',
        claims: (text) => (text.trim() === '' ? false : 1),
        async *answer(text, ctx, signal): AsyncIterable<TurnUpdate> {
          const type = forceType;
          forceType = undefined;
          const lines: string[] = [];
          try {
            for await (const ev of deps.nl.ask(
              {
                namespace,
                question: text,
                project: deps.project,
                ...(asOf !== undefined ? { asOf } : {}),
                ...(type !== undefined ? { type } : {})
              },
              { signal }
            ) as AsyncIterable<NlWireEvent>) {
              switch (ev.event) {
                case 'parsed': {
                  const key =
                    ev.data.frame !== undefined ? Object.keys(ev.data.frame)[0] : undefined;
                  lines.push(
                    `parse: ${ev.data.status}${ev.data.reason !== undefined ? ` — ${ev.data.reason}` : ''}`
                  );
                  if (ev.data.asOf !== undefined) lines.push(`asOf: ${ev.data.asOf}`);
                  if (ev.data.frame !== undefined)
                    lines.push(JSON.stringify(ev.data.frame, null, 2));
                  for (const e of ev.data.evidence)
                    lines.push(`  ${e.span} → ${e.role} (${e.detail})`);
                  yield {
                    phase: 'partial',
                    reply: { kind: KIND.line, data: `▸ ${key ?? namespace} · parsing…` }
                  };
                  break;
                }
                case 'judging':
                  lines.push(`judging: ${ev.data.reason}`);
                  yield { phase: 'partial', reply: { kind: KIND.line, data: 'judging…' } };
                  break;
                case 'judged':
                  lines.push(`judged: ${ev.data.status}`);
                  for (const step of ev.data.trail) lines.push(`  ${JSON.stringify(step)}`);
                  break;
                case 'rows':
                case 'recall':
                case 'clarify':
                case 'refuse':
                case 'unknown': {
                  // Only what bears on this answer: whole-block problems and the answered type's.
                  const answered =
                    ev.event === 'rows' ? Object.keys(ev.data.frame)[0]?.split('/')[1] : undefined;
                  for (const p of present.problems)
                    if (p.type === undefined || p.type === answered) lines.push(`tui: ${p.text}`);
                  last = { lines };
                  if (ev.event === 'clarify' && ev.data.options.length > 0)
                    ctx.open('clarify', ev.data);
                  // A stale clarify from an earlier question must not outlive a different outcome;
                  // ctx.close() only closes this module's own overlay.
                  else ctx.close();
                  const data = ev.event === 'rows' ? withView(ev.data) : ev.data;
                  const listed = ev.event === 'rows' ? asList(data as RowsReply, ctx) : undefined;
                  const chips = outcomeChips(ev.data);
                  yield {
                    phase: 'final',
                    reply:
                      listed !== undefined
                        ? { ...listed, chips }
                        : { kind: `substrate.${ev.event}`, data, chips }
                  };
                  return;
                }
                case 'done':
                  return;
              }
            }
          } catch (err) {
            if (signal.aborted) return;
            yield {
              phase: 'failed',
              reply: { kind: KIND.error, data: explain(err, deps.endpoint) }
            };
          }
        }
      }
    ],
    renderers
  });
}
