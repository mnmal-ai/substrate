import type { Step } from '../_harness.ts';
import { seedSteps } from '../_scenario.ts';

export const steps: Step[] = [
  ...seedSteps,
  {
    label: 'Unpaid invoices by month due',
    method: 'POST',
    path: '/substrate/v1/query',
    feed: true,
    body: {
      'app/Invoice': {
        params: {
          where: { status: { eq: 'sent' } },
          aggregate: { outstanding: { sum: 'amount' }, invoices: { count: true } },
          groupBy: { month: { dateTrunc: [{ lit: 'month' }, 'dueAt'] } },
          orderBy: [{ month: 'asc' }]
        }
      }
    }
  },
  {
    label: 'Open invoices and next due date per customer',
    method: 'POST',
    path: '/substrate/v1/query',
    feed: true,
    body: {
      'app/Customer': {
        params: { orderBy: [{ name: 'asc' }] },
        fields: {
          name: true,
          region: true,
          _agg: {
            open: { in: 'app/Invoice.customer', where: { status: { eq: 'sent' } }, count: true },
            nextDue: {
              in: 'app/Invoice.customer',
              where: { status: { eq: 'sent' } },
              min: 'dueAt'
            }
          }
        }
      }
    }
  }
];
