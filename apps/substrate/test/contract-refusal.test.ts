/**
 * The binary REFUSES a plugin whose declared contract range excludes it.
 *
 * `onViolation` is the policy hook: `composeFromManifests` calls it and does
 * nothing else, so warn-vs-refuse is decided entirely in the host by whether
 * the handler returns or throws. That is why this test lives in apps/substrate.
 *
 * Fatal rather than loud because a mismatched plugin does not fail at the
 * point of mismatch: it loads, and an optional member that moved silently
 * takes the absent-callback path.
 */

import { describe, expect, it } from 'vitest';
import { BINARY_CONTRACT_VERSION, refuseContractViolation } from '../src/main.js';

const violation = (over: Partial<Parameters<typeof refuseContractViolation>[0]> = {}) => ({
  packageName: '@mnmal-ai/cortext',
  tier: 'coordinator' as const,
  declared: '>=4.1.0 <5.0.0',
  hostVersion: '5.0.0',
  reason: 'unsatisfied' as const,
  ...over
});

describe('contract refusal', () => {
  it('throws rather than returning — a returning handler is warn mode', () => {
    expect(() => refuseContractViolation(violation())).toThrow();
  });

  it('names the package, the declared range and the host version', () => {
    // An operator reading this has a service that will not start and the fix
    // is a range in someone else's manifest — all three facts are needed to
    // act without opening the code.
    expect(() => refuseContractViolation(violation())).toThrow(/@mnmal-ai\/cortext/);
    expect(() => refuseContractViolation(violation())).toThrow(/>=4\.1\.0 <5\.0\.0/);
    expect(() => refuseContractViolation(violation())).toThrow(/5\.0\.0/);
  });

  it('distinguishes an unparseable range from an unsatisfied one', () => {
    expect(() => refuseContractViolation(violation({ reason: 'invalid-range' }))).toThrow(
      /not a valid semver range/
    );
    expect(() => refuseContractViolation(violation())).toThrow(/does not admit this binary/);
  });

  /**
   * The binary's own version must satisfy what its bundled plugins declare,
   * or it refuses them at boot. Computed from the real constant and the real
   * plugin sources rather than hardcoded, so a version bump or a narrowed
   * ceiling fails at `pnpm test` instead of on the next restart.
   */
  it('this binary satisfies every in-repo plugin range it will be asked to load', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const semver = (await import('semver')).default;

    const pluginsDir = new URL('../../../plugins', import.meta.url).pathname;
    const declared: Array<{ plugin: string; range: string }> = [];
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let src: string;
      try {
        src = readdirSync(join(pluginsDir, entry.name, 'src'))
          .filter((f) => f.endsWith('.ts'))
          .map((f) => readFileSync(join(pluginsDir, entry.name, 'src', f), 'utf8'))
          .join('\n');
      } catch {
        continue;
      }
      const m = src.match(/contractVersion:\s*'([^']+)'/);
      if (m?.[1] !== undefined) {
        declared.push({ plugin: entry.name, range: m[1] });
        continue;
      }
      // substrate-nl declares its range through a named const
      // (`contractVersion: CONTRACT_VERSION`), which the literal-only match
      // above misses.
      const ref = src.match(/contractVersion:\s*([A-Z_][A-Z0-9_]*)/);
      const def =
        ref?.[1] !== undefined ? src.match(new RegExp(`${ref[1]}\\s*=\\s*'([^']+)'`)) : null;
      if (ref?.[1] !== undefined && def?.[1] !== undefined)
        declared.push({ plugin: entry.name, range: def[1] });
    }

    expect(declared.length).toBeGreaterThan(0);
    // substrate-nl's range arrives via the const-indirect form above — if a
    // refactor drops it from the collection, the suite goes green while the
    // one load-bearing floor goes unpinned.
    expect(declared.map((d) => d.plugin)).toContain('substrate-nl');
    const rejected = declared.filter((d) => !semver.satisfies(BINARY_CONTRACT_VERSION, d.range));
    expect(
      rejected,
      `this binary is ${BINARY_CONTRACT_VERSION} and would REFUSE these plugins at boot, ` +
        'leaving the service dead on restart'
    ).toEqual([]);
  });
});
