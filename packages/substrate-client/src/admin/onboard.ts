/**
 * The plan behind `substrate-admin onboard`: diagnose's checks in dependency order,
 * plus two goals diagnose does not fail on — a second admin key and a first
 * agent. Pure: it DESCRIBES the action that would fix a step and never performs
 * one, so postgres access and key generation stay with the caller.
 */

import type { DiagnoseResult, DoctorCheck } from './diagnose.js';

export type OnboardStepStatus = 'done' | 'todo' | 'blocked' | 'skipped';

export type OnboardAction =
  | { readonly kind: 'bootstrap' }
  | { readonly kind: 'register-admin' }
  | { readonly kind: 'register-agent' }
  | { readonly kind: 'revoke'; readonly kids: readonly string[] };

export interface OnboardStep {
  readonly name: string;
  readonly status: OnboardStepStatus;
  readonly detail: string;
  /** Present on `todo`: what to do, whether or not an action can do it. */
  readonly fix?: string;
  /** Present only on `todo`, and only when a client can perform the fix. */
  readonly action?: OnboardAction;
  /** Optional steps never hold up completion. */
  readonly optional: boolean;
  readonly skippable: boolean;
}

export interface PlanOnboardingOpts {
  /** The caller can reach postgres (`SUBSTRATE_DATABASE_URL`), which `bootstrap` needs. */
  readonly canBootstrap: boolean;
  /** Steps the operator skipped this run. Honoured only for skippable steps. */
  readonly skipped: ReadonlySet<string>;
  /**
   * Default true: a credential NO that bootstrap cannot fix is explained in onboarding's
   * terms (SUBSTRATE_DATABASE_URL). A caller that only reports, about an identity that is not the
   * admin's, passes false to keep the check's own fix.
   */
  readonly explainNoBootstrap?: boolean;
}

const SECOND_ADMIN = 'second-admin';
const FIRST_AGENT = 'first-agent';

export const ONBOARD_STEPS: readonly string[] = [
  'reachable',
  'auth-enabled',
  'credential',
  'identity',
  'admin-capability',
  'admin-floor',
  SECOND_ADMIN,
  'namespaces',
  'key-directory',
  FIRST_AGENT
];

export const SKIPPABLE_STEPS: ReadonlySet<string> = new Set([SECOND_ADMIN, FIRST_AGENT]);

/** The checklist marks every surface draws, so the CLI and the TUI cannot drift. */
export const STEP_MARKS: Readonly<Record<OnboardStepStatus, string>> = {
  done: '✓',
  todo: '·',
  blocked: '⊘',
  skipped: '↷'
};
/** Marks the step the operator is on: the first `todo`. */
export const CURRENT_MARK = '▶';

const NO_BOOTSTRAP_FIX =
  'No admin credential resolves, and `bootstrap` needs SUBSTRATE_DATABASE_URL (a postgres:// URL) — run ' +
  'onboard where the database is reachable, or set SUBSTRATE_ADMIN_TOKEN / ' +
  'SUBSTRATE_ADMIN_KEY_PATH + SUBSTRATE_ADMIN_KEY_ID for an existing admin.';

function fromCheck(name: string, check: DoctorCheck | undefined): OnboardStep {
  const base = { name, optional: false, skippable: false };
  if (check === undefined) {
    return { ...base, status: 'blocked', detail: 'not reported — an earlier step stopped the run' };
  }
  if (check.status === 'ok') return { ...base, status: 'done', detail: check.detail };
  if (check.status === 'skip') return { ...base, status: 'blocked', detail: check.detail };
  return {
    ...base,
    status: 'todo',
    detail: check.detail,
    ...(check.fix !== undefined ? { fix: check.fix } : {})
  };
}

interface Goal {
  readonly name: string;
  readonly optional: boolean;
  /** False when the fact this goal reads was never measured. */
  readonly measured: boolean;
  readonly met: boolean;
  readonly detail: { readonly met: string; readonly unmet: string; readonly blocked: string };
  readonly fix: string;
  readonly action: OnboardAction;
}

function fromGoal(goal: Goal, skipped: ReadonlySet<string>): OnboardStep {
  const base = { name: goal.name, optional: goal.optional, skippable: true };
  if (!goal.measured) return { ...base, status: 'blocked', detail: goal.detail.blocked };
  if (goal.met) return { ...base, status: 'done', detail: goal.detail.met };
  if (skipped.has(goal.name)) return { ...base, status: 'skipped', detail: goal.detail.unmet };
  return { ...base, status: 'todo', detail: goal.detail.unmet, fix: goal.fix, action: goal.action };
}

export function planOnboarding(result: DiagnoseResult, opts: PlanOnboardingOpts): OnboardStep[] {
  const byName = new Map(result.checks.map((c) => [c.name, c]));
  const { facts } = result;
  const steps: OnboardStep[] = [];
  for (const name of ONBOARD_STEPS) {
    if (name === SECOND_ADMIN) {
      const admins = facts.adminKids;
      steps.push(
        fromGoal(
          {
            name,
            optional: false,
            measured: byName.get('admin-floor')?.status === 'ok' && admins !== undefined,
            met: (admins?.length ?? 0) >= 2,
            detail: {
              met: `${admins?.length ?? 0} admin keys — succession is possible`,
              unmet:
                'one admin key. Losing it locks this deployment out of its own admin surface, ' +
                'and the floor will refuse to revoke it.',
              blocked: 'not measured — admin-floor did not pass'
            },
            fix: 'Register a second admin key, held somewhere other than the first.',
            action: { kind: 'register-admin' }
          },
          opts.skipped
        )
      );
      continue;
    }
    if (name === FIRST_AGENT) {
      const agents = facts.agentKids;
      steps.push(
        fromGoal(
          {
            name,
            optional: true,
            measured: agents !== undefined,
            met: (agents?.length ?? 0) > 0,
            detail: {
              met: `${agents?.length ?? 0} agent identities with a live key`,
              unmet: 'no agent identity yet — register one to exercise the route and directory',
              blocked: 'not measured — the directory could not be read'
            },
            fix: 'Register a first agent identity.',
            action: { kind: 'register-agent' }
          },
          opts.skipped
        )
      );
      continue;
    }
    const step = fromCheck(name, byName.get(name));
    if (step.status !== 'todo') {
      steps.push(step);
      continue;
    }
    if (name === 'credential') {
      steps.push(
        opts.canBootstrap
          ? { ...step, action: { kind: 'bootstrap' } }
          : opts.explainNoBootstrap === false
            ? step
            : { ...step, fix: NO_BOOTSTRAP_FIX }
      );
      continue;
    }
    const retired = facts.retiredWithLiveKey ?? [];
    if (name === 'key-directory' && retired.length > 0) {
      steps.push({ ...step, action: { kind: 'revoke', kids: retired } });
      continue;
    }
    steps.push(step);
  }
  return steps;
}

/** The step the operator is on: the first one still to do. */
export function currentStep(steps: readonly OnboardStep[]): OnboardStep | undefined {
  return steps.find((s) => s.status === 'todo');
}

/** True while any required step is still to do — the `--check` verdict. */
export function requiredOutstanding(steps: readonly OnboardStep[]): boolean {
  return steps.some((s) => s.status === 'todo' && !s.optional);
}
