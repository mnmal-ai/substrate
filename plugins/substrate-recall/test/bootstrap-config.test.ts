/**
 * Structured-config bootstrap tests for `@mnmal-ai/substrate-recall`: the
 * substrate plugin is built correctly from a (rawConfig, hostDeps) pair, and
 * operator config mis-shapes are rejected at boot. Recall constructs the
 * embedder itself from config; hostDeps carries none.
 */

import { BootstrapConfigError } from '@mnmal-ai/substrate-bootstrap';
import { describe, expect, it } from 'vitest';
import { bootstrap, type RecallHostDeps } from '../src/bootstrap.js';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import { InMemoryLexicalStore } from '../src/in-memory-lexical-store.js';

const buildHostDeps = (overrides: Partial<RecallHostDeps> = {}): RecallHostDeps => ({
  store: new InMemoryEmbeddingsStore(),
  ...overrides
});

describe('bootstrap — kernel plugin shape', () => {
  it('builds substrate-recall with default HNSW knobs and an embedder-less host', () => {
    const plugin = bootstrap({}, buildHostDeps());
    expect(plugin.name).toBe('substrate-recall');
    // All three: 0002 (recall_clusters) and 0003 (lexical) apply even with no
    // ClusterStore or LexicalStore wired.
    expect(plugin.migrations?.map((m) => m.id)).toEqual([
      '0001_embeddings',
      '0002_recall_clusters',
      '0003_lexical'
    ]);
  });

  it('omits filter operators when no embedder is supplied', () => {
    const plugin = bootstrap({}, buildHostDeps());
    expect(plugin.filterOperators).toEqual({});
  });

  it('exposes the embeddingSimilar filter operator when embedder config is supplied', () => {
    const plugin = bootstrap({ embedder: { kind: 'fake', dimension: 1024 } }, buildHostDeps());
    expect(plugin.filterOperators?.embeddingSimilar).toBeDefined();
  });

  it('always exposes every kernel route through the manifest-loader path', () => {
    // Asserts the BOOTSTRAP path, not `createRecallPlugin`: the two can diverge
    // silently. Exhaustive equality (not `arrayContaining`) fails when a route
    // is added to one path only.
    const plugin = bootstrap({}, buildHostDeps());
    const paths = plugin.kernelRoutes?.map((r) => r.path).sort();
    expect(paths).toEqual([
      'crystallise',
      'embed-stats',
      'embed/reindex',
      'embeddings/fetch',
      'lexical/reindex',
      'recall',
      'salience/boost'
    ]);
  });

  it('gates the LEXICAL reindex route as admin through bootstrap too', () => {
    // Asserted separately from the test below: the two routes are declared at
    // two call sites, so one assertion covering both could pass while either
    // gate weakened.
    const plugin = bootstrap({}, buildHostDeps());
    const route = plugin.kernelRoutes?.find((r) => r.path === 'lexical/reindex');
    expect(route?.capability).toBe('admin');
  });

  it('gates the reindex route as admin through bootstrap too', () => {
    // The capability is the whole security posture of this route and it is
    // declared in the factory; bootstrap could forward the route while a
    // future refactor rebuilt the claim with a weaker gate.
    const plugin = bootstrap({}, buildHostDeps());
    const route = plugin.kernelRoutes?.find((r) => r.path === 'embed/reindex');
    expect(route?.capability).toBe('admin');
  });
});

describe('bootstrap — config validation', () => {
  it('rejects non-positive hnswM', () => {
    expect(() => bootstrap({ hnswM: 0 }, buildHostDeps())).toThrow(BootstrapConfigError);
    expect(() => bootstrap({ hnswM: -4 }, buildHostDeps())).toThrow(BootstrapConfigError);
  });

  it('rejects non-integer hnswM', () => {
    expect(() => bootstrap({ hnswM: 16.5 }, buildHostDeps())).toThrow(BootstrapConfigError);
  });

  it('rejects non-positive hnswEfConstruction', () => {
    expect(() => bootstrap({ hnswEfConstruction: 0 }, buildHostDeps())).toThrow(
      BootstrapConfigError
    );
  });

  it('rejects unknown top-level keys (typo guard via .strict())', () => {
    expect(() => bootstrap({ hnsmm: 16 }, buildHostDeps())).toThrow(BootstrapConfigError);
  });

  it('accepts a minimal fake-embedder config without hnsw* (defaults fill in)', () => {
    expect(() =>
      bootstrap({ embedder: { kind: 'fake', dimension: 8 } }, buildHostDeps())
    ).not.toThrow();
  });

  it('rejects unknown keys inside an embedder variant (typo guard via .strict())', () => {
    // Deliberate typo (`timeoutMS` vs `timeoutMs`) — must be rejected, not silently dropped.
    expect(() =>
      bootstrap(
        {
          embedder: {
            kind: 'ollama',
            baseUrl: 'http://x',
            model: 'm',
            dimension: 8,
            timeoutMS: 60_000
          } as unknown as { kind: 'ollama'; baseUrl: string; model: string; dimension: number }
        },
        buildHostDeps()
      )
    ).toThrow(BootstrapConfigError);
  });
});

