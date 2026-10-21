/**
 * The subscribe path refuses one-shot-only surfaces at
 * registration: a virtual (dataset-less) namespace has no write stream to
 * subscribe to, and a semantic (extension-operator) where-clause has no
 * incremental evaluation. Both must be refused loudly with
 * `subscription_unsupported_frame` BEFORE registration (mirroring the
 * fail-at-registration posture of subscription_overloaded) — never silently
 * degraded, and never surfaced as the misleading `unknown_namespace` a virtual
 * ns would otherwise hit at the dataset lookup.
 *
 * Engine build mirrors engine-virtual-namespace.test.ts (coordinator ns 'app'
 * with a MemoryDataset + type 'Thing'; virtual ns 'recall' with type
 * 'Hit'). The SubscribeInput idiom mirrors subscription-obligations.test.ts.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { clearExtensionOperators, registerExtensionOperator } from '@mnmal-ai/substrate-filter';
import type { FilterOperatorDef, WsResponseFrame } from '@mnmal-ai/substrate-types';
import { WS_CODE_SUBSCRIPTION_UNSUPPORTED_FRAME } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

const stubOp: FilterOperatorDef = {
  validate: () => ({ ok: true, value: {} }),
  execute: async () => ({ hits: [] })
};

function makeEdges(): MemoryEdgesStore {
  return new MemoryEdgesStore({ now: () => new Date('2026-06-11T00:00:00Z') });
}

/** app/Thing (dataset-backed) + recall/Hit (virtual). */
function buildEngine(): Engine {
  const datasets = new MemoryDatasetRegistry();
  datasets.set('app', new MemoryDataset({ namespace: 'app' }));

  const appRegistry = new Registry();
  appRegistry.register('Thing', {
    kind: 'type',
    fields: {
      name: { kind: 'scalar', type: 'string', indexed: true },
      meta: { kind: 'struct', fields: { tag: { kind: 'scalar', type: 'string', indexed: true } } }
    },
    resolver: async () => []
  });

  const virtualRegistry = new Registry();
  virtualRegistry.register('Hit', {
    kind: 'type',
    resolver: async () => []
  });

  const namespaces = new Map<string, NamespaceConfig>([
    ['app', { registry: appRegistry }],
    ['recall', { registry: virtualRegistry, virtual: true }]
  ]);
  return new Engine({ namespaces, datasets, edges: makeEdges() });
}

interface Collector {
  frames: WsResponseFrame[];
  onFrame: (f: WsResponseFrame) => void;
}

function collector(): Collector {
  const frames: WsResponseFrame[] = [];
  return { frames, onFrame: (f): void => void frames.push(f) };
}

async function subscribe(
  engine: Engine,
  id: string,
  key: string,
  params: Record<string, unknown>
): Promise<Collector> {
  const c = collector();
  await engine.subscribe({
    id,
    frame: { [key]: { params, fields: { id: true } } },
    ctx: {},
    onFrame: c.onFrame
  });
  return c;
}

describe('subscribe — unsupported one-shot-only frames', () => {
  afterEach(() => clearExtensionOperators());

  it('refuses a virtual namespace with subscription_unsupported_frame; not registered', async () => {
    const engine = buildEngine();
    const c = await subscribe(engine, 'sub-virtual', 'recall/Hit', {});

    const first = c.frames[0];
    expect(first?.kind).toBe('error');
    expect(first?.errors?.[0]?.code).toBe(WS_CODE_SUBSCRIPTION_UNSUPPORTED_FRAME);
    expect(first?.errors?.[0]?.message).toContain('recall');
    expect(first?.errors?.[0]?.message).toContain('one-shot');
    expect(engine.activeSubscriptionCount()).toBe(0);
  });

  it('refuses a top-level extension operator in where; not registered', async () => {
    registerExtensionOperator('embeddingSimilar', stubOp);
    const engine = buildEngine();
    const c = await subscribe(engine, 'sub-ext', 'app/Thing', {
      where: { embeddingSimilar: { to: 'x' } }
    });

    const first = c.frames[0];
    expect(first?.kind).toBe('error');
    expect(first?.errors?.[0]?.code).toBe(WS_CODE_SUBSCRIPTION_UNSUPPORTED_FRAME);
    expect(first?.errors?.[0]?.message).toContain('extension operator');
    expect(engine.activeSubscriptionCount()).toBe(0);
  });

  it('refuses an extension operator nested inside AND/NOT combinators; not registered', async () => {
    registerExtensionOperator('embeddingSimilar', stubOp);
    const engine = buildEngine();
    const c = await subscribe(engine, 'sub-nested', 'app/Thing', {
      where: { AND: [{ NOT: { embeddingSimilar: { to: 'x' } } }] }
    });

    const first = c.frames[0];
    expect(first?.kind).toBe('error');
    expect(first?.errors?.[0]?.code).toBe(WS_CODE_SUBSCRIPTION_UNSUPPORTED_FRAME);
    expect(engine.activeSubscriptionCount()).toBe(0);
  });

  it('refuses an extension operator nested inside a struct-field sub-clause; not registered', async () => {
    registerExtensionOperator('embeddingSimilar', stubOp);
    const engine = buildEngine();
    const c = await subscribe(engine, 'sub-struct', 'app/Thing', {
      where: { meta: { embeddingSimilar: { to: 'x' } } }
    });

    const first = c.frames[0];
    expect(first?.kind).toBe('error');
    expect(first?.errors?.[0]?.code).toBe(WS_CODE_SUBSCRIPTION_UNSUPPORTED_FRAME);
    expect(engine.activeSubscriptionCount()).toBe(0);
  });

  it('control: a plain structural where still registers and emits a snapshot', async () => {
    const engine = buildEngine();
    const c = await subscribe(engine, 'sub-plain', 'app/Thing', {
      where: { name: { eq: 'x' } }
    });

    const first = c.frames[0];
    expect(first?.kind).toBe('snapshot');
    expect((first?.data as Record<string, unknown[]> | undefined)?.['app/Thing']).toEqual([]);
    expect(engine.activeSubscriptionCount()).toBe(1);
  });
});

async function waitForEnd(frames: WsResponseFrame[], timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!frames.some((f) => f.kind === 'end' || f.kind === 'error')) {
    if (Date.now() > deadline) throw new Error('timed out waiting for stream end/error');
    await new Promise<void>((r) => setImmediate(r));
  }
}

describe('stream — virtual-namespace refusal', () => {
  it('emits subscription_unsupported_frame + end; no chunk frames collected', async () => {
    const engine = buildEngine();
    const frames: WsResponseFrame[] = [];

    engine.stream({
      id: 'str-virtual',
      frame: { 'recall/Hit': { params: {}, fields: { id: true } } },
      ctx: {},
      onFrame: (f) => void frames.push(f)
    });

    await waitForEnd(frames);

    const err = frames.find((f) => f.kind === 'error');
    expect(err?.errors?.[0]?.code).toBe(WS_CODE_SUBSCRIPTION_UNSUPPORTED_FRAME);
    expect(err?.errors?.[0]?.message).toContain('recall');
    expect(frames.filter((f) => f.kind === 'chunk')).toHaveLength(0);
  });
});
