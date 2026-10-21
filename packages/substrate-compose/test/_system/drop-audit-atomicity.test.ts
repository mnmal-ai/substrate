import { MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type {
  Dataset,
  DropParticipant,
  EdgesStore,
  EngineHandle,
  HttpHandler,
  SubstrateRequest,
  TxScopeHandles
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { dropNamespaceRoute, dropTypeRoute } from '../../src/_system/drop.js';
import { AUDIT_EVENT_TYPE, SYSTEM_NAMESPACE } from '../../src/_system/types.js';

const noopEngine = (): EngineHandle =>
  ({ tombstoneNamespace: (): void => {}, dropParticipants: () => [] }) as unknown as EngineHandle;

interface Fault {
  /** When true, every transaction throws after its body returns — a failed commit. */
  commitFails: boolean;
}

/** Memory edges store that advertises a chosen substrate id. */
class TxScopeEdgesStore extends MemoryEdgesStore {
  override readonly txScopeId: string;

  constructor(txScopeId: string) {
    super({ now: () => new Date() });
    this.txScopeId = txScopeId;
  }

  /**
   * Opens a transaction whose handle stages edge drops and applies them only
   * when `fn` resolves, so edge drops made through `this` during the
   * transaction commit independently, as they would on a separate pg
   * connection.
   */
  async stagedTransaction<T>(fn: (tx: EdgesStore) => Promise<T>): Promise<T> {
    const staged: Array<() => Promise<number>> = [];
    const tx = {
      txScopeId: this.txScopeId,
      findEdgesTouchingNamespace: this.findEdgesTouchingNamespace.bind(this),
      findEdgesTouchingType: this.findEdgesTouchingType.bind(this),
      namespacesLinkedTo: this.namespacesLinkedTo.bind(this),
      dropEdgesByNamespace: async (namespace: string, within?: string[]): Promise<number> => {
        staged.push(() => this.dropEdgesByNamespace(namespace, within));
        return (await this.findEdgesTouchingNamespace(namespace, 1000)).length;
      },
      dropEdgesByType: async (
        namespace: string,
        type: string,
        within?: string[]
      ): Promise<number> => {
        staged.push(() => this.dropEdgesByType(namespace, type, within));
        return (await this.findEdgesTouchingType(namespace, type, 1000)).length;
      }
    } as unknown as EdgesStore;
    const result = await fn(tx);
    for (const apply of staged) await apply();
    return result;
  }
}

/**
 * Memory dataset that can stand in for one namespace of a shared substrate.
 * `withScopedTransaction` nests each requested namespace's memory
 * transaction, plus the edges store's when it is on the same substrate, so a
 * throw rolls back all of them. `fault.commitFails` makes both transaction
 * entry points throw after the body completes.
 */
class FaultyDataset extends MemoryDataset {
  readonly #registry: Map<string, FaultyDataset>;
  readonly #fault: Fault;
  readonly #edges: TxScopeEdgesStore;

  constructor(
    namespace: string,
    txScopeId: string,
    registry: Map<string, FaultyDataset>,
    fault: Fault,
    edges: TxScopeEdgesStore
  ) {
    super({ namespace, txScopeId });
    this.#registry = registry;
    this.#fault = fault;
    this.#edges = edges;
    registry.set(namespace, this);
  }

  rawTransaction<T>(fn: (tx: Dataset) => Promise<T>): Promise<T> {
    return super.withTransaction(fn);
  }

  override async withTransaction<T>(fn: (tx: Dataset) => Promise<T>): Promise<T> {
    return super.withTransaction(async (tx) => {
      const result = await fn(tx);
      if (this.#fault.commitFails) throw new Error('commit failed');
      return result;
    });
  }

  async withScopedTransaction<T>(
    namespaces: ReadonlyArray<string>,
    fn: (handles: TxScopeHandles) => Promise<T>
  ): Promise<T> {
    const open = async (i: number, bound: Map<string, Dataset>): Promise<T> => {
      if (i === namespaces.length) {
        const run = async (edges: EdgesStore | null): Promise<T> => {
          const result = await fn({ datasets: bound, edges });
          if (this.#fault.commitFails) throw new Error('commit failed');
          return result;
        };
        return this.#edges.txScopeId === this.txScopeId
          ? this.#edges.stagedTransaction((tx) => run(tx))
          : run(null);
      }
      const ns = namespaces[i]!;
      const ds = this.#registry.get(ns);
      if (ds === undefined || ds.txScopeId !== this.txScopeId) {
        throw new Error(`namespace '${ns}' is not on tx scope '${this.txScopeId}'`);
      }
      return ds.rawTransaction((tx) => open(i + 1, new Map(bound).set(ns, tx)));
    };
    return open(0, new Map());
  }
}

function makeReq(body: unknown): SubstrateRequest {
  return {
    method: 'POST',
    path: '/x',
    headers: {},
    query: {},
    params: {},
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    identity: { kid: 'test-admin', capabilities: ['admin'], namespaces: ['*'] }
  } as unknown as SubstrateRequest;
}

type Layout = 'shared' | 'split';

async function setup(
  layout: Layout,
  route: 'namespace' | 'type'
): Promise<{
  handler: HttpHandler;
  sandbox: FaultyDataset;
  substrate: FaultyDataset;
  edges: TxScopeEdgesStore;
  fault: Fault;
}> {
  const fault: Fault = { commitFails: false };
  const registry = new Map<string, FaultyDataset>();
  const shared = layout === 'shared';
  const edges = new TxScopeEdgesStore(shared ? 'mem:sandbox' : 'mem:edges');
  const sandbox = new FaultyDataset('sandbox', 'mem:sandbox', registry, fault, edges);
  const substrate = new FaultyDataset(
    SYSTEM_NAMESPACE,
    shared ? 'mem:sandbox' : 'mem:substrate',
    registry,
    fault,
    edges
  );
  await sandbox.write('Foo', [{ id: '1' }, { id: '2' }]);
  await edges.write({
    from: { ns: 'sandbox', type: 'Foo', id: '1' },
    to: { ns: 'other', type: 'Bar', id: '9' },
    fieldName: 'ref',
    policy: 'cascade'
  });
  const deps = {
    resolveDataset: (ns: string): Dataset | null => registry.get(ns) ?? null,
    edges,
    now: () => new Date('2026-10-01T12:00:00Z'),
    trustedProxies: [] as string[]
  };
  const handler =
    route === 'namespace'
      ? dropNamespaceRoute({ ...deps, engine: noopEngine() })
      : dropTypeRoute(deps);
  return { handler, sandbox, substrate, edges, fault };
}

async function edgeCount(edges: EdgesStore): Promise<number> {
  return (await edges.findEdgesTouchingNamespace('sandbox', 100)).length;
}

function bodyFor(route: 'namespace' | 'type', extra: Record<string, unknown> = {}): unknown {
  return route === 'namespace'
    ? { namespace: 'sandbox', confirm: 'sandbox', ...extra }
    : { namespace: 'sandbox', type: 'Foo', confirm: 'sandbox/Foo', ...extra };
}

async function auditKinds(substrate: Dataset): Promise<string[]> {
  const res = await substrate.read(AUDIT_EVENT_TYPE, {});
  return res.rows.map((r) => (r as unknown as { kind: string }).kind);
}

const kindFor = { namespace: 'namespace_dropped', type: 'type_dropped' } as const;

describe.each(['namespace', 'type'] as const)('drop %s route: audit atomicity', (route) => {
  describe.each(['shared', 'split'] as const)('%s tx scope', (layout) => {
    it('a failed drop commit leaves no audit row and no deleted rows', async () => {
      const { handler, sandbox, substrate, fault } = await setup(layout, route);
      fault.commitFails = true;
      await expect(handler(makeReq(bodyFor(route, { cascade: 'delete' })))).rejects.toThrow(
        'commit failed'
      );
      fault.commitFails = false;

      expect((await sandbox.read('Foo', {})).rows).toHaveLength(2);
      expect(await auditKinds(substrate)).not.toContain(kindFor[route]);
    });

    it('a failed drop commit with cascade=delete leaves the edges in place', async () => {
      const { handler, edges, fault } = await setup(layout, route);
      fault.commitFails = true;
      await expect(handler(makeReq(bodyFor(route, { cascade: 'delete' })))).rejects.toThrow(
        'commit failed'
      );
      fault.commitFails = false;

      expect(await edgeCount(edges)).toBe(1);
    });

    it('a committed cascade=delete drop removes the edges and audits their count', async () => {
      const { handler, sandbox, substrate, edges } = await setup(layout, route);
      const res = await handler(makeReq(bodyFor(route, { cascade: 'delete' })));
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body!.toString('utf8'))).toMatchObject({ edgesDeleted: 1 });

      expect((await sandbox.read('Foo', {})).rows).toHaveLength(0);
      expect(await edgeCount(edges)).toBe(0);
      const audit = (await substrate.read(AUDIT_EVENT_TYPE, {})).rows.find(
        (r) => (r as unknown as { kind: string }).kind === kindFor[route]
      );
      expect(audit).toMatchObject({ details: { edgesDeleted: 1 } });
    });

    it('dryRun with cascade=delete reports the edge count but deletes no edges', async () => {
      const { handler, edges } = await setup(layout, route);
      const res = await handler(makeReq(bodyFor(route, { cascade: 'delete', dryRun: true })));
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body!.toString('utf8'))).toMatchObject({ edgesDeleted: 1 });

      expect(await edgeCount(edges)).toBe(1);
    });

    it('a committed drop writes exactly one audit row', async () => {
      const { handler, sandbox, substrate } = await setup(layout, route);
      const res = await handler(makeReq(bodyFor(route, { cascade: 'delete' })));
      expect(res.status).toBe(200);

      expect((await sandbox.read('Foo', {})).rows).toHaveLength(0);
      expect((await auditKinds(substrate)).filter((k) => k === kindFor[route])).toHaveLength(1);
    });

    it('dryRun leaves no audit row and no deleted rows', async () => {
      const { handler, sandbox, substrate } = await setup(layout, route);
      const res = await handler(makeReq(bodyFor(route, { cascade: 'delete', dryRun: true })));
      expect(res.status).toBe(200);

      expect((await sandbox.read('Foo', {})).rows).toHaveLength(2);
      expect(await auditKinds(substrate)).not.toContain(kindFor[route]);
    });
  });
});

