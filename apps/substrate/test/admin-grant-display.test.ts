/**
 * The CLI must report the AUTHORITY it granted, not the columns it stored it in.
 *
 * `--ns 'cortext:read'` with no `--caps` stores `capabilities: read,mutate`,
 * the default for BARE entries, of which there are none. True about storage,
 * false about authority.
 */

import { describe, expect, it } from 'vitest';
import { describeGrant, formatRegisterOutput, formatUpdateOutput } from '../src/admin/index.js';

describe('describeGrant', () => {
  it('does NOT apply the bare-entry default to an entry that carries its own caps', () => {
    // `read,mutate` is the default for bare entries; there are none, so it
    // applies to nothing.
    expect(describeGrant('cortext:read', 'read,mutate')).toEqual(['cortext:read']);
  });

  it('applies the default only where the entry is bare', () => {
    expect(describeGrant('cortext,recall:read', 'read,mutate')).toEqual([
      'cortext:read+mutate',
      'recall:read'
    ]);
  });

  it('round-trips as a --ns argument', () => {
    // A display format the operator cannot paste back into the tool is a THIRD
    // representation of the same fact, which is the problem rather than the fix.
    const rendered = describeGrant('cortext:read+mutate,tasks:admin', 'read');
    expect(rendered.join(',')).toBe('cortext:read+mutate,tasks:admin');
    expect(describeGrant(rendered.join(','), 'read')).toEqual(rendered);
  });

  it('stays TOTAL on an unparseable grant — a formatter must not throw', () => {
    // This runs AFTER the write has committed. A throw would lose the operator
    // the record of an operation that succeeded.
    const out = describeGrant('cortext:', 'read');
    expect(out[0]).toContain('UNPARSEABLE');
    expect(out[0]).toContain("namespaces='cortext:'");
  });

  it('says so when a key is granted nothing', () => {
    expect(describeGrant('', 'read')).toEqual(['(none — this key is granted nothing)']);
  });
});

describe('formatRegisterOutput', () => {
  const base = {
    kid: 'succession-drill@devbox',
    name: 'succession drill',
    fingerprint: 'sha256:KVMqfGPL',
    namespaces: 'cortext:read',
    capabilities: 'read,mutate',
    replacedRevoked: false,
    via: 'route' as const,
    directoryCreated: false,
    directoryDetail: 'opted_out'
  };

  it('leads with the grant and does not present the flat column as the answer', () => {
    const out = formatRegisterOutput(base);

    expect(out).toContain('grant:            cortext:read');
    // The column-level line that misreports authority.
    expect(out).not.toMatch(/^capabilities:\s+read,mutate$/m);
    // Storage is still reachable for debugging — demoted, not deleted.
    expect(out).toContain("(stored as:     namespaces='cortext:read' capabilities='read,mutate')");
  });

  it('renders a multi-namespace grant one entry per line', () => {
    const out = formatRegisterOutput({
      ...base,
      namespaces: 'cortext:read+mutate,recall',
      capabilities: 'read'
    });

    expect(out).toContain('grant:            cortext:read+mutate');
    expect(out).toContain('                  recall:read');
  });
});

describe('formatUpdateOutput', () => {
  it('shows before and after grants in full, not a per-column diff', () => {
    // A widening that barely moves either column: `cortext` + caps `read`
    // becomes `cortext:read+mutate`. Column-wise it looks like a small edit;
    // in authority terms write access was just handed out.
    const out = formatUpdateOutput({
      kid: 'agent@h',
      before: { name: 'a', namespaces: 'cortext', capabilities: 'read' },
      after: { name: 'a', namespaces: 'cortext:read+mutate', capabilities: 'read' },
      changed: true
    });

    expect(out).toContain('grant  before:    cortext:read');
    expect(out).toContain('       after:     cortext:read+mutate');
  });

  it('reports the resolved grant on a no-op too', () => {
    const out = formatUpdateOutput({
      kid: 'agent@h',
      before: { name: 'a', namespaces: 'cortext:read', capabilities: 'read,mutate' },
      after: { name: 'a', namespaces: 'cortext:read', capabilities: 'read,mutate' },
      changed: false
    });

    expect(out).toContain('grant:            cortext:read');
    expect(out).not.toMatch(/^capabilities:\s+read,mutate$/m);
  });
});
