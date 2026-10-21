/**
 * `composeFromManifests` — the shared plugin-instantiation primitive.
 *
 * Owns the reusable middle that a downstream single-file binary (e.g. brain)
 * would otherwise have to fork: tier ordering (substrate before coordinator,
 * alphabetical within tier), bootstrap invocation, and BootstrapConfigError
 * wrapping. Discovery + module/config resolution are injected, so the same
 * composition contract serves both the fs-scan binary path and a
 * statically-bundled manifest list.
 */

import { BootstrapConfigError } from '@mnmal-ai/substrate-bootstrap';
import type { CoordinatorPlugin, KernelPlugin } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ContractViolation, composeFromManifests, PluginLoadError } from '../src/index.js';

interface TestManifest {
  packageName: string;
  pluginId?: string;
  tier: 'kernel' | 'coordinator';
}

const coord = (name: string): CoordinatorPlugin => ({
  name,
  namespaces: [],
  contractVersion: '*'
});

const sub = (name: string): KernelPlugin => ({ name, contractVersion: '*' });

describe('composeFromManifests', () => {
  it('loads kernel plugins before coordinators, alphabetical within tier', async () => {
    const manifests: TestManifest[] = [
      { packageName: 'z-coord', tier: 'coordinator' },
      { packageName: 'a-coord', tier: 'coordinator' },
      { packageName: 'b-sub', tier: 'kernel' },
      { packageName: 'a-sub', tier: 'kernel' }
    ];

    const result = await composeFromManifests({
      manifests,
      resolveBootstrap: (m) =>
        m.tier === 'kernel' ? () => sub(m.packageName) : () => coord(m.packageName),
      kernelHostDeps: {}
    });

    expect(result.kernel.map((p) => p.name)).toEqual(['a-sub', 'b-sub']);
    expect(result.coordinators.map((p) => p.name)).toEqual(['a-coord', 'z-coord']);
  });

  it('invokes a coordinator bootstrap with its resolved config (config only, no host deps)', async () => {
    const seen: { config: Record<string, unknown>; argc: number }[] = [];
    const result = await composeFromManifests<TestManifest>({
      manifests: [{ packageName: 'c', tier: 'coordinator' }],
      resolveConfig: () => ({ knob: 42 }),
      resolveBootstrap: () => (config, hostDeps) => {
        seen.push({ config, argc: hostDeps === undefined ? 1 : 2 });
        return coord('c');
      },
      kernelHostDeps: { sql: 'unused' }
    });

    expect(result.coordinators.map((p) => p.name)).toEqual(['c']);
    expect(seen).toEqual([{ config: { knob: 42 }, argc: 1 }]);
  });

  it('invokes a kernel bootstrap with resolved config AND the host-deps bag', async () => {
    const hostDeps = { sql: Symbol('sql') };
    let received: { config: Record<string, unknown>; deps: unknown } | undefined;
    await composeFromManifests<TestManifest>({
      manifests: [{ packageName: 's', tier: 'kernel' }],
      resolveConfig: () => ({ dim: 768 }),
      resolveBootstrap: () => (config, deps) => {
        received = { config, deps };
        return sub('s');
      },
      kernelHostDeps: hostDeps
    });

    expect(received).toEqual({ config: { dim: 768 }, deps: hostDeps });
  });

  it('defaults merged config to {} when no resolveConfig is supplied', async () => {
    const result = await composeFromManifests<TestManifest>({
      manifests: [{ packageName: 'c', tier: 'coordinator' }],
      resolveBootstrap: () => (config) => {
        expect(config).toEqual({});
        return coord('c');
      },
      kernelHostDeps: {}
    });
    expect(result.configs.get('c')).toEqual({});
  });

  it('wraps a BootstrapConfigError as a PluginLoadError attributing the package', async () => {
    const zodErr = z.object({ knob: z.number() }).safeParse({ knob: 'nope' });
    if (zodErr.success) throw new Error('fixture should have failed to parse');

    const err = await composeFromManifests<TestManifest>({
      manifests: [{ packageName: '@scope/bad-cfg', tier: 'coordinator' }],
      resolveBootstrap: () => () => {
        throw new BootstrapConfigError(zodErr.error);
      },
      kernelHostDeps: {}
    }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(PluginLoadError);
    expect((err as PluginLoadError).packageName).toBe('@scope/bad-cfg');
    expect((err as PluginLoadError).message).toContain('[@scope/bad-cfg]');
    expect((err as PluginLoadError).message).toContain('config invalid');
  });

  it('wraps a generic bootstrap throw as a PluginLoadError attributing the package', async () => {
    const err = await composeFromManifests<TestManifest>({
      manifests: [{ packageName: 'kaboom', tier: 'kernel' }],
      resolveBootstrap: () => () => {
        throw new Error('exploded');
      },
      kernelHostDeps: {}
    }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(PluginLoadError);
    expect((err as PluginLoadError).message).toContain('[kaboom]');
    expect((err as PluginLoadError).message).toContain('bootstrap threw: exploded');
  });
});

describe('composeFromManifests § several plugins in one package', () => {
  const twoHalves: TestManifest[] = [
    { packageName: '@x/pkg', pluginId: '@x/pkg/coordinator', tier: 'coordinator' },
    { packageName: '@x/pkg', pluginId: '@x/pkg/kernel', tier: 'kernel' }
  ];

  it('keys configs by plugin id, so two plugins from one package do not share a slot', async () => {
    const result = await composeFromManifests<TestManifest>({
      manifests: twoHalves,
      resolveConfig: (m) => ({ id: m.pluginId }),
      resolveBootstrap: (m) =>
        m.tier === 'kernel' ? () => sub(m.pluginId ?? '') : () => coord(m.pluginId ?? ''),
      kernelHostDeps: {}
    });

    expect(result.kernel.map((p) => p.name)).toEqual(['@x/pkg/kernel']);
    expect(result.coordinators.map((p) => p.name)).toEqual(['@x/pkg/coordinator']);
    expect(result.configs.get('@x/pkg/kernel')).toEqual({ id: '@x/pkg/kernel' });
    expect(result.configs.get('@x/pkg/coordinator')).toEqual({ id: '@x/pkg/coordinator' });
  });

  it('attributes a bootstrap failure to the plugin id, not the bare package', async () => {
    const err = await composeFromManifests<TestManifest>({
      manifests: twoHalves,
      resolveBootstrap: (m) =>
        m.tier === 'kernel'
          ? () => {
              throw new Error('exploded');
            }
          : () => coord('c'),
      kernelHostDeps: {}
    }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect((err as PluginLoadError).packageName).toBe('@x/pkg/kernel');
  });

  it('refuses two manifests under one id before invoking anything', async () => {
    let invoked = 0;
    const err = await composeFromManifests<TestManifest>({
      manifests: [
        { packageName: 'dup', tier: 'coordinator' },
        { packageName: 'dup', tier: 'kernel' }
      ],
      resolveBootstrap: () => () => {
        invoked += 1;
        return coord('dup');
      },
      kernelHostDeps: {}
    }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(PluginLoadError);
    expect((err as Error).message).toContain('[dup] two plugins declare this id');
    expect(invoked).toBe(0);
  });
});

/**
 * Contract-version gate: each plugin's declared host range is consulted, not
 * merely that plugins load.
 */
describe('composeFromManifests § contract-version gate', () => {
  const load = async (
    declared: string,
    hostVersion: string,
    tier: 'kernel' | 'coordinator' = 'coordinator'
  ): Promise<ContractViolation[]> => {
    const seen: ContractViolation[] = [];
    await composeFromManifests<TestManifest>({
      manifests: [{ packageName: 'p', tier }],
      kernelHostDeps: {},
      resolveBootstrap: () => () =>
        tier === 'coordinator'
          ? { name: 'p', namespaces: [], contractVersion: declared }
          : { name: 'p', contractVersion: declared },
      contractCheck: { hostVersion, onViolation: (v) => seen.push(v) }
    });
    return seen;
  };

  it('stays silent when the declared range admits the host', async () => {
    expect(await load('>=4.1.0 <5.0.0', '4.1.1')).toEqual([]);
  });

  it('reports a range that excludes the host — the drift that went unnoticed for three months', async () => {
    const seen = await load('^2.3.0', '4.1.1');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe('unsatisfied');
    expect(seen[0]?.declared).toBe('^2.3.0');
    expect(seen[0]?.hostVersion).toBe('4.1.1');
    expect(seen[0]?.packageName).toBe('p');
  });

  it('distinguishes an unparseable range from an unsatisfied one', async () => {
    const seen = await load('not-a-range', '4.1.1');
    expect(seen[0]?.reason).toBe('invalid-range');
  });

  /**
   * The FLOOR. 4.1.0 broke the plugin interface inside major 4, so a plugin
   * built for that interface must not claim compatibility with 4.0.x — which
   * is why every declared range starts at 4.1.0 rather than at ^4.
   */
  it('a >=4.1.0 range refuses a 4.0.x host — the floor is not decorative', async () => {
    expect((await load('>=4.1.0 <5.0.0', '4.0.2'))[0]?.reason).toBe('unsatisfied');
  });

  /**
   * The CEILING tracks actual compatibility rather than the next major
   * boundary: v5.0.0 breaks nothing a plugin consumes, so a plugin built for
   * 4.1.x declares `<6.0.0` and a 5.x host is admitted. Narrowing it to
   * `<5.0.0` would make a 5.x binary refuse every plugin and fail to boot.
   */
  it('a <6.0.0 ceiling admits a 5.x host, which is what makes v5.0.0 deployable', async () => {
    expect(await load('>=4.1.0 <6.0.0', '5.0.0')).toEqual([]);
    // ...and still excludes the major after it.
    expect((await load('>=4.1.0 <6.0.0', '6.0.0'))[0]?.reason).toBe('unsatisfied');
  });

  it('checks kernel plugins too, and labels the tier', async () => {
    const seen = await load('^2.3.0', '4.1.1', 'kernel');
    expect(seen[0]?.tier).toBe('kernel');
  });

  it('skips entirely when no contractCheck is supplied — consumers that do not version-gate', async () => {
    const result = await composeFromManifests<TestManifest>({
      manifests: [{ packageName: 'p', tier: 'coordinator' }],
      kernelHostDeps: {},
      resolveBootstrap: () => () => coord('p')
    });
    expect(result.coordinators).toHaveLength(1);
  });

  it('warns but still loads — the check must not refuse in this release', async () => {
    const seen: ContractViolation[] = [];
    const result = await composeFromManifests<TestManifest>({
      manifests: [{ packageName: 'p', tier: 'coordinator' }],
      kernelHostDeps: {},
      resolveBootstrap: () => () => ({ name: 'p', namespaces: [], contractVersion: '^2.3.0' }),
      contractCheck: { hostVersion: '4.1.1', onViolation: (v) => seen.push(v) }
    });
    expect(seen).toHaveLength(1);
    expect(result.coordinators).toHaveLength(1);
  });

  /**
   * `onViolation` IS the policy — throwing from it is how the binary will
   * flip to refusal at the next major without this package changing.
   */
  it('propagates a throwing onViolation, so refusal is a host-side one-liner', async () => {
    await expect(
      composeFromManifests<TestManifest>({
        manifests: [{ packageName: 'p', tier: 'coordinator' }],
        kernelHostDeps: {},
        resolveBootstrap: () => () => ({ name: 'p', namespaces: [], contractVersion: '^2.3.0' }),
        contractCheck: {
          hostVersion: '4.1.1',
          onViolation: () => {
            throw new Error('refused');
          }
        }
      })
    ).rejects.toThrow('refused');
  });
});
