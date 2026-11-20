import type { Step } from '../_harness.ts';
import { seedSteps } from '../_scenario.ts';

const ask = (label: string, question: string, feed = false): Step => ({
  label,
  method: 'POST',
  path: '/substrate/v1/nl',
  feed,
  // A fixed clock keeps the transcript byte-identical between runs.
  body: { namespace: 'app', question, asOf: '2026-11-19T12:00:00+00:00' }
});

export const steps: Step[] = [
  ...seedSteps,
  ask('Ask for sent invoices per month', 'how many sent invoices per month', true),
  ask('Ask what it cannot read', 'which customers are happy?', true)
];
