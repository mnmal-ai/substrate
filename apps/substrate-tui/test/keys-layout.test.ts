import type { AdminKeyRow } from '@mnmal-ai/substrate/client';
import { describe, expect, it } from 'vitest';
import { listLines, orderForView, splitKid } from '../src/keys/layout.js';

const row = (
  kid: string,
  namespaces: string,
  capabilities = '',
  revokedAt: string | null = null
): AdminKeyRow =>
  ({
    kid,
    name: `${kid} key`,
    algorithm: 'ed25519',
    namespaces,
    capabilities,
    revokedAt
  }) as AdminKeyRow;

describe('keys layout', () => {
  it('splits a kid at its last @, and a kid with none has no host', () => {
    expect(splitKid('a@b@Host')).toEqual(['a@b', 'Host']);
    expect(splitKid('loner')).toEqual(['loner', '(no host)']);
  });

  it('orders active keys by host then agent, revoked last and newest first', () => {
    const rows = [
      row('z@B', 'x:read'),
      row('old@A', 'x:read', '', '2026-10-01T00:00:00Z'),
      row('b@a', 'x:read'),
      row('a@A', 'x:read'),
      row('new@A', 'x:read', '', '2026-11-01T00:00:00Z')
    ];
    expect(orderForView(rows).map((r) => r.kid)).toEqual(['a@A', 'b@a', 'z@B', 'new@A', 'old@A']);
  });

  it('groups under host headings and lines each namespace up in its own column', () => {
    const rows = orderForView([
      row('one@H', 'cortext:read+mutate,recall:read'),
      row('two@H', 'recall:read'),
      row('three@G', 'cortext:read+mutate+admin'),
      row('gone@H', 'cortext:read', '', '2026-11-01T10:00:00Z')
    ]);
    const lines = listLines(rows);
    expect(lines.map((l) => [l.kind, l.text.trimEnd()])).toEqual([
      ['host', 'G'],
      ['key', 'three  cortext rma'],
      ['gap', ''],
      ['host', 'H'],
      ['key', 'one    cortext rm   recall r'],
      ['key', 'two                 recall r'],
      ['gap', ''],
      ['revoked-head', 'revoked'],
      ['revoked', 'gone@H  2026-11-01']
    ]);
    // Every key line points back at its row, so the cursor follows the display.
    expect(lines.filter((l) => l.row !== undefined).map((l) => rows[l.row as number]?.kid)).toEqual(
      rows.map((r) => r.kid)
    );
  });
});
