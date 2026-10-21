/**
 * `substrate.doctor` — the command centre. diagnose runs in the background for the TUI's
 * lifetime: once at start, then every interval, one run at a time with a deadline. The
 * verdict is a `doctor` status cell, and a step flipping between done and todo prints one
 * line. `/doctor` shows the latest result live. Locked, it diagnoses the agent identity
 * without expecting admin; unlocked, the admin identity, through `run(…, { touch: false })`
 * so that watching never holds the admin session open. It reports and never acts — fixing
 * belongs to `substrate-admin onboard`.
 */

import {
  CURRENT_MARK,
  currentStep,
  type DiagnoseResult,
  type OnboardStep,
  type OnboardStepStatus,
  planOnboarding,
  diagnose as realDiagnose,
  STEP_MARKS
} from '@mnmal-ai/substrate/client';
import { defineModule, type ModuleCtx, sanitise, type TuiModule } from '@mnmal-ai/surface-core';
import { truncateCells } from '@mnmal-ai/surface-kit';
import { adminCapabilityOf } from '../admin/session.js';
import type { TuiDeps } from '../deps.js';
import { noticesFor, oneLine, PENDING, statusMap, timedOutResult, verdictOf } from './watch.js';

export const DOCTOR_INTERVAL_MS = 60_000;
export const DOCTOR_DEADLINE_MS = 20_000;

export interface DoctorState {
  who: 'agent' | 'admin';
  steps: readonly OnboardStep[] | null;
  error: string | null;
  checkedAt: number | null;
  nextAt: number | null;
  running: boolean;
}
type Panels = { doctor: DoctorState };
type Ctx = ModuleCtx<Panels>;

/** diagnose's default advice names the admin env, which is wrong for the agent identity. */
export const AGENT_CREDENTIAL_FIX =
  "Set SUBSTRATE_AGENT_KEY_ID and SUBSTRATE_AGENT_KEY_PATH in this repo's .claude/settings.local.json " +
  'env, or /admin unlock to diagnose as the admin identity.';

