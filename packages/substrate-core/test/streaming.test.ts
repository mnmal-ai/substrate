/**
 * §5.5 Streaming engine tests. Mirrors the `subscribe` unit tests but drives
 * async-iterable resolvers through the stream pipeline.
 */
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { denyAll, row } from '@mnmal-ai/substrate-policy';
import type {
  FieldDef,
  Policy,
  RequestContext,
  Row,
  WsResponseFrame
} from '@mnmal-ai/substrate-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

interface Ctx {
  engine: Engine;
  dataset: MemoryDataset;
  edges: MemoryEdgesStore;
  registry: Registry;
}

function makeCtx(overrides: Partial<RequestContext> = {}): Partial<RequestContext> {
  return {
    identity: null,
    now: new Date('2026-04-18T00:00:00Z'),
    headers: {},
    meta: {},
    ...overrides
  };
}

function todoFields(): Record<string, FieldDef> {
  return {
    id: { kind: 'scalar', type: 'string', indexed: true },
    title: { kind: 'scalar', type: 'string', indexed: true }
  };
}

function bootstrap(): Ctx {
  const dataset = new MemoryDataset({ namespace: 'default' });
  const edges = new MemoryEdgesStore({ now: () => new Date('2026-04-18T00:00:00Z') });
  const registry = new Registry();
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', dataset);
  const namespaces = new Map<string, NamespaceConfig>([['default', { registry }]]);
  const engine = new Engine({ namespaces, datasets, edges });
  return { engine, dataset, edges, registry };
}

async function waitForEnd(frames: WsResponseFrame[], timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!frames.some((f) => f.kind === 'end' || f.kind === 'error')) {
    if (Date.now() > deadline) throw new Error('timed out waiting for stream end/error');
    await new Promise<void>((r) => setImmediate(r));
  }
}

