import { defineNamespace, field } from '@mnmal-ai/substrate/sdk';
import { app as scenario } from '../_scenario.ts';

// The scenario, with Customer gaining free-text notes that are embedded on every write.
export const app = defineNamespace('app', {
  ...scenario.types,
  Customer: {
    fields: {
      name: field.string(),
      email: field.string(),
      region: field.string(),
      notes: field.string({ nullable: true })
    },
    embed: { source: (row) => (typeof row.notes === 'string' ? row.notes : null) }
  }
});