export function doctorModule(
  deps: TuiDeps,
  io: {
    diagnose?: typeof realDiagnose;
    intervalMs?: number;
    deadlineMs?: number;
    now?: () => number;
  } = {}
): TuiModule<Panels> {
  const diagnose = io.diagnose ?? realDiagnose;
  const intervalMs = io.intervalMs ?? DOCTOR_INTERVAL_MS;
  const deadlineMs = io.deadlineMs ?? DOCTOR_DEADLINE_MS;
  const now = io.now ?? Date.now;
  const whoNow = (): DoctorState['who'] => (deps.admin.unlocked() ? 'admin' : 'agent');

  // Loop state lives in the factory and is reset in init, as substrate.status does.
  let latest: DoctorState;
  let baseline: { who: DoctorState['who']; map: ReadonlyMap<string, OnboardStepStatus> } | null;
  let running: boolean;
  let again: boolean;
  /** Set only across the doctor's own 401 lock, so the listener leaves its explanation up. */
  let selfLocking = false;
  /** Bumped on every lock: an admin run that saw one, even if since re-unlocked, is discarded. */
  let locks = 0;

  const publish = (ctx: Ctx, patch: Partial<DoctorState>) => {
    latest = { ...latest, ...patch };
    const snapshot = latest;
    ctx.update('doctor', () => snapshot);
  };

  /** One diagnose under `who`, raced against the deadline. Null means the deadline won. */
  const attempt = async (ctx: Ctx, who: DoctorState['who']): Promise<DiagnoseResult | null> => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), deadlineMs);
    const signal = AbortSignal.any([ctx.signal, deadline.signal]);
    const fetchWith = ((url: string | URL | Request, init?: RequestInit) =>
      fetch(url, { ...init, signal })) as typeof fetch;
    const timedOut = new Promise<null>((resolve) =>
      signal.addEventListener('abort', () => resolve(null), { once: true })
    );
    const run =
      who === 'admin'
        ? deps.admin.run(
            ({ authorization }) =>
              diagnose({
                baseUrl: deps.endpoint,
                credential: { authorization, label: 'the unlocked admin identity' },
                ...adminCapabilityOf(deps.adminEnv),
                fetch: fetchWith
              }),
            { touch: false }
          )
        : diagnose({
            baseUrl: deps.endpoint,
            credential:
              deps.agentAuthorization !== null
                ? { authorization: deps.agentAuthorization, label: 'the agent identity' }
                : { error: 'no agent identity configured (anonymous)', fix: AGENT_CREDENTIAL_FIX },
            expectAdmin: false,
            fetch: fetchWith
          });
    try {
      return await Promise.race([run, timedOut]);
    } finally {
      clearTimeout(timer);
      // Releases the composite signal and its listener (Node keeps it alive while one is
      // attached), and cancels any request the run left behind.
      deadline.abort();
    }
  };

  const runOnce = async (ctx: Ctx): Promise<void> => {
    // An unlock or a keypress can land after teardown has begun; nothing may start then.
    if (ctx.signal.aborted) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    const who = whoNow();
    const epoch = locks;
    const stale = () =>
      ctx.signal.aborted || (who === 'admin' && (locks !== epoch || !deps.admin.unlocked()));
    publish(ctx, { running: true, who });
    try {
      const result = (await attempt(ctx, who)) ?? timedOutResult(deadlineMs);
      if (stale()) return;
      // diagnose reports a rejected credential as a check, so the session's own 401 lock never fires.
      const identity = result.checks.find((c) => c.name === 'identity');
      if (who === 'admin' && identity?.status === 'no' && identity.httpStatus === 401) {
        selfLocking = true;
        try {
          deps.admin.lock('admin locked: 401 — the admin key was rejected');
        } finally {
          selfLocking = false;
        }
      }
      const steps = planOnboarding(result, {
        canBootstrap: false,
        skipped: new Set(),
        explainNoBootstrap: false
      });
      const verdict = verdictOf(steps);
      ctx.status('doctor', verdict.text, verdict.tone);
      if (baseline !== null && baseline.who === who) {
        for (const n of noticesFor(baseline.map, steps)) ctx.print(sanitise(n.text), n.tone);
      }
      const carried = baseline !== null && baseline.who === who ? baseline.map : undefined;
      baseline = { who, map: statusMap(steps, carried) };
      publish(ctx, {
        who,
        steps,
        error: null,
        checkedAt: now(),
        nextAt: now() + intervalMs,
        running: false
      });
    } catch (err) {
      if (stale()) return;
      // A check that could not run must not keep reading as the last good verdict.
      ctx.status('doctor', 'doctor ✗ could not run', 'error');
      publish(ctx, {
        who,
        error: err instanceof Error ? err.message : String(err),
        running: false
      });
    } finally {
      running = false;
      if (latest.running) publish(ctx, { running: false });
      if (again && !ctx.signal.aborted) {
        again = false;
        void runOnce(ctx);
      }
    }
  };

  return defineModule<Panels>('substrate.doctor', {
    commands: [
      {
        name: 'doctor',
        summary: 'live checks for this deployment',
        args: [],
        run: (_, ctx) => {
          ctx.open('doctor', latest);
          void runOnce(ctx);
        }
      }
    ],
    panels: {
      doctor: {
        view: ({ state, theme, size }) => {
          const w = Math.max(1, size.columns - 2);
          const clock = (t: number) => new Date(t).toTimeString().slice(0, 8);
          const when =
            state.running || state.checkedAt === null
              ? ' · checking…'
              : ` · checked ${clock(state.checkedAt)}` +
                (state.nextAt !== null ? ` · next ${clock(state.nextAt)}` : '');
          const head = truncateCells(
            `${theme.glyph.title} doctor · ${state.who} identity${when}`,
            w
          );
          if (state.error !== null) {
            return [
              head,
              truncateCells(sanitise(`could not run: ${oneLine(state.error)}`), w)
            ].join('\n');
          }
          if (state.steps === null) return [head, '  checking…'].join('\n');
          const current = currentStep(state.steps);
          const nameW = Math.max(...state.steps.map((s) => s.name.length));
          const lines = state.steps.flatMap((s) => {
            const mark = s === current ? CURRENT_MARK : STEP_MARKS[s.status];
            const tag = s.optional ? ' (optional)' : '';
            return [
              truncateCells(
                sanitise(`${mark} ${s.name.padEnd(nameW)}  ${oneLine(s.detail)}${tag}`),
                w
              ),
              ...(s.status === 'todo' && s.fix !== undefined
                ? [truncateCells(sanitise(`    fix: ${oneLine(s.fix)}`), w)]
                : [])
            ];
          });
          return [head, ...lines, `${verdictOf(state.steps).text} · r re-check · esc close`].join(
            '\n'
          );
        },
        keymap: [{ key: 'r', act: 'rerun' }],
        on: {
          rerun: (_s, ctx) => {
            void runOnce(ctx);
            return undefined;
          }
        }
      }
    },
    init(ctx) {
      latest = {
        who: whoNow(),
        steps: null,
        error: null,
        checkedAt: null,
        nextAt: null,
        running: false
      };
      baseline = null;
      running = false;
      again = false;
      ctx.status('doctor', PENDING.text, PENDING.tone);
      void runOnce(ctx);
      const timer = setInterval(() => {
        // A tick during a run is dropped; only explicit requests coalesce.
        if (!running) void runOnce(ctx);
      }, intervalMs);
      // The session also reports every touch as 'unlocked'; only a lock/unlock flip changes
      // what the doctor can see, so only a flip re-runs and resets the baseline.
      let lastKind = deps.admin.unlocked() ? 'unlocked' : 'locked';
      const off = deps.admin.onChange((st) => {
        if (st.kind === lastKind) return;
        lastKind = st.kind;
        baseline = null;
        if (st.kind === 'locked') {
          locks += 1;
          if (!selfLocking) {
            let adminOpen = false;
            ctx.update('doctor', (s) => {
              adminOpen = s.who === 'admin';
              return s;
            });
            if (adminOpen) {
              ctx.close();
              ctx.print('doctor closed — admin locked', 'warn');
            }
          }
        }
        // The identity flipped: look again now, under the identity that is current. Not after
        // the doctor's own 401 lock, whose result explains the lock and stays on screen; the
        // next tick moves on as the agent.
        if (!selfLocking) void runOnce(ctx);
      });
      return () => {
        clearInterval(timer);
        off();
      };
    }
  });
}
