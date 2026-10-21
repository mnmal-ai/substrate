/**
 * The surgery commands: `/drop-namespace`, `/drop-type`, `/backfill`, `/normalise` and
 * `/reindex` each open the one `surgery` panel, which previews, then applies only once the exact
 * target is typed (tier 2). Stages: previewing → preview → applying → done | refused | stopped.
 * Every update after an await goes through `ours`, which writes only into the panel this op opened:
 * a closed panel, or a later command's, is never written by an earlier request.
 *
 * One surgery write at a time: while an apply is in flight every surgery command is unavailable,
 * until that apply settles, even if a lock closed its panel. Opening any other panel stops a
 * running reindex between pages (its loop reads "is my panel still open?" as its stop check), and
 * the transcript says where: `■ reindex stopped at <ns>/<Type> (cursor …)`.
 * An apply request that never returns keeps that flag set: a lock does not cancel a request
 * already in flight (the admin session's contract), so only restarting the TUI clears it.
 */

import { readFileSync } from 'node:fs';
import { AdminBackfillError, AuthError, NetworkError } from '@mnmal-ai/substrate/client';
import { defineModule, type ModuleCtx, sanitise, type TuiModule } from '@mnmal-ai/surface-core';
import { truncateCells } from '@mnmal-ai/surface-kit';
import type { Theme } from '@mnmal-ai/surface-theme';
import type { ReactNode } from 'react';
import { refusalOf } from '../admin/refusal.js';
import type { TuiDeps } from '../deps.js';
import { type Line, linesView } from '../lines.js';
import { parseOp, type SurgeryCommand, type SurgeryOp, type TypeRef, targetOf } from './args.js';
import { type Preview, type PreviewEnv, previewOf, refusalDetail } from './preview.js';
import { runReindex, type TypeProgress } from './reindex.js';

export interface SurgeryState {
  readonly op: SurgeryOp;
  readonly stage: 'previewing' | 'preview' | 'applying' | 'done' | 'refused' | 'stopped';
  readonly preview: Preview | null;
  /** Lines appended by apply: progress, the result, or the refusal. */
  readonly result: readonly Line[];
  readonly mismatch: boolean;
  /** A stop was asked for; the reindex loop reads it between pages. */
  readonly stopping: boolean;
}

type Panels = { surgery: SurgeryState };
type Ctx = ModuleCtx<Panels>;

const line = (text: string, tone?: Line['tone']): Line => ({
  text: sanitise(text),
  ...(tone !== undefined ? { tone } : {})
});

const SUMMARY: Record<SurgeryCommand, string> = {
  'drop-namespace': 'delete every row of a namespace (admin; previews first, then type the target)',
  'drop-type': 'delete every row of a type (admin; previews first, then type the target)',
  backfill: 'write a field from a JSON file of row id → value (admin)',
  normalise: "migrate a field's aliases to their canonical values (admin)",
  reindex: 're-embed every row of the embedded types, page by page (admin)'
};

const name = (t: TypeRef) => `${t.namespace}/${t.type}`;

function progressLines(progress: readonly TypeProgress[]): Line[] {
  const w = Math.max(...progress.map((p) => name(p.ref).length));
  return progress.map((p) =>
    line(
      `  ${name(p.ref).padEnd(w)}  scanned ${p.scanned} · embedded ${p.embedded} · unindexable ${p.unindexable} · failed ${p.failed}${p.done ? ' ✓' : ''}`,
      p.failed > 0 ? 'warn' : undefined
    )
  );
}

const zero = (ref: TypeRef): TypeProgress => ({
  ref,
  scanned: 0,
  embedded: 0,
  unindexable: 0,
  failed: 0,
  pages: 0,
  done: false
});

/** A 4xx guarantees the failing backfill chunk wrote nothing (substrate-client AdminBackfillError). */
function is4xx(err: unknown): boolean {
  const s = err instanceof NetworkError || err instanceof AuthError ? err.status : undefined;
  return s !== undefined && s >= 400 && s < 500;
}

