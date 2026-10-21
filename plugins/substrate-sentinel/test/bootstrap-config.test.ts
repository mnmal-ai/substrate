/**
 * Tests the `bootstrap(rawConfig)` entry the `SUBSTRATE_PLUGIN_DIR` loader calls,
 * for the sentinel-specific contract. The shared helper contract is covered in
 * `packages/substrate-bootstrap/test/bootstrap.test.ts`.
 */

import { BootstrapConfigError } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';

describe('bootstrap — namespace + schedule install', () => {
  it('installs the sentinel namespace by default', () => {
    const plugin = bootstrap({});
    expect(plugin.name).toBe('substrate-sentinel');
    expect(plugin.namespaces.map((n) => n.namespace)).toEqual(['sentinel']);
  });

  it('respects a namespace override', () => {
    const plugin = bootstrap({ namespace: 'discovery' });
    expect(plugin.namespaces.map((n) => n.namespace)).toEqual(['discovery']);
  });

  it('schedules the liveness tick at the default 30s interval', () => {
    const plugin = bootstrap({});
    expect(plugin.schedule).toHaveLength(1);
    expect(plugin.schedule?.[0]?.intervalMs).toBe(30_000);
    expect(plugin.schedule?.[0]?.name).toBe('sentinel-liveness');
  });

  it('honours an explicit pingIntervalMs override', () => {
    const plugin = bootstrap({ pingIntervalMs: 5_000 });
    expect(plugin.schedule?.[0]?.intervalMs).toBe(5_000);
  });
});

describe('bootstrap — config validation', () => {
  it('rejects empty namespace', () => {
    expect(() => bootstrap({ namespace: '' })).toThrow(BootstrapConfigError);
  });

  it("rejects namespace containing '/'", () => {
    expect(() => bootstrap({ namespace: 'foo/bar' })).toThrow(BootstrapConfigError);
  });

  it('rejects non-positive pingIntervalMs', () => {
    expect(() => bootstrap({ pingIntervalMs: 0 })).toThrow(BootstrapConfigError);
    expect(() => bootstrap({ pingIntervalMs: -100 })).toThrow(BootstrapConfigError);
  });

  it('rejects non-integer pingIntervalMs', () => {
    expect(() => bootstrap({ pingIntervalMs: 1500.5 })).toThrow(BootstrapConfigError);
  });

  it('rejects non-positive staleThresholdMs', () => {
    expect(() => bootstrap({ staleThresholdMs: 0 })).toThrow(BootstrapConfigError);
  });

  it('rejects unknown top-level keys (typo guard via .strict())', () => {
    expect(() => bootstrap({ namespacee: 'typo' })).toThrow(BootstrapConfigError);
  });
});
