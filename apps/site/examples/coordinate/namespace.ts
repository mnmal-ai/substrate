import { defineNamespace, field } from '@mnmal-ai/substrate/sdk';
import { app as scenario } from '../_scenario.ts';

// The scenario's Customer and Invoice, plus a Task that one agent hands another.
export const app = defineNamespace('app', {
  ...scenario.types,
  Task: {
    fields: {
      title: field.string(),
      invoice: field.crossRef('app', 'Invoice'),
      status: field.enum(['open', 'in_progress', 'done'])
    }
  }
});
