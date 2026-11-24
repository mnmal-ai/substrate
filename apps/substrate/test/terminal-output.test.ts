/**
 * Operator commands print text that a peer, a key holder or a stored row
 * supplied. It must reach the terminal as data: one line per value, no escape
 * or control bytes, and never as shell syntax.
 */
import { describe, expect, it } from 'vitest';
import { formatListOutput } from '../src/admin/commands/list.js';
import { formatJoinOutput } from '../src/cli/federate/join.js';
import { oneLine } from '../src/terminal-text.js';

const ESC = '\u001b';

describe('oneLine', () => {
  it('drops escape and control bytes and joins lines', () => {
    expect(oneLine(`a${ESC}[2Jb\u0007\r\nc d`)).toBe('ab c d');
  });
});

describe('substrate-admin list', () => {
  it('prints a key whose name holds line breaks and escapes as one row', () => {
    const forged = `ci\nkid-admin  root  admin  *  2026-01-01${ESC}[1A`;
    const out = formatListOutput([
      { kid: 'k1', name: forged, capabilities: 'read', namespaces: 'app', createdAt: '2026-01-01' }
    ]);
    expect(out).not.toContain(ESC);
    // Header, divider and one row come before the provenance note.
    expect(out.split('read directly')[0]?.trimEnd().split('\n')).toHaveLength(3);
  });
});

describe('federate join', () => {
  const base = {
    origin: 'https://peer.example',
    name: 'peer-b',
    kid: 'k1',
    capabilities: ['read'],
    keyPath: '/tmp/peer-b.key'
  };

  it.each([
    ['a quote in a namespace', { namespaces: ["demo'; touch /tmp/marker; '"] }],
    ['a quote in the kid', { namespaces: ['demo'], kid: "k'$(id)'" }]
  ])('prints no env lines for %s', (_what, over) => {
    const out = formatJoinOutput({ ...base, namespaces: ['demo'], ...over });
    expect(out).not.toContain('SUBSTRATE_BRIDGES=');
    expect(out).not.toContain('SUBSTRATE_BRIDGE_CREDENTIALS=');
    expect(out).toContain('cannot be written to a .env file safely');
  });

  it('keeps a line break in a namespace inside its line', () => {
    const out = formatJoinOutput({ ...base, namespaces: ['demo\nEXTRA=1'] });
    expect(out).not.toContain('\nEXTRA=1');
    expect(out).toContain('"ns":"demo\\nEXTRA=1"');
  });
});
