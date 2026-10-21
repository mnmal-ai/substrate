import { describe, expect, it } from 'vitest';
import {
  CURRENT_MARK,
  currentStep,
  type DiagnoseResult,
  type DoctorCheck,
  ONBOARD_STEPS,
  planOnboarding,
  requiredOutstanding,
  STEP_MARKS
} from '../src/index.js';

const ok = (name: string): DoctorCheck => ({ name, status: 'ok', detail: `${name} fine` });
const no = (name: string, fix = `fix ${name}`): DoctorCheck => ({
  name,
  status: 'no',
  detail: `${name} broken`,
  fix
});
const skip = (name: string): DoctorCheck => ({ name, status: 'skip', detail: 'not asked' });

const CHECKS = [
  'reachable',
  'auth-enabled',
  'credential',
  'identity',
  'admin-capability',
  'admin-floor',
  'namespaces',
  'key-directory'
];
const allOk = (): DoctorCheck[] => CHECKS.map(ok);
const result = (checks: DoctorCheck[], facts: DiagnoseResult['facts'] = {}): DiagnoseResult => ({
  checks,
  exitCode: checks.some((c) => c.status === 'no') ? 1 : 0,
  identity: null,
  facts
});
const FULL = {
  adminKids: ['a1', 'a2'],
  liveKeyCount: 3,
  retiredWithLiveKey: [],
  liveKeyWithoutRow: [],
  agentKids: ['agent']
};
const opts = { canBootstrap: true, skipped: new Set<string>() };
const step = (steps: ReturnType<typeof planOnboarding>, name: string) => {
  const s = steps.find((x) => x.name === name);
  if (s === undefined) throw new Error(`no step ${name}`);
  return s;
};
const withNo = (name: string): DoctorCheck[] =>
  allOk().map((c) => (c.name === name ? no(name) : c));

