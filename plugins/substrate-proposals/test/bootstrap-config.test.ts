/**
 * Tests the `bootstrap(rawConfig)` entry the `SUBSTRATE_PLUGIN_DIR` loader calls,
 * for the proposals-specific contract: which namespaces install, that the
 * reserved-name check fires, and that this plugin's schema rejects obvious
 * mis-shapes. The shared helper contract is covered in
 * `packages/substrate-bootstrap/test/bootstrap.test.ts`.
 *
 * Assertions target `BootstrapConfigError`, not error strings, so they stay
 * stable across zod releases.
 */

import { BootstrapConfigError } from '@mnmal-ai/substrate-bootstrap';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { CONTROL_NAMESPACE } from '../src/control-plane.js';

describe('bootstrap — namespace install', () => {
  it('builds with control-plane only when raw config is empty', () => {
    const plugin = bootstrap({});
    expect(plugin.namespaces.map((n) => n.namespace)).toEqual([CONTROL_NAMESPACE]);
  });

  it('installs control-plane + ownedNamespaces when provided', () => {
    const plugin = bootstrap({ ownedNamespaces: ['sandbox', 'home'] });
    expect(plugin.namespaces.map((n) => n.namespace).sort()).toEqual(
      [CONTROL_NAMESPACE, 'home', 'sandbox'].sort()
    );
  });

  it('propagates the reserved-namespace check from createProposalsPlugin', () => {
    expect(() => bootstrap({ ownedNamespaces: [CONTROL_NAMESPACE] })).toThrow(/reserved/i);
  });
});

describe('bootstrap — config validation', () => {
  it('rejects ownedNamespaces that is not an array', () => {
    expect(() => bootstrap({ ownedNamespaces: 'sandbox,home' })).toThrow(BootstrapConfigError);
  });

  it('rejects ownedNamespaces with non-string elements', () => {
    expect(() => bootstrap({ ownedNamespaces: ['sandbox', 42] })).toThrow(BootstrapConfigError);
  });

  it('rejects proposeCapability that is not a string', () => {
    expect(() => bootstrap({ proposeCapability: 99 })).toThrow(BootstrapConfigError);
  });

  it('rejects unknown top-level keys (typo guard via .strict())', () => {
    expect(() => bootstrap({ ownedNamespacs: ['home'] })).toThrow(BootstrapConfigError);
  });
});