async function waitForCount(frames: WsResponseFrame[], n: number, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (frames.length < n) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${n} frames; got ${frames.length}`);
    }
    await new Promise<void>((r) => setImmediate(r));
  }
}

describe('Engine.stream — happy path (§5.5)', () => {
  let ctx: Ctx;
  let frames: WsResponseFrame[];

  beforeEach(() => {
    ctx = bootstrap();
    frames = [];
  });

  it('accepts the metadata spellings a query accepts, as canonical columns', async () => {
    let seen: unknown;
    ctx.registry.register('Todo', {
      kind: 'type',
      fields: todoFields(),
      resolver: async (_c, args) => {
        seen = args.params?.where;
        return (async function* () {})();
      }
    });

    ctx.engine.stream({
      id: 'str-meta',
      frame: {
        'default/Todo': { params: { where: { createdBy: { eq: 'k1' } } }, fields: { id: true } }
      },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    await waitForEnd(frames);

    expect(frames.find((f) => f.kind === 'error')).toBeUndefined();
    expect(seen).toEqual({ createdById: { eq: 'k1' } });
  });

  it('refuses a mutation entry without running it', async () => {
    let ran = false;
    ctx.registry.register('createTodo', {
      kind: 'mutation',
      fields: todoFields(),
      resolver: async () => {
        ran = true;
        return { id: 'x' } as Row;
      }
    });

    ctx.engine.stream({
      id: 'str-mut',
      frame: { 'default/createTodo': { params: { title: 't' }, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    await waitForEnd(frames);

    expect(ran).toBe(false);
    expect(frames.some((f) => f.kind === 'error')).toBe(true);
  });

  it('resolver yielding 3 rows emits 3 chunks + end', async () => {
    const rows: Row[] = [{ id: 'a' } as Row, { id: 'b' } as Row, { id: 'c' } as Row];
    ctx.registry.register('streamTodos', {
      kind: 'type',
      fields: todoFields(),
      resolver: async function* () {
        for (const r of rows) yield r;
      }
    });

    ctx.engine.stream({
      id: 'str-1',
      frame: { 'default/streamTodos': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    await waitForEnd(frames);

    const chunkFrames = frames.filter((f) => f.kind === 'chunk');
    expect(chunkFrames).toHaveLength(3);
    expect(frames[frames.length - 1]?.kind).toBe('end');
    expect(frames[frames.length - 1]?.final).toBe(true);
  });

  it('sequence numbers monotonic from 0', async () => {
    ctx.registry.register('seqTodos', {
      kind: 'type',
      fields: todoFields(),
      resolver: async function* () {
        yield { id: '1' } as Row;
        yield { id: '2' } as Row;
        yield { id: '3' } as Row;
      }
    });
    ctx.engine.stream({
      id: 'str-seq',
      frame: { 'default/seqTodos': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    await waitForEnd(frames);
    const seqs = frames.filter((f) => f.kind === 'chunk').map((f) => f.sequence);
    expect(seqs).toEqual([0, 1, 2]);
  });

  it('each chunk carries schemaVersion + single-shape + qualified key', async () => {
    ctx.registry.register('shapeTodos', {
      kind: 'type',
      fields: todoFields(),
      resolver: async function* () {
        yield { id: 'only', title: 'hi' } as Row;
      }
    });
    ctx.engine.stream({
      id: 'str-shape',
      frame: { 'default/shapeTodos': { params: {}, fields: { id: true, title: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    await waitForEnd(frames);
    const chunk = frames.find((f) => f.kind === 'chunk');
    expect(chunk?.shapes).toEqual({ 'default/shapeTodos': 'single' });
    expect(typeof chunk?.schemaVersion).toBe('string');
    const data = chunk?.data as Record<string, unknown>;
    expect(data['default/shapeTodos']).toEqual({ id: 'only', title: 'hi' });
  });
});

describe('Engine.stream — error paths (§5.5)', () => {
  let ctx: Ctx;
  let frames: WsResponseFrame[];

  beforeEach(() => {
    ctx = bootstrap();
    frames = [];
  });

  it('resolver throwing mid-iteration → error frame, then end, no more chunks', async () => {
    ctx.registry.register('boomTodos', {
      kind: 'type',
      fields: todoFields(),
      resolver: async function* () {
        yield { id: '1' } as Row;
        throw new Error('explode');
      }
    });
    ctx.engine.stream({
      id: 'str-err',
      frame: { 'default/boomTodos': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    await waitForEnd(frames);
    expect(frames.filter((f) => f.kind === 'chunk')).toHaveLength(1);
    const err = frames.find((f) => f.kind === 'error');
    expect(err?.errors?.[0]?.code).toBe('resolver_error');
    expect(err?.errors?.[0]?.message).toBe('internal error');
    expect(frames[frames.length - 1]?.kind).toBe('end');
  });

  it('non-iterable resolver return → not_streamable error + end', async () => {
    ctx.registry.register('plainTodos', {
      kind: 'type',
      fields: todoFields(),
      resolver: async () => [{ id: '1' } as Row]
    });
    ctx.engine.stream({
      id: 'str-plain',
      frame: { 'default/plainTodos': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    await waitForEnd(frames);
    const err = frames.find((f) => f.kind === 'error');
    expect(err?.errors?.[0]?.code).toBe('not_streamable');
    expect(frames.filter((f) => f.kind === 'chunk')).toHaveLength(0);
  });

  it('multi-key frame → stream_multi_key error + end', async () => {
    ctx.registry.register('oneTodos', {
      kind: 'type',
      fields: todoFields(),
      resolver: async function* () {
        yield { id: '1' } as Row;
      }
    });
    ctx.registry.register('twoTodos', {
      kind: 'type',
      fields: todoFields(),
      resolver: async function* () {
        yield { id: '2' } as Row;
      }
    });
    ctx.engine.stream({
      id: 'str-multi',
      frame: {
        'default/oneTodos': { params: {}, fields: { id: true } },
        'default/twoTodos': { params: {}, fields: { id: true } }
      },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    // Multi-key errors emit synchronously via onFrame before stream() returns.
    expect(frames.filter((f) => f.kind === 'error')).toHaveLength(1);
    expect(frames[0]?.errors?.[0]?.code).toBe('stream_multi_key');
    expect(frames[1]?.kind).toBe('end');
  });

  it('empty frame → stream_multi_key error + end', async () => {
    ctx.engine.stream({
      id: 'str-empty',
      frame: {},
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    expect(frames[0]?.kind).toBe('error');
    expect(frames[0]?.errors?.[0]?.code).toBe('stream_multi_key');
    expect(frames[1]?.kind).toBe('end');
  });

  it('policy deny → error frame + end, resolver never invoked', async () => {
    const policy: Policy = denyAll('nope');
    let called = false;
    ctx.registry.register('deniedTodos', {
      kind: 'type',
      fields: todoFields(),
      policy,
      resolver: async function* () {
        called = true;
        yield { id: '1' } as Row;
      }
    });
    ctx.engine.stream({
      id: 'str-deny',
      frame: { 'default/deniedTodos': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    await waitForEnd(frames);
    expect(called).toBe(false);
    const err = frames.find((f) => f.kind === 'error');
    expect(err?.errors?.[0]?.code).toBe('policy_denied');
  });

  it('filter validation failure → error frame + end, resolver never invoked', async () => {
    let called = false;
    ctx.registry.register('Todo', {
      kind: 'type',
      fields: todoFields(),
      resolver: async function* () {
        called = true;
        yield { id: '1' } as Row;
      }
    });
    ctx.engine.stream({
      id: 'str-badwhere',
      frame: {
        'default/Todo': { params: { where: { ghost: { eq: 'x' } } }, fields: { id: true } }
      },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    await waitForEnd(frames);
    expect(called).toBe(false);
    const err = frames.find((f) => f.kind === 'error');
    expect(err?.errors?.[0]?.code).toBe('unknown_field');
  });

  it('unqualified key → unqualified_key error + end', async () => {
    ctx.engine.stream({
      id: 'str-raw',
      frame: { Todo: { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    await waitForEnd(frames);
    const err = frames.find((f) => f.kind === 'error');
    expect(err?.errors?.[0]?.code).toBe('unqualified_key');
  });

  it('unknown namespace → unknown_namespace error + end', async () => {
    ctx.engine.stream({
      id: 'str-ns',
      frame: { 'ghost/Todo': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    await waitForEnd(frames);
    const err = frames.find((f) => f.kind === 'error');
    expect(err?.errors?.[0]?.code).toBe('unknown_namespace');
  });

  it('unknown name → unknown_name error + end', async () => {
    ctx.engine.stream({
      id: 'str-nm',
      frame: { 'default/Mystery': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    await waitForEnd(frames);
    const err = frames.find((f) => f.kind === 'error');
    expect(err?.errors?.[0]?.code).toBe('unknown_name');
  });
});

describe('Engine.stream — cancellation (§5.5)', () => {
  let ctx: Ctx;
  let frames: WsResponseFrame[];

  beforeEach(() => {
    ctx = bootstrap();
    frames = [];
  });

  it('cancel before first yield → end frame with cancelled _meta; resolver cleanup runs', async () => {
    let cleaned = false;
    let gate!: () => void;
    const ready = new Promise<void>((resolve) => {
      gate = resolve;
    });
    ctx.registry.register('slowTodos', {
      kind: 'type',
      fields: todoFields(),
      resolver: async function* (_ctx, args) {
        const { signal } = args;
        try {
          gate();
          // Hold at the first yield boundary until cancellation. `signal` is
          // the engine-injected AbortSignal; we throw on abort so the
          // generator's `finally` block runs exactly like a DB cursor cleanup.
          await new Promise<void>((_, reject) => {
            const onAbort = (): void => reject(new Error('aborted'));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          });
          yield { id: 'never' } as Row;
        } finally {
          cleaned = true;
        }
      }
    });

    const handle = ctx.engine.stream({
      id: 'str-cancel',
      frame: { 'default/slowTodos': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    await ready;
    handle.cancel();
    await waitForEnd(frames);
    expect(frames.filter((f) => f.kind === 'chunk')).toHaveLength(0);
    const end = frames[frames.length - 1];
    expect(end?.kind).toBe('end');
    expect((end as unknown as { _meta?: { cancelled?: boolean } })._meta?.cancelled).toBe(true);
    // Cleanup may race with the end frame; give the generator a tick to finish.
    await new Promise<void>((r) => setImmediate(r));
    expect(cleaned).toBe(true);
  });

  it('cancel mid-iteration → resolver sees aborted signal, remaining chunks suppressed', async () => {
    let emitted = 0;
    let cleaned = false;
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((r) => {
      releaseSecond = r;
    });
    ctx.registry.register('midTodos', {
      kind: 'type',
      fields: todoFields(),
      resolver: async function* (_ctx, args) {
        const { signal } = args;
        try {
          yield { id: '1' } as Row;
          emitted++;
          // Block before yielding the second row so the test can cancel after
          // chunk 1 has been delivered. The signal listener rejects the wait.
          await new Promise<void>((resolve, reject) => {
            const onAbort = (): void => reject(new Error('aborted'));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
            void secondGate.then(resolve);
          });
          yield { id: '2' } as Row;
          emitted++;
        } finally {
          cleaned = true;
        }
      }
    });

    const handle = ctx.engine.stream({
      id: 'str-mid',
      frame: { 'default/midTodos': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    await waitForCount(frames, 1);
    expect(frames[0]?.kind).toBe('chunk');
    expect(frames[0]?.sequence).toBe(0);
    handle.cancel();
    // Release the gate too so if cancellation somehow failed we'd notice via
    // a rogue chunk.
    releaseSecond();
    await waitForEnd(frames);
    const chunks = frames.filter((f) => f.kind === 'chunk');
    expect(chunks).toHaveLength(1);
    expect(emitted).toBe(1); // post-yield counter never bumped
    await new Promise<void>((r) => setImmediate(r));
    expect(cleaned).toBe(true);
    expect(
      (frames[frames.length - 1] as unknown as { _meta?: { cancelled?: boolean } })._meta?.cancelled
    ).toBe(true);
  });

  it('external AbortSignal also triggers cancellation', async () => {
    const controller = new AbortController();
    let cleaned = false;
    ctx.registry.register('extTodos', {
      kind: 'type',
      fields: todoFields(),
      resolver: async function* (_ctx, args) {
        const { signal } = args;
        try {
          await new Promise<void>((_, reject) => {
            const onAbort = (): void => reject(new Error('aborted'));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          });
          yield { id: 'unreached' } as Row;
        } finally {
          cleaned = true;
        }
      }
    });
    ctx.engine.stream({
      id: 'str-ext',
      frame: { 'default/extTodos': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      },
      signal: controller.signal
    });
    controller.abort();
    await waitForEnd(frames);
    expect(frames.filter((f) => f.kind === 'chunk')).toHaveLength(0);
    await new Promise<void>((r) => setImmediate(r));
    expect(cleaned).toBe(true);
  });
});

describe('Engine.stream — row-filter obligations (§4.4)', () => {
  let ctx: Ctx;
  let frames: WsResponseFrame[];

  beforeEach(() => {
    ctx = bootstrap();
    frames = [];
  });

  it('row-filter obligation skips rejected rows; surviving rows still emit', async () => {
    const policy = row<{ title?: string }>((_ctx, r) => !(r.title ?? '').startsWith('secret:'));
    ctx.registry.register('filteredTodos', {
      kind: 'type',
      fields: todoFields(),
      policy,
      resolver: async function* () {
        yield { id: 'a', title: 'public' } as Row;
        yield { id: 'b', title: 'secret: hidden' } as Row;
        yield { id: 'c', title: 'also public' } as Row;
      }
    });
    ctx.engine.stream({
      id: 'str-filter',
      frame: { 'default/filteredTodos': { params: {}, fields: { id: true, title: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    await waitForEnd(frames);
    const chunks = frames.filter((f) => f.kind === 'chunk');
    expect(chunks).toHaveLength(2);
    const ids = chunks.map(
      (c) => (c.data as Record<string, { id: string }>)['default/filteredTodos']?.id
    );
    expect(ids).toEqual(['a', 'c']);
    // Filtered rows still consume a sequence slot? Spec: sequence is per
    // emitted chunk. A skipped row does NOT bump the sequence, so 0,1 survive.
    expect(chunks.map((c) => c.sequence)).toEqual([0, 1]);
  });

  it('a row-filter rule that throws drops that row and the stream still ends', async () => {
    const policy = row<{ owner?: { id: string } }>((_ctx, r) => r.owner!.id === 'x');
    ctx.registry.register('ownedTodos', {
      kind: 'type',
      fields: todoFields(),
      policy,
      resolver: async function* () {
        yield { id: 'a', owner: { id: 'x' } } as Row;
        yield { id: 'b' } as Row;
        yield { id: 'c', owner: { id: 'x' } } as Row;
      }
    });
    ctx.engine.stream({
      id: 'str-throw',
      frame: { 'default/ownedTodos': { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });
    await waitForCount(frames, 3);
    const ids = frames
      .filter((f) => f.kind === 'chunk')
      .map((c) => (c.data as Record<string, { id: string }>)['default/ownedTodos']?.id);
    expect(ids).toEqual(['a', 'c']);
    expect(frames.at(-1)?.kind).toBe('end');
  });
});
