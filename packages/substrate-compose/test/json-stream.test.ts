import type { PackEnvelope, SubstrateRequest } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { Frame } from '../src/routes/helpers.js';
import { jsonResponse, serializeEnvelope } from '../src/routes/helpers.js';
import {
  jsonEnvelopeStream,
  jsonParts,
  STREAM_JSON_ROWS,
  streamsJson
} from '../src/routes/json-stream.js';
import { projectEnvelope } from '../src/routes/project-json.js';

const row = (i: number) => ({
  id: `r${i}`,
  name: i % 3 === 0 ? 'é ✓ "quoted"' : `n${i}`,
  dropped: 'not selected',
  gone: undefined,
  at: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60)),
  meta: { x: i, y: 'no' },
  _agg: { n: i, avg: i / 7 },
  kids: [{ id: `k${i}`, v: i, w: 'no' }]
});
const frame: Frame = {
  'ns/Big': {
    fields: {
      id: true,
      name: true,
      at: true,
      gone: true,
      meta: { x: true },
      _agg: { n: { count: true } },
      kids: { _walk: { in: 'ns/K.p' }, fields: { v: true } }
    }
  },
  'ns/Small': { fields: { id: true } },
  'ns/Count': { params: { count: true } },
  'ns/Whole': {}
};
const envelope = (n: number): PackEnvelope => ({
  schemaVersion: 'v1',
  data: {
    'ns/Big': Array.from({ length: n }, (_, i) => row(i)),
    'ns/Small': [row(1), row(2)],
    'ns/Count': { count: 3 },
    'ns/Whole': [row(5)],
    'ns/Gone': undefined
  },
  shapes: { 'ns/Big': 'list', 'ns/Small': 'list', 'ns/Count': 'count', 'ns/Whole': 'list' },
  _pagination: { 'ns/Big': { hasMore: false } }
});

describe('streamed JSON envelope', () => {
  it('streams only past STREAM_JSON_ROWS rows in one key', () => {
    expect(streamsJson(envelope(STREAM_JSON_ROWS))).toBe(false);
    expect(streamsJson(envelope(STREAM_JSON_ROWS + 1))).toBe(true);
  });

  it.each([0, 1, 1999, 2000, 2001, 4500])(
    'pieces of %i rows join to JSON.stringify of the projected envelope',
    (n) => {
      const env = envelope(n);
      expect([...jsonParts(env, frame)].join('')).toBe(JSON.stringify(projectEnvelope(env, frame)));
    }
  );

  it('the stream carries the same bytes', async () => {
    const env = envelope(STREAM_JSON_ROWS + 5);
    const text = await new Response(jsonEnvelopeStream(env, frame)).text();
    expect(text).toBe(JSON.stringify(projectEnvelope(env, frame)));
  });
});

describe('an int64 on the JSON wire', () => {
  const big = { id: 'b', n: 2n ** 63n - 1n };
  const bigFrame: Frame = { 'ns/Big': { fields: { id: true, n: true } } };
  const bigEnvelope = (n: number): PackEnvelope => ({
    schemaVersion: 'v1',
    data: { 'ns/Big': Array.from({ length: n }, () => big) },
    shapes: { 'ns/Big': 'list' }
  });

  it('is a decimal string, in pieces', () => {
    const text = [...jsonParts(bigEnvelope(2001), bigFrame)].join('');
    expect(JSON.parse(text).data['ns/Big'][2000]).toEqual({ id: 'b', n: '9223372036854775807' });
  });

  it('is a decimal string, streamed', async () => {
    const text = await new Response(
      jsonEnvelopeStream(bigEnvelope(STREAM_JSON_ROWS + 1), bigFrame)
    ).text();
    expect(JSON.parse(text).data['ns/Big'][0].n).toBe('9223372036854775807');
  });

  it('is a decimal string, unstreamed (query response)', () => {
    const req: SubstrateRequest = {
      method: 'POST',
      path: '/q',
      headers: {},
      query: {},
      params: {},
      body: null
    };
    const res = serializeEnvelope(req, bigEnvelope(2), {} as never, bigFrame);
    expect(Buffer.from(res.body as Buffer).toString()).toContain('"n":"9223372036854775807"');
  });

  it('is a decimal string in a mutate response (jsonResponse)', () => {
    const res = jsonResponse(200, bigEnvelope(1));
    expect(Buffer.from(res.body as Buffer).toString()).toContain('"n":"9223372036854775807"');
  });
});