function surgeryView(
  s: SurgeryState,
  theme: Theme,
  size: { columns: number; rows: number }
): ReactNode {
  const w = Math.max(1, size.columns - 2);
  const fit = (l: Line): Line => ({ ...l, text: truncateCells(l.text, w) });
  const target = sanitise(targetOf(s.op));
  const head = line(`${theme.glyph.title} surgery › ${target} · ${s.stage}`);
  const body: Line[] = [...(s.preview?.lines ?? [])];
  const foot: Line[] = [];
  switch (s.stage) {
    case 'previewing':
      body.push(line('previewing…', 'dim'));
      foot.push(line('esc closes', 'dim'));
      break;
    case 'preview':
      if (s.preview?.kind === 'ready') {
        foot.push(line(`type ${target} then enter to apply · esc closes`));
        if (s.mismatch) foot.push(line("doesn't match", 'error'));
      } else {
        foot.push(line('apply is unavailable — esc closes'));
      }
      break;
    case 'applying':
      if (s.op.kind === 'reindex') {
        foot.push(...s.result);
        foot.push(
          line(s.stopping ? '  stopping after this page…' : '  esc stops after this page', 'dim')
        );
      } else {
        foot.push(...s.result, line('applying…', 'dim'));
      }
      break;
    case 'done':
    case 'refused':
    case 'stopped':
      foot.push(...s.result, line('esc closes', 'dim'));
      break;
  }
  // The footer says what Enter and Esc do: it keeps its rows, and the preview gives way.
  const room = Math.max(0, size.rows - 1 - foot.length);
  const shown =
    body.length <= room
      ? body
      : [...body.slice(0, Math.max(0, room - 1)), line(`… ${body.length - room + 1} more`, 'dim')];
  return linesView([head, ...shown, ...foot].map(fit), theme);
}

