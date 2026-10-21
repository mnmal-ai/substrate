/**
 * EmbedSourceRegistry and the embed-stats enumeration it feeds. The registry
 * answers "which types are embedded?" from configuration rather than from
 * the `row_type`s in `embeddings`, so a type that declares an
 * `embed.source` but has written no rows is still enumerated.
 */

import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import type { NamespaceDefinition } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { EmbedSourceRegistry } from '../src/embed-source-registry.js';
import { handleEmbedStatsRequest } from '../src/embed-stats-route.js';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import { createRecallPlugin } from '../src/plugin.js';

const noopHook = (async () => {}) as never;
const entry = (namespace: string, type: string) => ({ namespace, type, hook: noopHook });

describe('EmbedSourceRegistry', () => {
  it('enumerates a type that has written no rows — the point of the whole thing', () => {
    // No embeddings exist for this type anywhere. A row-derived answer would
    // report nothing; a configuration-derived one reports it.
    const reg = new EmbedSourceRegistry();
    reg.add(entry('cortext', 'AgentRule'));
    expect(reg.types()).toEqual([{ namespace: 'cortext', type: 'AgentRule' }]);
  });

  it('is idempotent on (namespace, type), keeping the latest registration', () => {
    // A re-install re-registers the same type. It must not duplicate, and the
    // newest hook wins because it reflects the currently-composed definition.
    const reg = new EmbedSourceRegistry();
    const first = entry('cortext', 'Memory');
    const second = { ...entry('cortext', 'Memory'), hook: (async () => {}) as never };
    reg.add(first);
    reg.add(second);
    expect(reg.size()).toBe(1);
    expect(reg.get('cortext', 'Memory')?.hook).toBe(second.hook);
  });

  it('sorts by (namespace, type) so two audit runs do not diff for no reason', () => {
    const reg = new EmbedSourceRegistry();
    reg.add(entry('cortext', 'SessionLog'));
    reg.add(entry('architecture', 'ArchitectureConcern'));
    reg.add(entry('cortext', 'Decision'));
    expect(reg.types()).toEqual([
      { namespace: 'architecture', type: 'ArchitectureConcern' },
      { namespace: 'cortext', type: 'Decision' },
      { namespace: 'cortext', type: 'SessionLog' }
    ]);
  });

  it('separates types that share a name across namespaces', () => {
    const reg = new EmbedSourceRegistry();
    reg.add(entry('cortext', 'Concept'));
    reg.add(entry('labs', 'Concept'));
    expect(reg.size()).toBe(2);
    expect(reg.get('labs', 'Concept')).toBeDefined();
  });

  it('reports an unregistered type as undefined rather than throwing', () => {
    expect(new EmbedSourceRegistry().get('cortext', 'Nope')).toBeUndefined();
  });

  it('does not leak the hook through types() — identity only', () => {
    // types() answers an audit question and is serialised into an HTTP
    // response. A closure has no business in either.
    const reg = new EmbedSourceRegistry();
    reg.add(entry('cortext', 'Memory'));
    expect(Object.keys(reg.types()[0] ?? {}).sort()).toEqual(['namespace', 'type']);
  });
});

describe('embed-stats enumeration', () => {
  it('surfaces the registry through the route payload', () => {
    const reg = new EmbedSourceRegistry();
    reg.add(entry('cortext', 'Memory'));
    expect(handleEmbedStatsRequest(undefined, reg).embeddedTypes).toEqual([
      { namespace: 'cortext', type: 'Memory' }
    ]);
  });

  it('always emits the field at runtime, so [] means "nothing" not "cannot tell"', () => {
    // The field is OPTIONAL in the type because an older server genuinely
    // omits it. This server never does: even with no registry at all it emits
    // `[]`. That keeps the two empty answers distinguishable on the wire —
    // absent means "server too old", [] means "nothing is embedded" — which
    // is the whole reason a caller must not write `?? []`.
    const res = handleEmbedStatsRequest(undefined, undefined);
    expect(res.embeddedTypes).toEqual([]);
    expect('embeddedTypes' in res).toBe(true);
    expect(res.enabled).toBe(false);
  });

  it('leaves the pre-existing snapshot shape untouched', () => {
    // The registry argument is optional: a new required parameter on an
    // exported function is a breaking change.
    const res = handleEmbedStatsRequest(undefined);
    expect(res).toMatchObject({ writes: 0, successes: 0, failures: 0, skips: 0, enabled: false });
  });
});

/**
 * The wiring: the tests above would pass if `createRecallPlugin` never
 * populated the registry. These drive the real plugin and read the answer
 * back off the real route.
 */
describe('createRecallPlugin populates the registry from real namespaces', () => {
  const makeNs = (namespace: string, types: NonNullable<NamespaceDefinition['types']>) => ({
    namespace,
    types,
    install: () => {}
  });

  const embedded = (name: string) => ({
    fields: { body: { kind: 'scalar' as const, type: 'string' as const } },
    embed: { source: (row: Record<string, unknown>) => `${name}:${String(row.body ?? '')}` }
  });

  function statsPayload(plugin: ReturnType<typeof createRecallPlugin>) {
    const route = plugin.kernelRoutes?.find((r) => r.path === 'embed-stats');
    if (route === undefined) throw new Error('embed-stats route not registered');
    const res = route.handler({} as never) as { body: unknown };
    return JSON.parse(String(res.body)) as { embeddedTypes: Array<Record<string, string>> };
  }

  it('registers exactly the types that declare embed.source, and serves them', () => {
    const plugin = createRecallPlugin({
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: new InMemoryEmbeddingsStore()
    });
    plugin.contributePostWrites!(
      makeNs('cortext', {
        Memory: embedded('Memory'),
        SessionLog: embedded('SessionLog'),
        Todo: { fields: { title: { kind: 'scalar', type: 'string' } } } // no embed
      })
    );

    // Read through the ROUTE, not the registry object: that is the path the
    // reindexer uses, and the one that can silently be left unwired.
    expect(statsPayload(plugin).embeddedTypes).toEqual([
      { namespace: 'cortext', type: 'Memory' },
      { namespace: 'cortext', type: 'SessionLog' }
    ]);
  });

  it('accumulates across namespaces, because they register one at a time', () => {
    // The reason the registry is read at call time rather than resolved
    // eagerly: substrate plugins compose before coordinator namespaces
    // install, so an answer computed at compose time would be empty.
    const plugin = createRecallPlugin({
      embedder: new FakeEmbedder({ dimension: 8 }),
      store: new InMemoryEmbeddingsStore()
    });
    expect(statsPayload(plugin).embeddedTypes).toEqual([]);

    plugin.contributePostWrites!(makeNs('cortext', { Memory: embedded('Memory') }));
    plugin.contributePostWrites!(makeNs('architecture', { Concern: embedded('Concern') }));

    expect(statsPayload(plugin).embeddedTypes).toEqual([
      { namespace: 'architecture', type: 'Concern' },
      { namespace: 'cortext', type: 'Memory' }
    ]);
  });

  it('stays empty in off-mode — no embedder means nothing is embedded', () => {
    const plugin = createRecallPlugin({ store: new InMemoryEmbeddingsStore() });
    plugin.contributePostWrites!(makeNs('cortext', { Memory: embedded('Memory') }));
    expect(statsPayload(plugin).embeddedTypes).toEqual([]);
  });
});
