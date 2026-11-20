import type { AdminKeyRow } from '@mnmal-ai/substrate/client';
import { cellWidth } from '@mnmal-ai/surface-kit';
import { describe, expect, it } from 'vitest';
import {
  type ListLine,
  listLines,
  orderForView,
  selectLine,
  splitKid
} from '../src/keys/layout.js';
import type { Part } from '../src/lines.js';

/** An invented hostless kid, the shape of a bootstrap key's. */
const BOOT = '0f0f0f0f-1111-4222-8333-444444444444';

const texts = (l: ListLine) => l.parts.map((p) => p.text).join('');

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
  it('puts one blank gap between bands, never first or last', () => {
    const lines = listLines(
      [
        row('a@A', 'x:read'),
        row('b@B', 'x:read'),
        row('c@A', 'x:read', '', '2026-10-01T00:00:00Z')
      ],
      60
    );
    expect(lines.map((l) => l.kind)).toEqual([
      'band',
      'key',
      'gap',
      'band',
      'key',
      'gap',
      'revoked-band',
      'revoked'
    ]);
  });

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

  it('merges hosts that differ only in case into one band labelled by the majority spelling', () => {
    const lines = listLines(
      orderForView([row('a@Alpha', 'x:read'), row('b@Alpha', 'x:read'), row('c@alpha', 'x:read')]),
      80
    );
    const bands = lines.filter((l) => l.kind === 'band');
    expect(bands).toHaveLength(1);
    expect(texts(bands[0] as ListLine)).toContain('Alpha');
    expect(texts(bands[0] as ListLine).endsWith('3')).toBe(true);
    const keys = lines.filter((l) => l.kind === 'key');
    expect(keys[2]?.parts).toContainEqual({ text: '@alpha', tone: 'dimMid' });
    expect(keys[0]?.parts.some((p) => p.text.startsWith('@'))).toBe(false);
  });

  it('breaks a spelling tie by sort order', () => {
    const lines = listLines(orderForView([row('x@Host', 'x:read'), row('y@host', 'x:read')]), 80);
    expect(texts(lines[0] as ListLine)).toContain('Host');
  });

  it('orders bands without case, (no host) first, and rows by agent without case', () => {
    const rows = orderForView([
      row('x@Gamma', 'x:read'),
      row('Bravo@beta', 'x:read'),
      row('alpha@beta', 'x:read'),
      row('loner', 'x:read')
    ]);
    const lines = listLines(rows, 80);
    expect(lines.filter((l) => l.kind === 'key').map((l) => rows[l.row as number]?.kid)).toEqual([
      'loner',
      'alpha@beta',
      'Bravo@beta',
      'x@Gamma'
    ]);
  });

  it('shows a hostless key by its name and a dimMid short id, or its kid when nameless', () => {
    const named = listLines([{ ...row(BOOT, 'x:read'), name: 'bootstrap-admin' }], 80);
    const parts = (named.find((l) => l.kind === 'key') as ListLine).parts;
    const i = parts.findIndex((p) => p.text === 'bootstrap-admin');
    expect(i).toBeGreaterThan(0);
    expect(parts[i + 1]?.text.trim()).toBe('');
    expect(parts[i + 2]).toEqual({ text: '0f0f0…', tone: 'dimMid' });
    const long = listLines([{ ...row(BOOT, 'x:read'), name: 'n'.repeat(19) }], 80);
    const lp = (long.find((l) => l.kind === 'key') as ListLine).parts;
    expect(lp.some((p) => p.text.endsWith('…'))).toBe(false);
    expect(lp[1]?.text).toBe(`${'n'.repeat(19)}`);
    const bare = listLines([{ ...row(BOOT, 'x:read'), name: '' }], 80);
    const name = (bare.find((l) => l.kind === 'key') as ListLine).parts[1] as Part;
    expect(name.text).toBe(`${BOOT.slice(0, 21)}…`);
  });

  it('caps the name column at 22 cells', () => {
    const lines = listLines(
      orderForView([row(`${'a'.repeat(30)}@H`, 'x:read'), row('b@H', 'x:read')]),
      100
    );
    const keys = lines.filter((l) => l.kind === 'key');
    const long = keys[0] as ListLine;
    expect(long.parts[1]?.text).toBe(`${'a'.repeat(21)}…`);
    const col = (l: ListLine) => texts(l).indexOf('x ');
    const mixed = listLines(
      orderForView([{ ...row(BOOT, 'x:read'), name: 'bootstrap-admin' }, row('b@H', 'x:read')]),
      100
    ).filter((l) => l.kind === 'key');
    expect(col(mixed[0] as ListLine)).toBe(col(mixed[1] as ListLine));
    expect(col(keys[0] as ListLine)).toBe(col(keys[1] as ListLine));
  });

  it('measures names in terminal cells: a wide-character name keeps the grant column', () => {
    const rows = orderForView([
      { ...row(BOOT, 'cortext:read'), name: '名前名前名前' },
      row('b@H', 'cortext:read'),
      row('c@H', 'cortext:read')
    ]);
    const keys = listLines(rows, 78).filter((l) => l.kind === 'key');
    const col = (l: ListLine) => cellWidth(texts(l).slice(0, texts(l).indexOf('cortext')));
    expect(keys.map(col)).toEqual(keys.map(() => col(keys[1] as ListLine)));
    const selected = selectLine(keys[0] as ListLine, '▶', 78);
    expect(cellWidth(selected.map((p) => p.text).join(''))).toBe(78);
  });

  it('tones grants: namespaces dimMid, * and a warn bold, r and m text', () => {
    const lines = listLines([row('ops@H', '*:read+mutate+admin,cortext:read+mutate')], 100);
    const parts = (lines.find((l) => l.kind === 'key') as ListLine).parts;
    expect(parts).toContainEqual({ text: '*', tone: 'warn', bold: true });
    expect(parts).toContainEqual({ text: 'cortext', tone: 'dimMid' });
    expect(parts).toContainEqual({ text: 'a', tone: 'warn', bold: true });
    expect(parts).toContainEqual({ text: 'r', tone: 'text' });
    expect(parts).toContainEqual({ text: 'm', tone: 'text' });
  });

  it('tones a spelled-out capability as one text token, never its letters', () => {
    const lines = listLines([row('ops@H', 'cortext:read+substrate.index')], 100);
    const parts = (lines.find((l) => l.kind === 'key') as ListLine).parts;
    expect(parts).toContainEqual({ text: '(substrate.index)', tone: 'text' });
    expect(parts.some((p) => p.bold === true)).toBe(false);
  });

  it('tones a band: rule dim, label text bold, count dimMid', () => {
    const band = listLines([row('a@H', 'x:read')], 80)[0] as ListLine;
    expect(band.parts).toContainEqual({ text: 'H', tone: 'text', bold: true });
    expect(band.parts[0]).toEqual({ text: ' ── ', tone: 'dim' });
    expect(band.parts.at(-1)).toEqual({ text: '1', tone: 'dimMid' });
  });

  it('lists revoked keys in their own band, kid struck and dim, only when present', () => {
    const rows = orderForView([
      row('a@H', 'x:read'),
      row('gone@H', 'x:read', '', '2026-11-01T10:00:00Z')
    ]);
    const lines = listLines(rows, 80);
    const rb = lines.find((l) => l.kind === 'revoked-band') as ListLine;
    expect(rb.parts).toContainEqual({ text: 'revoked', tone: 'dimMid', bold: true });
    const rev = lines.find((l) => l.kind === 'revoked') as ListLine;
    expect(rev.parts).toContainEqual({ text: 'gone@H', tone: 'dim', strike: true });
    expect(texts(rev)).toContain('2026-11-01');
    expect(listLines([row('a@H', 'x:read')], 80).some((l) => l.kind === 'revoked-band')).toBe(
      false
    );
  });

  it('lines every band count up in one column and shortens bands on a narrow width', () => {
    const rows = orderForView([
      row('a@Short', 'x:read'),
      row('b@AMuchLongerHostName', 'x:read'),
      row('c@名前', 'x:read'),
      row('g@Z', 'x:read', '', '2026-11-01T10:00:00Z')
    ]);
    const bands = (w: number) =>
      listLines(rows, w).filter((l) => l.kind === 'band' || l.kind === 'revoked-band');
    expect(new Set(bands(80).map((l) => cellWidth(texts(l)))).size).toBe(1);
    const wide = row('w@H', `${'n'.repeat(30)}:read,${'m'.repeat(30)}:read`);
    const narrow = listLines(orderForView([...rows, wide]), 40);
    for (const l of narrow) expect(cellWidth(texts(l))).toBeLessThanOrEqual(40);
    for (const l of narrow.filter((x) => x.kind === 'band' || x.kind === 'revoked-band'))
      expect(texts(l)).toMatch(/── .+ ──+ \d+$/);
    expect(texts(narrow.find((l) => texts(l).includes('mmmm')) as ListLine).endsWith('…')).toBe(
      true
    );
  });

  it('sanitises every part', () => {
    const lines = listLines([row('ev\x1b[31mil@H', 'x:read')], 80);
    for (const l of lines) for (const p of l.parts) expect(p.text).not.toContain('\x1b');
  });

  it('puts a name holding a line break on one line', () => {
    const lines = listLines([{ ...row(BOOT, 'x:read'), name: 'x\n   fake-admin' }], 80);
    expect(lines.filter((l) => l.kind === 'key')).toHaveLength(1);
    for (const l of lines) for (const p of l.parts) expect(p.text).not.toMatch(/[\n\r]/);
  });

  it('sanitises a capability name too', () => {
    const lines = listLines([row('a@H', 'x:evil\x1b[31m')], 80);
    for (const l of lines) for (const p of l.parts) expect(p.text).not.toContain('\x1b');
  });

  it('selectLine bands the whole row and keeps a revoked kid struck', () => {
    const lines = listLines(
      orderForView([row('a@H', 'x:read'), row('gone@H', 'x:read', '', '2026-11-01T10:00:00Z')]),
      60
    );
    for (const kind of ['key', 'revoked'] as const) {
      const parts = selectLine(lines.find((l) => l.kind === kind) as ListLine, '▶');
      expect(parts[0]).toEqual({ text: '▶  ', tone: 'selection' });
      for (const p of parts.slice(1)) {
        expect(p).toMatchObject({ bg: 'selection', tone: 'surface', bold: true });
      }
      if (kind === 'revoked') expect(parts.some((p) => p.strike === true)).toBe(true);
    }
    const padded = selectLine(lines.find((l) => l.kind === 'key') as ListLine, '▶', 60);
    expect(padded.map((p) => p.text).join('')).toHaveLength(60);
  });

  it('maps every selectable line back to its ordered row', () => {
    const rows = orderForView([
      row('one@H', 'cortext:read+mutate,recall:read'),
      row('three@G', 'cortext:read+mutate+admin'),
      row('gone@H', 'cortext:read', '', '2026-11-01T10:00:00Z')
    ]);
    const lines = listLines(rows, 80);
    expect(lines.filter((l) => l.row !== undefined).map((l) => rows[l.row as number]?.kid)).toEqual(
      rows.map((r) => r.kid)
    );
  });
});
