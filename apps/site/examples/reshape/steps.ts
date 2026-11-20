import type { Step } from '../_harness.ts';
import { seedSteps } from '../_scenario.ts';

// A seeded invoice that is still `sent`.
const INVOICE = '0197a000-0000-7000-8000-000000000005';
// 13: the proposal record the server creates first takes 12, so the page shows this as sent.
const PAYMENT = '0197a000-0000-7000-8000-000000000013';

export const steps: Step[] = [
  ...seedSteps,
  {
    label: 'Propose billing/Payment, with a reference to app/Invoice',
    method: 'POST',
    as: 'schema-agent',
    path: '/substrate/v1/mutate',
    feed: true,
    body: {
      'billing/propose_type': {
        params: {
          typeName: 'Payment',
          fields: {
            amount: { kind: 'scalar', type: 'int64' },
            paidAt: { kind: 'scalar', type: 'date' },
            invoice: { kind: 'crossRef', ns: 'app', type: 'Invoice' }
          },
          proposedReason: 'Record the payments that settle invoices'
        },
        fields: { id: true }
      }
    }
  },
  {
    label: 'Record a payment against INV-1002, on the next call',
    method: 'POST',
    as: 'schema-agent',
    path: '/substrate/v1/mutate',
    body: {
      'billing/createPayment': {
        params: {
          id: PAYMENT,
          amount: 84050,
          paidAt: '2026-11-03T00:00:00.000Z',
          invoice: INVOICE
        },
        fields: { id: true, amount: true, paidAt: true }
      }
    }
  },
  {
    label: 'Read payments, walking out to the invoice',
    method: 'POST',
    as: 'schema-agent',
    path: '/substrate/v1/query',
    feed: true,
    body: {
      'billing/Payment': {
        fields: {
          id: true,
          amount: true,
          paidAt: true,
          settles: { _walk: { out: 'invoice' }, fields: { number: true, status: true } }
        }
      }
    }
  },
  {
    label: 'Read the proposal record: proposedBy is stamped by the server',
    method: 'POST',
    as: 'schema-agent',
    path: '/substrate/v1/query',
    body: {
      'billing/TypeProposal': {
        params: { where: { typeName: { eq: 'Payment' } } },
        fields: { id: true, typeName: true, applied: true, proposedBy: true, proposedReason: true }
      }
    }
  }
];
