import type { Step } from '../_harness.ts';
import { seedSteps } from '../_scenario.ts';

const INV_1002 = '0197a000-0000-7000-8000-000000000005';
// The first id after the seed's eleven, so the page shows it as sent.
const TASK = '0197a000-0000-7000-8000-000000000012';

export const steps: Step[] = [
  {
    label: 'collections-agent subscribes to open tasks',
    method: 'POST',
    path: '/substrate/v1/subscribe',
    as: 'collections-agent',
    stream: 'open-tasks',
    body: {
      'app/Task': {
        params: { where: { status: { eq: 'open' } } },
        fields: { id: true, title: true, invoice: true, status: true }
      }
    }
  },
  ...seedSteps,
  {
    label: 'billing-agent opens a task: INV-1002 was due 18 Sep and today is 3 Nov 2026',
    method: 'POST',
    path: '/substrate/v1/mutate',
    as: 'billing-agent',
    feed: true,
    body: {
      'app/createTask': {
        params: {
          id: TASK,
          title: 'Chase Lumen Works for INV-1002',
          invoice: INV_1002,
          status: 'open'
        },
        fields: { id: true, title: true, status: true }
      }
    }
  },
  {
    label: 'collections-agent receives it, live',
    method: 'POST',
    path: '/substrate/v1/subscribe',
    as: 'collections-agent',
    feed: true,
    receive: 'open-tasks'
  },
  {
    label: 'collections-agent reads it, with the key that signed it',
    method: 'POST',
    path: '/substrate/v1/query',
    as: 'collections-agent',
    body: {
      'app/Task': {
        params: { where: { id: { eq: TASK } } },
        fields: {
          title: true,
          status: true,
          forInvoice: { _walk: { out: 'invoice' }, fields: { number: true, dueAt: true } },
          _metadata: { createdBy: true }
        }
      }
    }
  },
  {
    label: 'collections-agent takes it',
    method: 'POST',
    path: '/substrate/v1/mutate',
    as: 'collections-agent',
    feed: true,
    body: {
      'app/updateTask': {
        params: { id: TASK, status: 'in_progress' },
        fields: { id: true, status: true, _metadata: { updatedBy: true } }
      }
    }
  }
];
