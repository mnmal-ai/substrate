import { defineNamespace, field } from '@mnmal-ai/substrate/sdk';

export const app = defineNamespace('app', {
  Customer: {
    fields: {
      name: field.string(),
      email: field.string(),
      region: field.string()
    }
  },
  Invoice: {
    fields: {
      number: field.string(),
      amount: field.int64(),
      currency: field.string(),
      issuedAt: field.date(),
      dueAt: field.date(),
      status: field.enum(['draft', 'sent', 'paid', 'void']),
      customer: field.crossRef('app', 'Customer')
    }
  }
});
