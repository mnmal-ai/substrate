import type { NlServedPack, NlWireEvent } from '@mnmal-ai/substrate/sdk';
import { complete } from '@mnmal-ai/substrate-nl/complete';
import {
  defineModule,
  type ModuleCtx,
  sanitise,
  type TuiModule,
  type TurnUpdate
} from '@mnmal-ai/surface-core';
import type { TuiDeps } from '../deps.js';
import '../events.js';
import { adapt } from './adapt.js';
import { KIND, outcomeChips, renderers } from './render.js';

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

export function askModule(deps: TuiDeps): TuiModule<AskPanels> {
  let namespace = deps.namespace;
  let pack: NlServedPack | null = null;
  let forceType: string | undefined;
  let last: FrameState = { lines: ['no question asked yet'] };
  let lastPackNote = '';

  const loadPack = (ctx: ModuleCtx<AskPanels>) => {
    pack = null;
    const ns = namespace;
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
                  last = { lines };
                  if (ev.event === 'clarify' && ev.data.options.length > 0)
                    ctx.open('clarify', ev.data);
                  // A stale clarify from an earlier question must not outlive a different outcome;
                  // ctx.close() only closes this module's own overlay.
                  else ctx.close();
                  yield {
                    phase: 'final',
                    reply: {
                      kind: `substrate.${ev.event}`,
                      data: ev.data,
                      chips: outcomeChips(ev.data)
                    }
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