describe('planOnboarding', () => {
  it('emits every step in ONBOARD_STEPS order', () => {
    expect(planOnboarding(result(allOk(), FULL), opts).map((s) => s.name)).toEqual(ONBOARD_STEPS);
    expect(ONBOARD_STEPS).toEqual([
      'reachable',
      'auth-enabled',
      'credential',
      'identity',
      'admin-capability',
      'admin-floor',
      'second-admin',
      'namespaces',
      'key-directory',
      'first-agent'
    ]);
  });

  it('a fully set-up deployment: all done, nothing outstanding', () => {
    const steps = planOnboarding(result(allOk(), FULL), opts);
    expect(steps.every((s) => s.status === 'done')).toBe(true);
    expect(currentStep(steps)).toBeUndefined();
    expect(requiredOutstanding(steps)).toBe(false);
  });

  it('a diagnose skip is blocked, never done; a check diagnose never emitted is blocked too', () => {
    const checks = [ok('reachable'), ok('auth-enabled'), no('credential'), skip('identity')];
    const steps = planOnboarding(result(checks), opts);
    expect(step(steps, 'identity').status).toBe('blocked');
    expect(step(steps, 'key-directory').status).toBe('blocked');
    expect(step(steps, 'second-admin').status).toBe('blocked');
    expect(step(steps, 'first-agent').status).toBe('blocked');
  });

  it('credential NO offers bootstrap only when the caller can bootstrap', () => {
    const checks = [ok('reachable'), ok('auth-enabled'), no('credential')];
    expect(step(planOnboarding(result(checks), opts), 'credential').action).toEqual({
      kind: 'bootstrap'
    });
    const without = step(
      planOnboarding(result(checks), { ...opts, canBootstrap: false }),
      'credential'
    );
    expect(without.status).toBe('todo');
    expect(without.action).toBeUndefined();
    expect(without.fix).toContain('SUBSTRATE_DATABASE_URL');
  });

  it('server-side failures carry the fix and no action', () => {
    const steps = planOnboarding(result([ok('reachable'), no('auth-enabled', 'set it')]), opts);
    const auth = step(steps, 'auth-enabled');
    expect(auth.status).toBe('todo');
    expect(auth.action).toBeUndefined();
    expect(auth.fix).toBe('set it');
    expect(currentStep(steps)?.name).toBe('auth-enabled');
  });

  it('one admin key: second-admin is a required, skippable todo offering register-admin', () => {
    const steps = planOnboarding(result(allOk(), { ...FULL, adminKids: ['a1'] }), opts);
    const second = step(steps, 'second-admin');
    expect(second.status).toBe('todo');
    expect(second.optional).toBe(false);
    expect(second.skippable).toBe(true);
    expect(second.action).toEqual({ kind: 'register-admin' });
    expect(requiredOutstanding(steps)).toBe(true);
  });

  it('a skipped second-admin renders skipped, never done', () => {
    const steps = planOnboarding(result(allOk(), { ...FULL, adminKids: ['a1'] }), {
      ...opts,
      skipped: new Set(['second-admin'])
    });
    expect(step(steps, 'second-admin').status).toBe('skipped');
    expect(requiredOutstanding(steps)).toBe(false);
  });

  it('a skip on a non-skippable step is ignored', () => {
    const steps = planOnboarding(result([ok('reachable'), no('auth-enabled')]), {
      ...opts,
      skipped: new Set(['auth-enabled'])
    });
    expect(step(steps, 'auth-enabled').status).toBe('todo');
  });

  it('retired identities holding live keys: key-directory offers revoke of exactly those kids', () => {
    const steps = planOnboarding(
      result(withNo('key-directory'), { ...FULL, retiredWithLiveKey: ['old1', 'old2'] }),
      opts
    );
    expect(step(steps, 'key-directory').action).toEqual({ kind: 'revoke', kids: ['old1', 'old2'] });
  });

  it('a live key with no row: key-directory is todo with no action', () => {
    const steps = planOnboarding(
      result(withNo('key-directory'), { ...FULL, liveKeyWithoutRow: ['orphan'] }),
      opts
    );
    const dir = step(steps, 'key-directory');
    expect(dir.status).toBe('todo');
    expect(dir.action).toBeUndefined();
  });

  it('no agents: first-agent is an optional todo, and does not count as outstanding', () => {
    const steps = planOnboarding(result(allOk(), { ...FULL, agentKids: [] }), opts);
    const first = step(steps, 'first-agent');
    expect(first.status).toBe('todo');
    expect(first.optional).toBe(true);
    expect(first.action).toEqual({ kind: 'register-agent' });
    expect(requiredOutstanding(steps)).toBe(false);
  });

  it('agentKids absent (directory unreadable) is blocked, not "no agents"', () => {
    const checks = allOk().map((c) => (c.name === 'key-directory' ? skip('key-directory') : c));
    const steps = planOnboarding(
      result(checks, { adminKids: ['a1', 'a2'], liveKeyCount: 2 }),
      opts
    );
    expect(step(steps, 'first-agent').status).toBe('blocked');
  });

  it('second-admin is blocked while admin-floor is not ok', () => {
    const steps = planOnboarding(result(withNo('admin-floor'), { adminKids: [] }), opts);
    expect(step(steps, 'admin-floor').action).toBeUndefined();
    expect(step(steps, 'second-admin').status).toBe('blocked');
  });
});

describe('checklist marks', () => {
  it('one distinct mark per status, plus the current-step mark', () => {
    expect(STEP_MARKS).toEqual({ done: '✓', todo: '·', blocked: '⊘', skipped: '↷' });
    expect(CURRENT_MARK).toBe('▶');
  });
});

describe('planOnboarding for a caller that only reports', () => {
  it('explainNoBootstrap false keeps the check’s own credential fix', () => {
    const checks = [ok('reachable'), ok('auth-enabled'), no('credential', 'set the agent key')];
    const s = planOnboarding(result(checks), {
      canBootstrap: false,
      skipped: new Set(),
      explainNoBootstrap: false
    }).find((x) => x.name === 'credential');
    expect(s?.fix).toBe('set the agent key');
    expect(s?.action).toBeUndefined();
  });
});