describe('drop namespace route: drop participants share the drop transaction', () => {
  async function withParticipant(onDrop: DropParticipant['onDrop']) {
    const fault: Fault = { commitFails: false };
    const registry = new Map<string, FaultyDataset>();
    const edges = new TxScopeEdgesStore('mem:s');
    const sandbox = new FaultyDataset('sandbox', 'mem:s', registry, fault, edges);
    new FaultyDataset(SYSTEM_NAMESPACE, 'mem:s', registry, fault, edges);
    const control = new FaultyDataset('control', 'mem:s', registry, fault, edges);
    await sandbox.write('Foo', [{ id: '1' }]);
    const participant: DropParticipant = { namespaces: ['control'], onDrop };
    const handler = dropNamespaceRoute({
      resolveDataset: (ns: string): Dataset | null => registry.get(ns) ?? null,
      edges,
      now: () => new Date('2026-10-01T12:00:00Z'),
      trustedProxies: [],
      engine: {
        tombstoneNamespace: (): void => {},
        dropParticipants: () => [participant]
      } as unknown as EngineHandle
    });
    return { handler, sandbox, control };
  }

  it("commits a participant's write with the drop", async () => {
    const { handler, control } = await withParticipant(async (ns, datasetFor) => {
      await datasetFor('control').write('Retired', [{ id: ns }]);
    });
    expect((await handler(makeReq(bodyFor('namespace')))).status).toBe(200);
    expect((await control.read('Retired', {})).rows).toHaveLength(1);
  });

  it('a participant that throws rolls the drop back', async () => {
    const { handler, sandbox, control } = await withParticipant(async (_ns, datasetFor) => {
      await datasetFor('control').write('Retired', [{ id: 'x' }]);
      throw new Error('participant failed');
    });
    await expect(handler(makeReq(bodyFor('namespace')))).rejects.toThrow('participant failed');
    expect((await sandbox.read('Foo', {})).rows).toHaveLength(1);
    expect((await control.read('Retired', {})).rows).toHaveLength(0);
  });

  it('without a shared transaction, a failing participant is a warning and the namespace is still tombstoned', async () => {
    const fault: Fault = { commitFails: false };
    const registry = new Map<string, FaultyDataset>();
    const edges = new TxScopeEdgesStore('mem:e');
    const sandbox = new FaultyDataset('sandbox', 'mem:s', registry, fault, edges);
    new FaultyDataset(SYSTEM_NAMESPACE, 'mem:sys', registry, fault, edges);
    new FaultyDataset('control', 'mem:c', registry, fault, edges);
    await sandbox.write('Foo', [{ id: '1' }]);
    const tombstoned: string[] = [];
    const participant: DropParticipant = {
      namespaces: ['control'],
      onDrop: async () => {
        throw new Error('participant failed');
      }
    };
    const handler = dropNamespaceRoute({
      resolveDataset: (ns: string): Dataset | null => registry.get(ns) ?? null,
      edges,
      now: () => new Date('2026-10-01T12:00:00Z'),
      trustedProxies: [],
      engine: {
        tombstoneNamespace: (ns: string): void => {
          tombstoned.push(ns);
        },
        dropParticipants: () => [participant]
      } as unknown as EngineHandle
    });
    const res = await handler(makeReq(bodyFor('namespace')));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!.toString('utf8')).warnings).toEqual([
      expect.stringMatching(/participant failed/)
    ]);
    expect(tombstoned).toEqual(['sandbox']);
    expect((await sandbox.read('Foo', {})).rows).toHaveLength(0);
  });
});
