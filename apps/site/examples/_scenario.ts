import type { Step } from './_harness.ts';

export { app } from './onboard/namespace.ts';

// Fixed ids are numbered as `normalise` numbers ids by first appearance, customers 1 to 3 and
// invoices 4 to 11, so the page shows each one as it is sent and a copied frame runs as shown.
const customers = [
  ['0197a000-0000-7000-8000-000000000001', 'Harbor & Pine', 'billing@harborpine.example', 'EMEA'],
  ['0197a000-0000-7000-8000-000000000002', 'Lumen Works', 'ap@lumenworks.example', 'NA'],
  ['0197a000-0000-7000-8000-000000000003', 'Tidewater Labs', 'finance@tidewater.example', 'APAC']
] as const;

// [number, customer index, amount in cents, issued, due, status]
const invoices = [
  ['INV-1001', 0, 120000, '2026-08-04', '2026-09-03', 'paid'],
  ['INV-1002', 1, 84050, '2026-08-19', '2026-09-18', 'sent'],
  ['INV-1003', 2, 230000, '2026-09-02', '2026-10-02', 'sent'],
  ['INV-1004', 0, 45000, '2026-09-15', '2026-10-15', 'void'],
  ['INV-1005', 1, 99900, '2026-10-06', '2026-11-05', 'sent'],
  ['INV-1006', 2, 176500, '2026-10-20', '2026-11-19', 'sent'],
  ['INV-1007', 0, 60000, '2026-10-28', '2026-11-27', 'sent'],
  ['INV-1008', 1, 15000, '2026-11-02', '2026-12-02', 'draft']
] as const;

const iso = (d: string) => `${d}T00:00:00.000Z`;
const invoiceId = (i: number) => `0197a000-0000-7000-8000-${String(i + 4).padStart(12, '0')}`;

export const seedSteps: Step[] = [
  ...customers.map(
    ([id, name, email, region]): Step => ({
      label: `Create customer ${name}`,
      method: 'POST',
      path: '/substrate/v1/mutate',
      body: { 'app/createCustomer': { params: { id, name, email, region }, fields: { id: true } } }
    })
  ),
  ...invoices.map(
    ([number, c, amount, issued, due, status], i): Step => ({
      label: `Create invoice ${number}`,
      method: 'POST',
      path: '/substrate/v1/mutate',
      body: {
        'app/createInvoice': {
          params: {
            id: invoiceId(i),
            number,
            amount,
            currency: 'EUR',
            issuedAt: iso(issued),
            dueAt: iso(due),
            status,
            customer: customers[c][0]
          },
          fields: { id: true }
        }
      }
    })
  )
];
