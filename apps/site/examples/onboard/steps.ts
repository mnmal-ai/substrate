import type { Step } from '../_harness.ts';
import { seedSteps } from '../_scenario.ts';

/** The label of the walk-free read the page sends three ways: HTTP, MCP and a subscription. */
export const EVERY_SURFACE = 'Query sent invoices by due date, in a frame every surface takes';

export const steps: Step[] = [
  ...seedSteps,
  {
    label: 'Create an invoice',
    method: 'POST',
    path: '/substrate/v1/mutate',
    feed: true,
    body: {
      'app/createInvoice': {
        params: {
          number: 'INV-1009',
          amount: 72500,
          currency: 'EUR',
          issuedAt: '2026-11-09T00:00:00.000Z',
          dueAt: '2026-12-09T00:00:00.000Z',
          status: 'sent',
          customer: '0197a100-0000-7000-8000-000000000003'
        },
        fields: { id: true, number: true, status: true }
      }
    }
  },
  {
    label: 'Query sent invoices, with the customer',
    method: 'POST',
    path: '/substrate/v1/query',
    feed: true,
    body: {
      'app/Invoice': {
        params: { where: { status: { eq: 'sent' } }, orderBy: [{ dueAt: 'asc' }] },
        fields: {
          number: true,
          amount: true,
          currency: true,
          dueAt: true,
          billedTo: { _walk: { out: 'customer' }, fields: { name: true } }
        }
      }
    }
  },
  {
    label: EVERY_SURFACE,
    method: 'POST',
    path: '/substrate/v1/query',
    body: {
      'app/Invoice': {
        params: { where: { status: { eq: 'sent' } }, orderBy: [{ dueAt: 'asc' }] },
        fields: { number: true, dueAt: true }
      }
    }
  },
  {
    label: 'Ask the server to describe itself',
    method: 'GET',
    path: '/substrate/v1/onboard'
  },
  {
    label: 'Read the app schema, with its generated mutations',
    method: 'GET',
    path: '/substrate/v1/schema/app'
  }
];
