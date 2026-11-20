import type { Step } from '../_harness.ts';
import { seedSteps } from '../_scenario.ts';

const notes = [
  [
    '0197a000-0000-7000-8000-000000000001',
    'Harbor & Pine',
    'Pallet arrived nine days after the promised date and they have asked for a credit.'
  ],
  [
    '0197a000-0000-7000-8000-000000000002',
    'Lumen Works',
    'Happy with the new packaging. Asked about volume pricing for next spring.'
  ],
  [
    '0197a000-0000-7000-8000-000000000003',
    'Tidewater Labs',
    'Second shipment in a row came late and nobody told them. Considering another supplier.'
  ]
] as const;

export const steps: Step[] = [
  ...seedSteps,
  ...notes.map(
    ([id, name, text]): Step => ({
      label: `Record a service note for ${name}`,
      method: 'POST',
      path: '/substrate/v1/mutate',
      body: { 'app/updateCustomer': { params: { id, notes: text }, fields: { id: true } } }
    })
  ),
  {
    label: 'Find customers unhappy about late delivery',
    method: 'POST',
    path: '/substrate/v1/query',
    feed: true,
    body: {
      'recall/Hit': {
        params: {
          to: 'customers unhappy about late delivery',
          namespace: 'app',
          type: 'Customer',
          k: 3
        },
        fields: { id: true, score: true, type: true, namespace: true, row: { name: true } }
      }
    }
  }
];
