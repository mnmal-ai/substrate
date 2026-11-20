import { describe, expect, it } from 'vitest';
import type { StepResult } from '../examples/_harness.ts';
import { seedSteps } from '../examples/_scenario.ts';
import { loadExample } from '../src/lib/examples.ts';
import { pageSteps, pretty, threeWays } from '../src/lib/steps.ts';

const seed = new Set(seedSteps.map((s) => s.label));
const transcript = (name: string) => {
  const t = loadExample(name).transcript;
  if (t === null) throw new Error(`${name} has no transcript`);
  return t;
};

describe('pretty', () => {
  const value = {
    data: { 'app/Invoice': [{ number: 'INV-1002', amount: '84050', billedTo: [{ name: 'L' }] }] },
    shapes: { 'app/Invoice': 'list' },
    empty: [],
    none: null
  };

  it('prints the same value, with short objects on one line', () => {
    const text = pretty(value, 40);
    expect(JSON.parse(text)).toEqual(value);
    expect(text).toContain('"shapes": { "app/Invoice": "list" }');
    expect(Math.max(...text.split('\n').map((l) => l.length))).toBeLessThanOrEqual(40);
  });

  it('keeps a value that fits on one line', () => {
    expect(pretty({ a: 1, b: [true, 'x'] })).toBe('{ "a": 1, "b": [true, "x"] }');
  });
});

describe('pageSteps', () => {
  it('collapses the shared seed into one summary line', () => {
    const steps = pageSteps(transcript('onboard'), seed);
    expect(steps[0]).toEqual({ kind: 'seed', summary: 'seed: 3 customers, 8 invoices' });
    expect(steps.filter((s) => s.kind === 'seed')).toHaveLength(1);
    expect(steps).toHaveLength(transcript('onboard').steps.length - seedSteps.length + 1);
  });

  it('renders a stream as the subscription opening and a receive as a frame on it', () => {
    const steps = pageSteps(transcript('coordinate'), seed);
    expect(steps.map((s) => s.kind)).toEqual([
      'request',
      'seed',
      'request',
      'frame',
      'request',
      'request'
    ]);
    const [opened, , , arrived] = steps;
    expect(opened).toMatchObject({ kind: 'request', opens: true });
    expect(arrived).toMatchObject({ kind: 'frame', on: { stream: 'open-tasks' } });
  });

  it('keeps every label, including the demo setup', () => {
    const t = transcript('self-tending');
    const labels = pageSteps(t, seed).map((s) => (s.kind === 'seed' ? '' : s.step.label));
    expect(labels).toEqual(t.steps.map((s: StepResult) => s.label));
  });
});

describe('threeWays', () => {
  const frame = {
    'app/Invoice': {
      params: { where: { status: { eq: 'sent' } }, orderBy: [{ dueAt: 'asc' }] },
      fields: { number: true, billedTo: { _walk: { out: 'customer' }, fields: { name: true } } }
    }
  };

  it('wraps the same frame for MCP and drops walks from the subscription', () => {
    const ways = threeWays(frame);
    expect(ways.http).toBe(frame);
    expect(ways.mcp).toEqual({ payload: frame });
    expect(ways.subscribe).toEqual({
      'app/Invoice': { params: frame['app/Invoice'].params, fields: { number: true } }
    });
    expect(ways.dropped).toEqual(['billedTo']);
  });
});
