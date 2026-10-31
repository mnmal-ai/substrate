// nl is not a dependency (it depends on substrate, which bundles this package), so its
// completer is read from source: the check is that the client's pack type fits it.

import { HttpResponse, http } from 'msw';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { complete } from '../../../plugins/substrate-nl/src/complete/complete.js';
import { SubstrateClient } from '../src/client.js';
import type { NlAskResult, NlOutcome, NlServedPack, NlWireEvent } from '../src/nl.js';
import { mockHandlers } from './_setup.js';

const ENDPOINT = 'http://substrate.test';

const PACK: NlServedPack = {
  namespace: 'ns',
  schemaVersion: 'v1',
  types: {
    Todo: {
      name: 'Todo',
      phrases: ['todo', 'todos'],
      fields: {
        status: {
          name: 'status',
          kind: 'scalar',
          valueType: 'string',
          indexed: true,
          operators: ['eq'],
          phrases: ['status'],
          enum: ['open', 'closed']
        }
      }
    }
  },
  values: {},
  rulings: {},
  warnings: []
};

const CLARIFY: NlOutcome = {
  kind: 'clarify',
  question: 'open',
  reason: 'which did you mean?',
  options: [{ label: 'todo (Todo)', question: 'open', type: 'Todo' }]
};
const sseBody = [
  `event: parsed\ndata: ${JSON.stringify({ status: 'clarify', evidence: [], residual: [] })}\n\n`,
  `event: clarify\ndata: ${JSON.stringify(CLARIFY)}\n\n`,
  'event: done\ndata: {}\n\n'
].join('');

describe('client.nl is typed end to end, with no casts', () => {
  it('pack feeds complete(); ask() narrows on event; a clarify option resubmits via askJson', async () => {
    const posted: unknown[] = [];
    mockHandlers(
      http.get(`${ENDPOINT}/substrate/v1/nl/pack/ns`, () => HttpResponse.json(PACK)),
      http.post(`${ENDPOINT}/substrate/v1/nl`, async ({ request }) => {
        if ((request.headers.get('accept') ?? '').includes('text/event-stream'))
          return new HttpResponse(sseBody, { headers: { 'content-type': 'text/event-stream' } });
        posted.push(await request.json());
        const result: NlAskResult = {
          outcome: { kind: 'refuse', reason: 'x' },
          trail: [{ event: 'done' }]
        };
        return HttpResponse.json(result);
      })
    );
    const c = new SubstrateClient({ endpoint: ENDPOINT });

    // 1. a fetched pack satisfies complete()'s parameter
    const pack = await c.nl.pack('ns');
    expectTypeOf(pack).toEqualTypeOf<NlServedPack>();
    const sugg = complete('todos st', 8, pack);
    expect(sugg.map((s) => s.insert)).toContain('status:');

    // 2. ask() yields a union narrowable on `event`
    let option: { type: string } | undefined;
    for await (const ev of c.nl.ask({ namespace: 'ns', question: 'open' })) {
      expectTypeOf(ev).toEqualTypeOf<NlWireEvent>();
      if (ev.event === 'parsed') expectTypeOf(ev.data.evidence).toBeArray();
      else if (ev.event === 'clarify') option = ev.data.options[0];
      else if (ev.event === 'rows')
        expectTypeOf(ev.data.source).toEqualTypeOf<'parser' | 'judge' | 'handoff'>();
    }
    expect(option?.type).toBe('Todo');

    // 3. the option's type resubmits
    if (option === undefined) throw new Error('no option');
    const res = await c.nl.askJson({ namespace: 'ns', question: 'open', type: option.type });
    expectTypeOf(res).toEqualTypeOf<NlAskResult>();
    expect(posted).toEqual([{ namespace: 'ns', question: 'open', type: 'Todo' }]);
    if (res.outcome?.kind === 'refuse') expect(res.outcome.reason).toBe('x');
  });

  it("an 'unknown' event carries the dropped list and the plan", async () => {
    const UNKNOWN: Extract<NlOutcome, { kind: 'unknown' }> = {
      kind: 'unknown',
      question: 'how many todos zorblax',
      dropped: [{ span: 'zorblax', reason: 'not understood', kind: 'filter' }],
      plan: []
    };
    mockHandlers(
      http.post(
        `${ENDPOINT}/substrate/v1/nl`,
        () =>
          new HttpResponse(
            `event: unknown\ndata: ${JSON.stringify(UNKNOWN)}\n\nevent: done\ndata: {}\n\n`,
            { headers: { 'content-type': 'text/event-stream' } }
          )
      )
    );
    const c = new SubstrateClient({ endpoint: ENDPOINT });
    const seen: string[] = [];
    for await (const ev of c.nl.ask({ namespace: 'ns', question: UNKNOWN.question })) {
      if (ev.event === 'unknown') {
        expectTypeOf(ev.data.dropped[0]?.kind).toEqualTypeOf<'filter' | 'order' | undefined>();
        seen.push(...ev.data.dropped.map((d) => d.span));
      }
    }
    expect(seen).toEqual(['zorblax']);
  });
});
