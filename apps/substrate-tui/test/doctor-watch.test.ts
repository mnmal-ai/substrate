import { type OnboardStep, planOnboarding } from '@mnmal-ai/substrate/client';
import { describe, expect, it } from 'vitest';
import { noticesFor, statusMap, timedOutResult, verdictOf } from '../src/doctor/watch.js';

const step = (
  name: string,
  status: OnboardStep['status'],
  over: Partial<OnboardStep> = {}
): OnboardStep => ({
  name,
  status,
  detail: `${name} detail`,
  optional: false,
  skippable: false,
  ...over
});

describe('verdictOf', () => {
  it('all required done: ✓ done/counted, blocked steps not counted', () => {
    const v = verdictOf([
      step('reachable', 'done'),
      step('identity', 'done'),
      step('admin-floor', 'blocked')
    ]);
    expect(v).toEqual({ text: 'doctor ✓ 2/2', tone: 'dim' });
  });

  it('an optional todo never turns it amber', () => {
    const v = verdictOf([
      step('reachable', 'done'),
      step('first-agent', 'todo', { optional: true })
    ]);
    expect(v).toEqual({ text: 'doctor ✓ 1/2', tone: 'dim' });
  });

  it('a required todo: ⚠ the first one, +N for the rest', () => {
    expect(verdictOf([step('reachable', 'done'), step('auth-enabled', 'todo')]).text).toBe(
      'doctor ⚠ auth-enabled'
    );
    const two = verdictOf([step('auth-enabled', 'todo'), step('second-admin', 'todo')]);
    expect(two).toEqual({ text: 'doctor ⚠ auth-enabled +1', tone: 'warn' });
  });

  it('reachable todo wins: ✗ unreachable', () => {
    expect(verdictOf([step('reachable', 'todo'), step('auth-enabled', 'blocked')])).toEqual({
      text: 'doctor ✗ unreachable',
      tone: 'error'
    });
  });
});

describe('noticesFor', () => {
  it('done → todo is one warn line naming the step and its detail', () => {
    const prev = statusMap([step('key-directory', 'done')]);
    expect(
      noticesFor(prev, [step('key-directory', 'todo', { detail: 'retired key live' })])
    ).toEqual([
      { text: '⚠ doctor: key-directory went NO — retired key live · /doctor', tone: 'warn' }
    ]);
  });

  it('todo → done is a recovery line', () => {
    const prev = statusMap([step('key-directory', 'todo')]);
    expect(noticesFor(prev, [step('key-directory', 'done')])).toEqual([
      { text: '✓ doctor: key-directory recovered', tone: 'dim' }
    ]);
  });

  it('blocked and skipped transitions are silent, and so are unchanged steps', () => {
    const prev = statusMap([
      step('a', 'done'),
      step('b', 'blocked'),
      step('c', 'todo'),
      step('d', 'todo')
    ]);
    const next = [step('a', 'blocked'), step('b', 'done'), step('c', 'todo'), step('d', 'skipped')];
    expect(noticesFor(prev, next)).toEqual([]);
  });

  it('the baseline carries a step’s last measured status through a blocked run', () => {
    const before = statusMap([step('a', 'done'), step('b', 'todo')]);
    const outage = statusMap([step('a', 'blocked'), step('b', 'blocked')], before);
    expect(outage.get('a')).toBe('done');
    expect(outage.get('b')).toBe('todo');
    expect(noticesFor(outage, [step('a', 'todo'), step('b', 'done')]).map((n) => n.tone)).toEqual([
      'warn',
      'dim'
    ]);
    expect(statusMap([step('c', 'blocked')], new Map()).get('c')).toBe('blocked');
  });

  it('a step absent from the previous run is silent', () => {
    expect(noticesFor(new Map(), [step('a', 'todo')])).toEqual([]);
  });

  it('a multi-line detail collapses to one line', () => {
    const prev = statusMap([step('a', 'done')]);
    const [n] = noticesFor(prev, [step('a', 'todo', { detail: 'line one\nline two\r\n' })]);
    expect(n?.text).toBe('⚠ doctor: a went NO — line one line two · /doctor');
  });
});

describe('timedOutResult', () => {
  it('plans as reachable todo with everything after it blocked', () => {
    const steps = planOnboarding(timedOutResult(20_000), {
      canBootstrap: false,
      skipped: new Set()
    });
    expect(steps.find((s) => s.name === 'reachable')?.status).toBe('todo');
    expect(steps.find((s) => s.name === 'reachable')?.detail).toContain('20s');
    expect(steps.filter((s) => s.name !== 'reachable').every((s) => s.status === 'blocked')).toBe(
      true
    );
    expect(verdictOf(steps).text).toBe('doctor ✗ unreachable');
  });
});