describe('expansion config', () => {
  it('parses default expansion block', () => {
    const cfg = bootstrap({}, buildHostDeps());
    // The plugin is returned on success, but the config itself isn't exposed publicly.
    // We need to test via the bootstrap fn parsing directly instead.
    expect(cfg.name).toBe('substrate-recall');
  });

  it('parses custom expansion block', () => {
    expect(() =>
      bootstrap(
        {
          expansion: { enabled: false, maxNeighboursPerSeed: 4, maxTotalNeighbours: 20 }
        },
        buildHostDeps()
      )
    ).not.toThrow();
  });

  it('rejects negative caps', () => {
    expect(() =>
      bootstrap(
        {
          expansion: { maxNeighboursPerSeed: -1 }
        },
        buildHostDeps()
      )
    ).toThrow(BootstrapConfigError);
  });
});

/**
 * Host deps must be forwarded by `bootstrap`, the factory the manifest loader
 * calls; a test against `createRecallPlugin` cannot see a dep that bootstrap
 * drops. A dropped `checkWritePolicy` is silent because the gate fails closed.
 */
describe('bootstrap — host deps reach the plugin', () => {
  it('forwards checkWritePolicy, the dep whose absence fails closed and silently', async () => {
    const calls: Array<[string, string]> = [];
    const plugin = bootstrap(
      {},
      buildHostDeps({
        checkWritePolicy: (ns: string, type: string) => {
          calls.push([ns, type]);
          return { allow: true };
        }
      })
    );
    // Reach through the composed plugin rather than inspecting config: the
    // question is whether the probe is CONSULTED, not whether it was stored.
    const claim = plugin.kernelRoutes?.find((r) => r.path === 'salience/boost');
    expect(claim).toBeDefined();
    const res = await claim!.handler({
      body: Buffer.from(JSON.stringify({ targets: [{ namespace: 'demo', type: 'Doc', id: 'x' }] })),
      identity: { id: 'agent-1' }
    } as never);
    expect(res.status).toBe(200);
    expect(calls).toEqual([['demo', 'Doc']]);
  });

  it('without it, the boost route refuses — proving the default is closed, not open', async () => {
    const plugin = bootstrap({}, buildHostDeps());
    const claim = plugin.kernelRoutes?.find((r) => r.path === 'salience/boost');
    const res = await claim!.handler({
      body: Buffer.from(JSON.stringify({ targets: [{ namespace: 'demo', type: 'Doc', id: 'x' }] })),
      identity: { id: 'agent-1' }
    } as never);
    expect(res.status).toBe(403);
    expect(String(res.body)).toContain('write policy not wired');
  });
});

describe('bootstrap — the lexical arm must be reachable from a host', () => {
  const nsWithLexical = {
    namespace: 'cortext',
    types: {
      Memory: {
        fields: { body: { kind: 'scalar', type: 'string' } },
        lexical: { source: (r: Record<string, unknown>) => String(r.body ?? '') }
      }
    },
    install: () => {}
  } as unknown as Parameters<NonNullable<ReturnType<typeof bootstrap>['contributePostWrites']>>[0];

  /**
   * Goes through the seam a host uses: a test that hands a store directly to
   * `createRecallPlugin` cannot see a LexicalStore that bootstrap never accepts.
   */
  it('contributes a lexical hook when the host supplies a lexicalStore', () => {
    const plugin = bootstrap({}, buildHostDeps({ lexicalStore: new InMemoryLexicalStore() }));
    expect(Object.keys(plugin.contributePostWrites?.(nsWithLexical) ?? {})).toEqual(['Memory']);
  });

  /**
   * And stays off when the host supplies nothing — the arm is opt-in at the
   * host seam, not merely at the type declaration.
   */
  it('contributes nothing when the host supplies no lexicalStore', () => {
    const plugin = bootstrap({}, buildHostDeps());
    expect(plugin.contributePostWrites?.(nsWithLexical) ?? {}).toEqual({});
  });
});
