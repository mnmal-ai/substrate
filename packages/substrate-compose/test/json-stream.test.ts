import type { PackEnvelope } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { Frame } from '../src/routes/helpers.js';
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
