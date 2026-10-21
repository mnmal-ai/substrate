import { describe, expect, it } from 'vitest';
import { hashFrame, mintStreamTicket, verifyStreamTicket } from '../src/routes/stream-ticket.js';

const SECRET = 'test-secret-do-not-use-in-prod';
const FRAME = { 'default/Todo': { fields: { id: true } } };
const NOW = 1_800_000_000_000;

function mint(nowMs = NOW, frame = FRAME): string {
  return mintStreamTicket(
    SECRET,
    {
      identity: { id: 'agent-1', grants: {} },
      capabilities: ['read'],
      frameHash: hashFrame(frame)
    },
    nowMs
  );
}

describe('stream ticket', () => {
  it('round-trips a valid ticket', () => {
    const v = verifyStreamTicket(SECRET, mint(), FRAME, NOW + 1_000);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.payload.identity?.id).toBe('agent-1');
  });

  it('is reusable within its TTL (EventSource auto-reconnect)', () => {
    // EventSource reconnects to the SAME url with the SAME ticket. A single-use
    // ticket would 401 on every reconnect and defeat the whole point.
    const t = mint();
    expect(verifyStreamTicket(SECRET, t, FRAME, NOW + 1_000).ok).toBe(true);
    expect(verifyStreamTicket(SECRET, t, FRAME, NOW + 2_000).ok).toBe(true);
  });

  it('rejects an expired ticket', () => {
    const v = verifyStreamTicket(SECRET, mint(), FRAME, NOW + 61_000);
    expect(v).toEqual({ ok: false, code: 'ticket_expired' });
  });

  it('rejects a ticket replayed onto a different frame', () => {
    const other = { 'default/Secret': { fields: { id: true } } };
    const v = verifyStreamTicket(SECRET, mint(), other, NOW + 1_000);
    expect(v).toEqual({ ok: false, code: 'ticket_frame_mismatch' });
  });

  it('rejects a tampered payload', () => {
    const [body, sig] = mint().split('.') as [string, string];
    const evil = Buffer.from(
      JSON.stringify({
        identity: { id: 'admin' },
        capabilities: ['admin'],
        frameHash: hashFrame(FRAME),
        exp: NOW + 60_000
      })
    ).toString('base64url');
    expect(verifyStreamTicket(SECRET, `${evil}.${sig}`, FRAME, NOW + 1_000)).toEqual({
      ok: false,
      code: 'ticket_invalid'
    });
    expect(body).not.toBe(evil);
  });

  it('rejects a ticket signed with a different secret', () => {
    const foreign = mintStreamTicket(
      'other-secret',
      { identity: null, capabilities: [], frameHash: hashFrame(FRAME) },
      NOW
    );
    expect(verifyStreamTicket(SECRET, foreign, FRAME, NOW + 1_000)).toEqual({
      ok: false,
      code: 'ticket_invalid'
    });
  });

  it('rejects a malformed ticket without throwing', () => {
    expect(verifyStreamTicket(SECRET, 'garbage', FRAME, NOW)).toEqual({
      ok: false,
      code: 'ticket_invalid'
    });
  });

  it('hashes frames canonically — key order does not matter', () => {
    expect(hashFrame({ a: { fields: { x: true } }, b: {} })).toBe(
      hashFrame({ b: {}, a: { fields: { x: true } } })
    );
  });

  it.each([
    ['capabilities missing', { identity: null, frameHash: hashFrame(FRAME) }],
    ['capabilities not an array', { identity: null, capabilities: 'read' }],
    ['capabilities holding non-strings', { identity: null, capabilities: [1] }],
    ['frameHash missing', { identity: null, capabilities: ['read'] }],
    ['identity missing', { capabilities: ['read'], frameHash: hashFrame(FRAME) }],
    ['identity without an id', { identity: {}, capabilities: ['read'] }]
  ])('rejects a correctly-SIGNED ticket whose payload has %s', (_label, payload) => {
    // Signature-valid is not shape-valid. Consumers read
    // `payload.capabilities.includes(...)`; an unvalidated payload turns that
    // into an uncaught TypeError at the call site — a 500 where a 401 belongs.
    const bad = mintStreamTicket(SECRET, payload as never, NOW);
    expect(verifyStreamTicket(SECRET, bad, FRAME, NOW + 1_000)).toEqual({
      ok: false,
      code: 'ticket_invalid'
    });
  });

  it('rejects a hostile frame (circular reference) as a verdict, not a throw', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(verifyStreamTicket(SECRET, mint(), circular, NOW + 1_000)).toEqual({
      ok: false,
      code: 'ticket_invalid'
    });
  });
});
