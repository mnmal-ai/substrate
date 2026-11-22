import { defineNamespace, field } from '@mnmal-ai/substrate/sdk';
import { app as scenario } from '../_scenario.ts';

// The scenario's Customer, its Invoice with two declared actions, and a Task that chases an
// invoice. Paying an invoice closes the tasks chasing it, in the same transaction.
export const app = defineNamespace('app', {
  ...scenario.types,
  Invoice: {
    fields: {
      number: field.string(),
      amount: field.int64(),
      currency: field.string(),
      issuedAt: field.date(),
      dueAt: field.date(),
      status: field.enum(['draft', 'sent', 'paid', 'void']),
      customer: field.crossRef('app', 'Customer')
    },
    actions: {
      pay: {
        past: 'paid',
        params: { closes: { list: 'app/Task', optional: true } },
        set: { status: 'paid' },
        // biome-ignore lint/suspicious/noThenProperty: `then` is the action declaration's key
        then: [{ action: 'app/Task.close', each: { param: 'closes' } }]
      },
      void: { past: 'voided', set: { status: 'void' } }
    }
  },
  Task: {
    fields: {
      title: field.string(),
      invoice: field.crossRef('app', 'Invoice'),
      status: field.enum(['open', 'in_progress', 'done'])
    },
    actions: {
      close: { past: 'closed', set: { status: 'done' } }
    }
  }
});
