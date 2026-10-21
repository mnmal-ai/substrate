import type { FieldInput } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { SSE_HEADERS, SSE_HEARTBEAT, sseEvent, sseRetry } from '../src/routes/sse-frame.js';

// Explicit annotation needed: `{ id: true }` otherwise widens to `{ id: boolean }`
// under exactOptionalPropertyTypes, which fails FieldInput's `true | FieldInput`
// index signature.
const FIELDS = new Map<string, FieldInput>([['default/Todo', { id: true }]]);

describe('sse-frame', () => {
  it('renders an event with kind as the event name and JSON data', () => {
    const out = sseEvent({ id: 's1', kind: 'add', data: { 'default/Todo': { id: '1' } } }, FIELDS);
    expect(out).toBe('event: add\ndata: {"key":"default/Todo","row":{"id":"1"}}\n\n');
  });

  it('NEVER emits an id: field', () => {
    // Deliberate (spec §5.1): emitting `id:` makes the browser send
    // Last-Event-ID on reconnect, advertising a resume capability Substrate does
    // not honour. `sequence` travels inside `data` instead. Do not "fix" this.
    const out = sseEvent(
      { id: 's1', kind: 'chunk', sequence: 42, data: { 'default/Todo': { id: '1' } } },
      FIELDS
    );
    expect(out).not.toMatch(/^id:/m);
    expect(out).toContain('"sequence":42');
  });

  it('renders remove frames with removedId', () => {
    const out = sseEvent({ id: 's1', kind: 'remove', removedId: 'x1' }, FIELDS);
    expect(out).toContain('event: remove');
    expect(out).toContain('"removedId":"x1"');
  });

  it('passes an engine-set reason through unchanged (e.g. overload teardown)', () => {
    const out = sseEvent(
      { id: 's1', kind: 'end', reason: 'subscription_overloaded', final: true },
      FIELDS
    );
    expect(out).toBe('event: end\ndata: {"reason":"subscription_overloaded"}\n\n');
  });

  it('derives "cancelled" from _meta.cancelled when no reason is set', () => {
    const out = sseEvent(
      { id: 's1', kind: 'end', final: true, _meta: { cancelled: true } },
      FIELDS
    );
    expect(out).toBe('event: end\ndata: {"reason":"cancelled"}\n\n');
    // _meta itself must never ship on the wire — only the derived reason.
    expect(out).not.toContain('_meta');
  });

  it('derives "complete" for a natural end with neither reason nor _meta', () => {
    const out = sseEvent({ id: 's1', kind: 'end', final: true }, FIELDS);
    expect(out).toBe('event: end\ndata: {"reason":"complete"}\n\n');
  });

  it('renders error frames with code and message', () => {
    const out = sseEvent(
      {
        id: 's1',
        kind: 'error',
        errors: [{ message: 'too slow', code: 'subscription_overloaded' }]
      },
      FIELDS
    );
    expect(out).toContain('event: error');
    expect(out).toContain('"code":"subscription_overloaded"');
  });

  it('renders snapshot frames as rows, keyed by the shapes map', () => {
    const out = sseEvent(
      {
        id: 's1',
        kind: 'snapshot',
        data: { 'default/Todo': [{ id: '1' }, { id: '2' }] },
        shapes: { 'default/Todo': 'list' }
      },
      FIELDS
    );
    expect(out).toBe(
      'event: snapshot\ndata: {"key":"default/Todo","rows":[{"id":"1"},{"id":"2"}]}\n\n'
    );
  });

  it('escapes newlines so multi-line values cannot break framing', () => {
    const out = sseEvent(
      { id: 's1', kind: 'add', data: { 'default/Todo': { id: 'a\nb' } } },
      FIELDS
    );
    // JSON.stringify escapes the newline, so exactly one data: line results.
    expect(out.split('\n').filter((l) => l.startsWith('data:'))).toHaveLength(1);
  });

  it('heartbeat is a comment line', () => {
    expect(SSE_HEARTBEAT).toBe(': keepalive\n\n');
  });

  it('retry directive is emitted in ms', () => {
    expect(sseRetry(5000)).toBe('retry: 5000\n\n');
  });

  it('declares no-store headers', () => {
    expect(SSE_HEADERS['content-type']).toBe('text/event-stream');
    expect(SSE_HEADERS['cache-control']).toBe('no-store');
  });
});
