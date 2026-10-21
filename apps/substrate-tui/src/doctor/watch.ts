/**
 * The command centre's judgement, kept pure: a verdict cell from the onboarding plan, and the
 * notices between two consecutive runs. Only a done↔todo flip speaks, and a blocked
 * step is never an endpoint of one: an outage announces itself once, through `reachable`, rather
 * than once per step behind it. The baseline carries each step's last measured status through a
 * blocked run, so a step that was done before an outage and is todo after it still warns.
 */

import type { DiagnoseResult, OnboardStep, OnboardStepStatus } from '@mnmal-ai/substrate/client';

export type CellTone = 'dim' | 'warn' | 'error';
export interface Verdict {
  readonly text: string;
  readonly tone: CellTone;
}
export interface Notice {
  readonly text: string;
  readonly tone: 'dim' | 'warn';
}

export const PENDING: Verdict = { text: 'doctor …', tone: 'dim' };

export const oneLine = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

export function verdictOf(steps: readonly OnboardStep[]): Verdict {
  if (steps.find((s) => s.name === 'reachable')?.status === 'todo') {
    return { text: 'doctor ✗ unreachable', tone: 'error' };
  }
  const todo = steps.filter((s) => s.status === 'todo' && !s.optional);
  const first = todo[0];
  if (first !== undefined) {
    const more = todo.length > 1 ? ` +${todo.length - 1}` : '';
    return { text: `doctor ⚠ ${first.name}${more}`, tone: 'warn' };
  }
  const counted = steps.filter((s) => s.status !== 'blocked');
  const done = counted.filter((s) => s.status === 'done').length;
  return { text: `doctor ✓ ${done}/${counted.length}`, tone: 'dim' };
}

/** The baseline after `steps`: a blocked step keeps the status `prev` last measured for it. */
export function statusMap(
  steps: readonly OnboardStep[],
  prev: ReadonlyMap<string, OnboardStepStatus> = new Map()
): ReadonlyMap<string, OnboardStepStatus> {
  return new Map(
    steps.map((s) => [s.name, s.status === 'blocked' ? (prev.get(s.name) ?? 'blocked') : s.status])
  );
}

export function noticesFor(
  prev: ReadonlyMap<string, OnboardStepStatus>,
  steps: readonly OnboardStep[]
): Notice[] {
  const out: Notice[] = [];
  for (const s of steps) {
    const before = prev.get(s.name);
    if (before === 'done' && s.status === 'todo') {
      out.push({
        text: `⚠ doctor: ${s.name} went NO — ${oneLine(s.detail)} · /doctor`,
        tone: 'warn'
      });
    } else if (before === 'todo' && s.status === 'done') {
      out.push({ text: `✓ doctor: ${s.name} recovered`, tone: 'dim' });
    }
  }
  return out;
}

/** A run that missed its deadline, shaped so the planner reads it as an unreachable server. */
export function timedOutResult(deadlineMs: number): DiagnoseResult {
  return {
    checks: [
      {
        name: 'reachable',
        status: 'no',
        detail: `no answer within ${Math.round(deadlineMs / 1000)}s`,
        fix: 'Check the service (`systemctl status substrate-binary`) and the network path.'
      }
    ],
    exitCode: 1,
    identity: null,
    facts: {}
  };
}
