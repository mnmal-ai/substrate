import type { Step } from '../_harness.ts';
import { seedSteps } from '../_scenario.ts';

const act = (label: string, sketch: string): Step => ({
  label,
  method: 'POST',
  path: '/substrate/v1/act',
  as: 'collections-agent',
  body: { sketch }
});

export const PAY = 'The payment lands: pay INV-1002 and close the task, in one transaction';

// INV-1002 is the second invoice the scenario seeds, so its shortId is #2.
export const steps: Step[] = [
  ...seedSteps,
  act(
    'collections-agent opens a task to chase INV-1002',
    'create Task title="Chase Lumen Works for INV-1002" invoice=#2 status=open'
  ),
  act('It asks what an Invoice can do', '? Invoice'),
  act(PAY, 'pay Invoice #2 closes=#1'),
  act('A typo is refused with the nearest valid sketch, and nothing runs', 'pay Invoce #3'),
  {
    label: 'The rows it touched, read back with the key that wrote them',
    method: 'POST',
    path: '/substrate/v1/query',
    as: 'collections-agent',
    body: {
      'app/Invoice': {
        params: { where: { number: { eq: 'INV-1002' } } },
        fields: { number: true, status: true, _metadata: { updatedBy: true } }
      },
      'app/Task': {
        params: {},
        fields: { title: true, status: true, _metadata: { updatedBy: true } }
      }
    }
  }
];