export function surgeryModule(
  deps: TuiDeps,
  io: { readFile?: (p: string) => string; home?: string } = {}
): TuiModule<Panels> {
  const readFile = io.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  // Bumped by every lock: a reindex running under an earlier unlock stops at its next check,
  // whichever panel is open by then.
  let generation = 0;
  // An apply in flight, whichever panel is open by now: every surgery command waits for it.
  let writing = false;
  const settled = () => {
    writing = false;
  };

  /** Runs `fn` on the panel only if it is still the one `op` opened; says whether it was. */
  const ours = (ctx: Ctx, op: SurgeryOp, fn: (s: SurgeryState) => SurgeryState): boolean => {
    let open = false;
    ctx.update('surgery', (s) => {
      if (s.op !== op) return s;
      open = true;
      return fn(s);
    });
    return open;
  };

  async function open(command: SurgeryCommand, args: readonly string[], ctx: Ctx): Promise<void> {
    const op = parseOp(command, args);
    if ('error' in op) {
      ctx.print(op.error, 'error');
      return;
    }
    ctx.open('surgery', {
      op,
      stage: 'previewing',
      preview: null,
      result: [],
      mismatch: false,
      stopping: false
    });
    const env: PreviewEnv = {
      readFile,
      ...(io.home !== undefined ? { home: io.home } : {}),
      signal: ctx.signal
    };
    try {
      const preview = await deps.admin.run(({ client }) => previewOf(op, client.admin, env));
      ours(ctx, op, (s) => (s.stage === 'previewing' ? { ...s, stage: 'preview', preview } : s));
    } catch (err) {
      const r = refusalOf(err);
      ours(ctx, op, (s) =>
        s.stage === 'previewing'
          ? { ...s, stage: 'refused', result: [line(`${r.code}: ${r.message}`, 'error')] }
          : s
      );
    }
  }

  /** Starts the apply the preview planned; the panel moves through `ours`. */
  function apply(s: SurgeryState, typed: string, ctx: Ctx): SurgeryState {
    const preview = s.preview;
    if (preview?.kind !== 'ready') return s;
    const op = s.op;
    const plan = preview.apply;
    // Read before the request: a lock landing mid-request must not turn the attribution unknown.
    const st = deps.admin.state();
    const who = st.kind === 'unlocked' ? st.kid : 'unknown';
    const by = `(admin: ${who})`;

    /** A refusal: into the panel, or to the transcript when the panel has gone. */
    const refuse = (lines: Line[]) => {
      if (!ours(ctx, op, (x) => ({ ...x, stage: 'refused', result: [...x.result, ...lines] }))) {
        for (const l of lines) ctx.print(l.text, 'error');
      }
    };
    /** A write that landed: always to the transcript, and into the panel while it is open. */
    const done = (text: string) => {
      const l = line(text, 'ok');
      ctx.print(l.text, 'ok');
      ours(ctx, op, (x) => ({ ...x, stage: 'done', result: [...x.result, l] }));
    };
    const refusalLines = (err: unknown) => {
      const r = refusalOf(err);
      return [line(`${r.code}: ${r.message}`, 'error'), ...refusalDetail(r, op)];
    };
    /** The planner and the op disagree: unreachable, so it throws to surface-core's guard rather than hide. */
    const mismatched = (): never => {
      throw new Error(`surgery: a ${plan.kind} plan for a ${op.kind} apply`);
    };

    switch (op.kind) {
      case 'drop-namespace':
      case 'drop-type': {
        const cascade = op.cascade ? ('delete' as const) : ('refuse' as const);
        writing = true;
        deps.admin
          .run(({ client }) =>
            op.kind === 'drop-namespace'
              ? client.admin.dropNamespace({
                  namespace: op.namespace,
                  confirm: typed,
                  cascade,
                  dryRun: false
                })
              : client.admin.dropType({
                  namespace: op.namespace,
                  type: op.type,
                  confirm: typed,
                  cascade,
                  dryRun: false
                })
          )
          .then(
            (r) =>
              done(
                `✓ dropped ${op.kind === 'drop-namespace' ? 'namespace' : 'type'} ${targetOf(op)}: ${r.rowsDeleted} rows, ${r.edgesDeleted} edges ${by}`
              ),
            (err: unknown) => refuse(refusalLines(err))
          )
          .finally(settled);
        break;
      }
      case 'backfill': {
        if (plan.kind !== 'backfill') return mismatched();
        writing = true;
        deps.admin
          .run(({ client }) =>
            client.admin.backfill(
              {
                namespace: op.namespace,
                type: op.type,
                field: op.field,
                values: plan.values,
                overwrite: op.overwrite,
                apply: true
              },
              {
                onChunk: (c) => {
                  ours(ctx, op, (x) => ({
                    ...x,
                    result: [line(`chunk ${c.index + 1}/${c.chunks} written`, 'dim')]
                  }));
                }
              }
            )
          )
          .then(
            (r) => done(`✓ backfilled ${targetOf(op)}: wrote ${r.write} of ${r.requested} ${by}`),
            (err: unknown) => {
              const lines = refusalLines(err);
              if (err instanceof AdminBackfillError) {
                if (err.chunksDone > 0) {
                  lines.push(
                    line(
                      `  ${err.chunksDone} of ${err.chunks} chunk(s) were written before the refusal ${by}`,
                      'warn'
                    )
                  );
                }
                if (!is4xx(err.cause)) {
                  lines.push(
                    line("the failing chunk's own state is unknown — re-running is safe", 'warn')
                  );
                }
              }
              // Earlier chunks may be written: the transcript keeps the record whether or not the
              // panel is still open.
              for (const l of lines) ctx.print(l.text, 'error');
              ours(ctx, op, (x) => ({ ...x, stage: 'refused', result: [...x.result, ...lines] }));
            }
          )
          .finally(settled);
        break;
      }
      case 'normalise': {
        writing = true;
        deps.admin
          .run(({ client }) =>
            client.admin.normalise({
              namespace: op.namespace,
              type: op.type,
              field: op.field,
              reject: op.reject,
              apply: true
            })
          )
          .then(
            (r) => {
              const sum = (xs: readonly { count: number }[] | undefined) =>
                (xs ?? []).reduce((a, x) => a + x.count, 0);
              done(
                `✓ normalised ${targetOf(op)}: migrated ${sum(r.migrated)}, stranded ${sum(r.stranded)} ${by}`
              );
            },
            (err: unknown) => {
              const lines = refusalLines(err);
              // Only a 4xx guarantees nothing was written; past that the operator must look again.
              if (is4xx(err)) return refuse(lines);
              lines.push(
                line(
                  'the server-side state is unknown — re-run the preview to see what changed',
                  'warn'
                )
              );
              for (const l of lines) ctx.print(l.text, 'error');
              ours(ctx, op, (x) => ({ ...x, stage: 'refused', result: [...x.result, ...lines] }));
            }
          )
          .finally(settled);
        break;
      }
      case 'reindex': {
        if (plan.kind !== 'reindex') return mismatched();
        writing = true;
        const gen = generation;
        void runReindex(
          plan.types,
          (input) => deps.admin.run(({ client }) => client.admin.reindexPage(input)),
          {
            // A closed panel, a later command's panel, or a lock since this began: stop.
            stopRequested: () => {
              if (gen !== generation) return true;
              let stop = true;
              ours(ctx, op, (x) => {
                stop = x.stopping;
                return x;
              });
              return stop;
            },
            onProgress: (p) => {
              ours(ctx, op, (x) => ({ ...x, result: progressLines(p) }));
            }
          }
        )
          .then((o) => {
            const embedded = o.progress.reduce((a, p) => a + p.embedded, 0);
            const failed = o.progress.reduce((a, p) => a + p.failed, 0);
            const settle = (stage: SurgeryState['stage'], l: Line) => {
              ctx.print(l.text, l.tone);
              ours(ctx, op, (x) => ({
                ...x,
                stage,
                result: [...progressLines(o.progress), l]
              }));
            };
            switch (o.kind) {
              case 'done':
                settle(
                  'done',
                  line(
                    `✓ reindexed ${o.progress.length} type(s): embedded ${embedded}, failed ${failed} ${by}`,
                    'ok'
                  )
                );
                break;
              case 'stopped':
                settle(
                  'stopped',
                  line(
                    o.cursor !== undefined
                      ? `■ reindex stopped at ${name(o.at)} (cursor ${o.cursor}) — embedded ${embedded} so far ${by}`
                      : `■ reindex stopped before ${name(o.at)} — embedded ${embedded} so far ${by}`,
                    'warn'
                  )
                );
                break;
              case 'failed': {
                const r = refusalOf(o.error);
                settle(
                  'refused',
                  line(
                    `reindex failed at ${name(o.at)}: ${r.code}: ${r.message} — embedded ${embedded} so far ${by}`,
                    'error'
                  )
                );
                break;
              }
            }
          })
          .finally(settled);
        return {
          ...s,
          stage: 'applying',
          mismatch: false,
          result: progressLines(plan.types.map(zero))
        };
      }
    }
    return { ...s, stage: 'applying', mismatch: false };
  }

  const command = (c: SurgeryCommand) => ({
    name: c,
    summary: SUMMARY[c],
    args: [{ name: 'target', optional: c === 'reindex' }],
    unavailable: () =>
      !deps.admin.unlocked()
        ? 'admin is locked — /admin unlock'
        : writing
          ? 'a surgery write is in progress — wait for it to report'
          : null,
    run: (args: readonly string[], ctx: Ctx) => open(c, args, ctx)
  });

  return defineModule<Panels>('substrate.surgery', {
    commands: (['drop-namespace', 'drop-type', 'backfill', 'normalise', 'reindex'] as const).map(
      command
    ),
    panels: {
      surgery: {
        view: ({ state, theme, size }) => surgeryView(state, theme, size),
        submit: (s, typed, ctx) => {
          if (!(s.stage === 'preview' && s.preview?.kind === 'ready')) return undefined;
          // Exact: no trim, case-sensitive. For a drop, this is what the server's `confirm` gets.
          return typed === targetOf(s.op) ? apply(s, typed, ctx) : { ...s, mismatch: true };
        },
        escape: (s) => {
          if (s.stage !== 'applying') return undefined;
          // A single request cannot be stopped; a reindex stops after the page in flight.
          return s.op.kind === 'reindex' ? { ...s, stopping: true } : s;
        }
      }
    },
    init(ctx) {
      const off = deps.admin.onChange((st) => {
        if (st.kind !== 'locked') return;
        generation++;
        let open = false;
        let inFlight: SurgeryOp | null = null;
        ctx.update('surgery', (s) => {
          open = true;
          inFlight = s.stage === 'applying' ? s.op : null;
          return s;
        });
        if (!open) return;
        ctx.close();
        // A write already sent keeps going on the client it holds; say so, since its
        // result lands in the transcript after this line.
        const op = inFlight as SurgeryOp | null;
        ctx.print(
          op === null
            ? 'surgery closed — admin locked'
            : op.kind === 'reindex'
              ? 'surgery closed — admin locked; the reindex requests no further page'
              : `surgery closed — admin locked; the ${sanitise(targetOf(op))} ${op.kind} in flight reports its outcome below`,
          'warn'
        );
      });
      return () => {
        off();
      };
    }
  });
}
