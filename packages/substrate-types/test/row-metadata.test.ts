import { describe, expect, it } from 'vitest';
import type { ActorIdentity, RowMetadata } from '../src/index.js';
import { CLIENT_SUPPLIED_SERVER_FIELD, ROW_METADATA_FIELDS } from '../src/index.js';

describe('RowMetadata + ActorIdentity', () => {
  it('exports RowMetadata shape with four fields', () => {
    const m: RowMetadata = {
      createdAt: '2026-04-25T12:00:00Z',
      updatedAt: '2026-04-25T12:00:00Z',
      createdBy: { kind: 'agent', id: 'agent-1' },
      updatedBy: { kind: 'agent', id: 'agent-1' }
    };
    expect(m.createdAt).toBeTypeOf('string');
    expect(m.createdBy?.kind).toBe('agent');
  });

  it('exports ActorIdentity union with three kinds', () => {
    const a: ActorIdentity = { kind: 'agent', id: 'a1' };
    const u: ActorIdentity = { kind: 'user', id: 'u1' };
    const s: ActorIdentity = { kind: 'system', id: 'sweep' };
    expect([a.kind, u.kind, s.kind]).toEqual(['agent', 'user', 'system']);
  });

  it('exports CLIENT_SUPPLIED_SERVER_FIELD error code', () => {
    expect(CLIENT_SUPPLIED_SERVER_FIELD).toBe('client_supplied_server_field');
  });

  it('ROW_METADATA_FIELDS pins the canonical four field names (tripwire for downstream reject loops)', () => {
    expect(ROW_METADATA_FIELDS).toEqual(['createdAt', 'updatedAt', 'createdBy', 'updatedBy']);
    expect(ROW_METADATA_FIELDS).toHaveLength(4);
  });
});
