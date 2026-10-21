import { MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type {
  EngineHandle,
  HttpHandler,
  SubstrateRequest,
  SubstrateResponse
} from '@mnmal-ai/substrate-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { dropNamespaceRoute, dropTypeRoute } from '../../src/_system/drop.js';
import { AUDIT_EVENT_TYPE, SYSTEM_NAMESPACE } from '../../src/_system/types.js';
import { useEnvSnapshot } from '../_env-override.js';

const noopEngine = (): EngineHandle =>
  ({ tombstoneNamespace: (): void => {}, dropParticipants: () => [] }) as unknown as EngineHandle;

function makeReq(path: string, body: unknown): SubstrateRequest {
  return {
    method: 'POST',
    path,
    headers: {},
    query: {},
    params: {},
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    identity: { kid: 'test-admin', capabilities: ['admin'], namespaces: ['*'] }
  } as unknown as SubstrateRequest;
}

async function readJson(res: SubstrateResponse): Promise<Record<string, unknown>> {
  return JSON.parse(res.body!.toString('utf8'));
}

describe('dropNamespaceRoute', () => {
  let sandbox: MemoryDataset;
  let substrate: MemoryDataset;
  let edges: MemoryEdgesStore;
  let handler: HttpHandler;

  beforeEach(async () => {
    sandbox = new MemoryDataset({ namespace: 'sandbox' });
    substrate = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    edges = new MemoryEdgesStore({ now: () => new Date() });
    await sandbox.write('Foo', [{ id: '1' }, { id: '2' }]);
    handler = dropNamespaceRoute({
      resolveDataset: (ns) =>
        ns === 'sandbox' ? sandbox : ns === SYSTEM_NAMESPACE ? substrate : null,
      edges,
      now: () => new Date('2026-04-23T12:00:00Z'),
      trustedProxies: [],
      engine: noopEngine()
    });
  });

  it('drops every row in the namespace and emits an audit event', async () => {
    const res = await handler(makeReq('/x', { namespace: 'sandbox', confirm: 'sandbox' }));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toMatchObject({
      namespace: 'sandbox',
      dryRun: false,
      cascade: 'refuse',
      rowsDeleted: 2,
      edgesDeleted: 0
    });
    expect(body.auditEventId).toMatch(/^[0-9a-f-]{36}$/);
    const foos = await sandbox.read('Foo', {});
    expect(foos.rows).toHaveLength(0);

    // Audit event persisted
    const audits = await substrate.read(AUDIT_EVENT_TYPE, {});
    expect(audits.rows.length).toBeGreaterThan(0);
    const event = audits.rows.find(
      (r) => (r as unknown as { kind: string }).kind === 'namespace_dropped'
    );
    expect(event).toBeDefined();
  });

  it('namespace_dropped audit row carries _metadata.createdBy = agent/<actor kid>', async () => {
    // The audit row's `_metadata.createdBy` must carry the actor that issued
    // the drop: `makeReq` sets `identity.kid = 'test-admin'`.
    const res = await handler(makeReq('/x', { namespace: 'sandbox', confirm: 'sandbox' }));
    expect(res.status).toBe(200);

    const audits = await substrate.read(AUDIT_EVENT_TYPE, {});
    const event = audits.rows.find(
      (r) => (r as unknown as { kind: string }).kind === 'namespace_dropped'
    );
    expect(event).toBeDefined();
    const meta = (
      event as unknown as { _metadata?: { createdBy?: { kind: string; id: string } | null } }
    )._metadata;
    expect(meta?.createdBy).toEqual({ kind: 'agent', id: 'test-admin' });
  });

  it('dryRun=true reports counts but mutates nothing and emits no audit', async () => {
    const res = await handler(
      makeReq('/x', { namespace: 'sandbox', confirm: 'sandbox', dryRun: true })
    );
    const body = await readJson(res);
    expect(body).toMatchObject({ dryRun: true, rowsDeleted: 2 });
    const foos = await sandbox.read('Foo', {});
    expect(foos.rows).toHaveLength(2);
    const audits = await substrate.read(AUDIT_EVENT_TYPE, {});
    expect(
      audits.rows.filter((r) => (r as unknown as { kind: string }).kind === 'namespace_dropped')
    ).toHaveLength(0);
  });

  it('rejects with confirm_mismatch when confirm does not match namespace', async () => {
    const res = await handler(makeReq('/x', { namespace: 'sandbox', confirm: 'wrong' }));
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('confirm_mismatch');
  });

  it('rejects with forbidden_namespace when dropping _system', async () => {
    const res = await handler(
      makeReq('/x', { namespace: SYSTEM_NAMESPACE, confirm: SYSTEM_NAMESPACE })
    );
    expect(res.status).toBe(403);
    expect((await readJson(res)).code).toBe('forbidden_namespace');
  });

  it('rejects with unknown_namespace when ns does not resolve', async () => {
    const res = await handler(makeReq('/x', { namespace: 'nope', confirm: 'nope' }));
    expect(res.status).toBe(404);
    expect((await readJson(res)).code).toBe('unknown_namespace');
  });

  it('refuses with 409 when cascade=refuse and dangling edges exist', async () => {
    await edges.write({
      from: { ns: 'sandbox', type: 'Foo', id: '1' },
      to: { ns: 'other', type: 'Bar', id: '9' },
      fieldName: 'ref',
      policy: 'cascade'
    });
    const res = await handler(makeReq('/x', { namespace: 'sandbox', confirm: 'sandbox' }));
    expect(res.status).toBe(409);
    const body = await readJson(res);
    expect(body).toMatchObject({ code: 'dangling_edges', edgeCount: 1 });
    expect(Array.isArray(body.sampleEdges)).toBe(true);
    const foos = await sandbox.read('Foo', {});
    expect(foos.rows).toHaveLength(2);
  });

  it('cascade=delete drops edges + rows and counts both', async () => {
    await edges.write({
      from: { ns: 'sandbox', type: 'Foo', id: '1' },
      to: { ns: 'other', type: 'Bar', id: '9' },
      fieldName: 'ref',
      policy: 'cascade'
    });
    const res = await handler(
      makeReq('/x', { namespace: 'sandbox', confirm: 'sandbox', cascade: 'delete' })
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toMatchObject({ rowsDeleted: 2, edgesDeleted: 1, cascade: 'delete' });
  });

  it('needs admin in every namespace a cascade reaches, and reports only readable edges', async () => {
    await edges.write({
      from: { ns: 'sandbox', type: 'Foo', id: '1' },
      to: { ns: 'other', type: 'Bar', id: '9' },
      fieldName: 'ref',
      policy: 'cascade'
    });
    const scoped = dropNamespaceRoute({
      resolveDataset: (ns) =>
        ns === 'sandbox' ? sandbox : ns === SYSTEM_NAMESPACE ? substrate : null,
      edges,
      now: () => new Date('2026-04-23T12:00:00Z'),
      trustedProxies: [],
      engine: noopEngine(),
      holds: (_req, ns) => ns === 'sandbox'
    });
    const del = await scoped(
      makeReq('/x', { namespace: 'sandbox', confirm: 'sandbox', cascade: 'delete' })
    );
    expect(del.status).toBe(403);
    const denied = await readJson(del);
    expect(denied.code).toBe('forbidden');
    expect(JSON.stringify(denied)).not.toContain('other');
    expect((await edges.findEdgesTouchingNamespace('sandbox', 10)).length).toBe(1);
    expect((await sandbox.read('Foo', {})).rows).toHaveLength(2);

    const refuse = await scoped(makeReq('/x', { namespace: 'sandbox', confirm: 'sandbox' }));
    expect(refuse.status).toBe(409);
    expect(await readJson(refuse)).toMatchObject({ edgeCount: 0, sampleEdges: [] });
  });

  it('refuses a cascade reaching an edge written while the rows were being dropped', async () => {
    const dropRows = sandbox.dropNamespace.bind(sandbox);
    sandbox.dropNamespace = async () => {
      await edges.write({
        from: { ns: 'intruder', type: 'Baz', id: '5' },
        to: { ns: 'sandbox', type: 'Foo', id: '2' },
        fieldName: 'ref',
        policy: 'cascade'
      });
      return dropRows();
    };
    const scoped = dropNamespaceRoute({
      resolveDataset: (ns) =>
        ns === 'sandbox' ? sandbox : ns === SYSTEM_NAMESPACE ? substrate : null,
      edges,
      now: () => new Date('2026-04-23T12:00:00Z'),
      trustedProxies: [],
      engine: noopEngine(),
      holds: (_req, ns) => ns !== 'intruder'
    });
    const res = await scoped(
      makeReq('/x', { namespace: 'sandbox', confirm: 'sandbox', cascade: 'delete' })
    );
    expect(res.status).toBe(403);
    expect((await sandbox.read('Foo', {})).rows).toHaveLength(2);
  });

  it('leaves an edge from an unchecked namespace that appears after the check', async () => {
    await edges.write({
      from: { ns: 'sandbox', type: 'Foo', id: '1' },
      to: { ns: 'other', type: 'Bar', id: '9' },
      fieldName: 'ref',
      policy: 'cascade'
    });
    const checked = edges.namespacesLinkedTo.bind(edges);
    edges.namespacesLinkedTo = async (ns, type) => {
      const linked = await checked(ns, type);
      await edges.write({
        from: { ns: 'intruder', type: 'Baz', id: '5' },
        to: { ns: 'sandbox', type: 'Foo', id: '2' },
        fieldName: 'ref',
        policy: 'cascade'
      });
      return linked;
    };
    const scoped = dropNamespaceRoute({
      resolveDataset: (ns) =>
        ns === 'sandbox' ? sandbox : ns === SYSTEM_NAMESPACE ? substrate : null,
      edges,
      now: () => new Date('2026-04-23T12:00:00Z'),
      trustedProxies: [],
      engine: noopEngine(),
      holds: (_req, ns) => ns !== 'intruder'
    });
    const res = await scoped(
      makeReq('/x', { namespace: 'sandbox', confirm: 'sandbox', cascade: 'delete' })
    );
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ edgesDeleted: 1 });
    const left = await edges.findEdgesTouchingNamespace('sandbox', 10);
    expect(left.map((e) => e.from.ns)).toEqual(['intruder']);
  });

  it('rejects unknown cascade values with 400 invalid_cascade', async () => {
    const res = await handler(
      makeReq('/x', { namespace: 'sandbox', confirm: 'sandbox', cascade: 'set_null' })
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('invalid_cascade');
  });

  it('rejects invalid JSON body with 400 invalid_body', async () => {
    const req = {
      method: 'POST',
      path: '/x',
      headers: {},
      query: {},
      params: {},
      body: Buffer.from('not json', 'utf8'),
      identity: { kid: 'a', capabilities: ['admin'], namespaces: ['*'] }
    } as unknown as SubstrateRequest;
    const res = await handler(req);
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('invalid_body');
  });

  it('tombstones the namespace on the engine after a real drop', async () => {
    const tombstoned: string[] = [];
    const engineStub = {
      dropParticipants: () => [],
      tombstoneNamespace: (ns: string): void => {
        tombstoned.push(ns);
      }
    } as unknown as EngineHandle;

    const handlerWithEngine = dropNamespaceRoute({
      resolveDataset: (ns) =>
        ns === 'sandbox' ? sandbox : ns === SYSTEM_NAMESPACE ? substrate : null,
      edges,
      now: () => new Date('2026-04-23T12:00:00Z'),
      trustedProxies: [],
      engine: engineStub
    });

    const res = await handlerWithEngine(
      makeReq('/x', { namespace: 'sandbox', confirm: 'sandbox' })
    );
    expect(res.status).toBe(200);
    expect(tombstoned).toEqual(['sandbox']);
  });

  it('does NOT tombstone on dry-run (transaction rolls back, nothing was deleted)', async () => {
    const tombstoned: string[] = [];
    const engineStub = {
      dropParticipants: () => [],
      tombstoneNamespace: (ns: string): void => {
        tombstoned.push(ns);
      }
    } as unknown as EngineHandle;

    const handlerWithEngine = dropNamespaceRoute({
      resolveDataset: (ns) =>
        ns === 'sandbox' ? sandbox : ns === SYSTEM_NAMESPACE ? substrate : null,
      edges,
      now: () => new Date(),
      trustedProxies: [],
      engine: engineStub
    });

    const res = await handlerWithEngine(
      makeReq('/x', { namespace: 'sandbox', confirm: 'sandbox', dryRun: true })
    );
    expect(res.status).toBe(200);
    expect(tombstoned).toEqual([]);
  });
});

describe('dropTypeRoute', () => {
  let sandbox: MemoryDataset;
  let substrate: MemoryDataset;
  let edges: MemoryEdgesStore;
  let handler: HttpHandler;

  beforeEach(async () => {
    sandbox = new MemoryDataset({ namespace: 'sandbox' });
    substrate = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    edges = new MemoryEdgesStore({ now: () => new Date() });
    await sandbox.write('Foo', [{ id: '1' }]);
    await sandbox.write('Bar', [{ id: '99' }]);
    handler = dropTypeRoute({
      resolveDataset: (ns) =>
        ns === 'sandbox' ? sandbox : ns === SYSTEM_NAMESPACE ? substrate : null,
      edges,
      now: () => new Date('2026-04-23T12:00:00Z'),
      trustedProxies: []
    });
  });

  it('drops one type, leaves others intact, confirm = "<ns>/<type>"', async () => {
    const res = await handler(
      makeReq('/x', {
        namespace: 'sandbox',
        type: 'Foo',
        confirm: 'sandbox/Foo'
      })
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toMatchObject({ namespace: 'sandbox', type: 'Foo', rowsDeleted: 1 });
    const bars = await sandbox.read('Bar', {});
    expect(bars.rows).toHaveLength(1);
  });

  it('type_dropped audit row carries _metadata.createdBy = agent/<actor kid>', async () => {
    // The audit row's `_metadata.createdBy` must carry the actor that issued
    // the drop: `makeReq` sets `identity.kid = 'test-admin'`.
    const res = await handler(
      makeReq('/x', {
        namespace: 'sandbox',
        type: 'Foo',
        confirm: 'sandbox/Foo'
      })
    );
    expect(res.status).toBe(200);

    const audits = await substrate.read(AUDIT_EVENT_TYPE, {});
    const event = audits.rows.find(
      (r) => (r as unknown as { kind: string }).kind === 'type_dropped'
    );
    expect(event).toBeDefined();
    const meta = (
      event as unknown as { _metadata?: { createdBy?: { kind: string; id: string } | null } }
    )._metadata;
    expect(meta?.createdBy).toEqual({ kind: 'agent', id: 'test-admin' });
  });

  it('rejects confirm mismatch', async () => {
    const res = await handler(
      makeReq('/x', {
        namespace: 'sandbox',
        type: 'Foo',
        confirm: 'sandbox'
      })
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('confirm_mismatch');
  });
});

describe('dropNamespaceRoute under SUBSTRATE_HARD_DELETE=refuse', () => {
  useEnvSnapshot('SUBSTRATE_HARD_DELETE');
  let sandbox: MemoryDataset;
  let substrate: MemoryDataset;
  let edges: MemoryEdgesStore;
  let handler: HttpHandler;

  beforeEach(async () => {
    process.env.SUBSTRATE_HARD_DELETE = 'refuse';
    sandbox = new MemoryDataset({ namespace: 'sandbox' });
    substrate = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    edges = new MemoryEdgesStore({ now: () => new Date() });
    await sandbox.write('Foo', [{ id: '1' }, { id: '2' }]);
    handler = dropNamespaceRoute({
      resolveDataset: (ns) =>
        ns === 'sandbox' ? sandbox : ns === SYSTEM_NAMESPACE ? substrate : null,
      edges,
      now: () => new Date('2026-04-27T12:00:00Z'),
      trustedProxies: [],
      engine: noopEngine()
    });
  });

  it('refuses with 403 destructive_ops_disabled and writes destructive_op_refused audit row', async () => {
    const res = await handler(makeReq('/x', { namespace: 'sandbox', confirm: 'sandbox' }));
    expect(res.status).toBe(403);
    expect(await readJson(res)).toMatchObject({ code: 'destructive_ops_disabled' });

    // No rows were dropped — gate fired before any state mutation
    const foos = await sandbox.read('Foo', {});
    expect(foos.rows).toHaveLength(2);

    const audits = await substrate.read(AUDIT_EVENT_TYPE, {});
    const refused = audits.rows.find(
      (r) => (r as unknown as { kind: string }).kind === 'destructive_op_refused'
    );
    expect(refused).toBeDefined();
    expect(refused).toMatchObject({
      actorKid: 'test-admin',
      targetKid: 'sandbox',
      kind: 'destructive_op_refused',
      details: { surface: 'drop_namespace', cascade: 'refuse', dryRun: false }
    });
  });

  it('refusal audit row carries _metadata.createdBy = agent/<actor kid>', async () => {
    const res = await handler(makeReq('/x', { namespace: 'sandbox', confirm: 'sandbox' }));
    expect(res.status).toBe(403);

    const audits = await substrate.read(AUDIT_EVENT_TYPE, {});
    const refused = audits.rows.find(
      (r) => (r as unknown as { kind: string }).kind === 'destructive_op_refused'
    );
    expect(refused).toBeDefined();
    const meta = (
      refused as unknown as { _metadata?: { createdBy?: { kind: string; id: string } | null } }
    )._metadata;
    expect(meta?.createdBy).toEqual({ kind: 'agent', id: 'test-admin' });
  });

  it('confirm_mismatch still returns 400 (kill switch fires after param validation)', async () => {
    const res = await handler(makeReq('/x', { namespace: 'sandbox', confirm: 'wrong' }));
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('confirm_mismatch');
    // No refused audit row should have been emitted
    const audits = await substrate.read(AUDIT_EVENT_TYPE, {});
    expect(
      audits.rows.filter(
        (r) => (r as unknown as { kind: string }).kind === 'destructive_op_refused'
      )
    ).toHaveLength(0);
  });

  it('forbidden_namespace still returns 403 forbidden_namespace (kill switch deferred)', async () => {
    const res = await handler(
      makeReq('/x', { namespace: SYSTEM_NAMESPACE, confirm: SYSTEM_NAMESPACE })
    );
    expect(res.status).toBe(403);
    expect((await readJson(res)).code).toBe('forbidden_namespace');
    const audits = await substrate.read(AUDIT_EVENT_TYPE, {});
    expect(
      audits.rows.filter(
        (r) => (r as unknown as { kind: string }).kind === 'destructive_op_refused'
      )
    ).toHaveLength(0);
  });
});

describe('dropTypeRoute under SUBSTRATE_HARD_DELETE=refuse', () => {
  useEnvSnapshot('SUBSTRATE_HARD_DELETE');
  let sandbox: MemoryDataset;
  let substrate: MemoryDataset;
  let edges: MemoryEdgesStore;
  let handler: HttpHandler;

  beforeEach(async () => {
    process.env.SUBSTRATE_HARD_DELETE = 'refuse';
    sandbox = new MemoryDataset({ namespace: 'sandbox' });
    substrate = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    edges = new MemoryEdgesStore({ now: () => new Date() });
    await sandbox.write('Foo', [{ id: '1' }]);
    await sandbox.write('Bar', [{ id: '99' }]);
    handler = dropTypeRoute({
      resolveDataset: (ns) =>
        ns === 'sandbox' ? sandbox : ns === SYSTEM_NAMESPACE ? substrate : null,
      edges,
      now: () => new Date('2026-04-27T12:00:00Z'),
      trustedProxies: []
    });
  });

  it('refuses with 403 destructive_ops_disabled and writes destructive_op_refused audit row', async () => {
    const res = await handler(
      makeReq('/x', { namespace: 'sandbox', type: 'Foo', confirm: 'sandbox/Foo' })
    );
    expect(res.status).toBe(403);
    expect(await readJson(res)).toMatchObject({ code: 'destructive_ops_disabled' });

    // No rows were dropped — gate fired before any state mutation
    const foos = await sandbox.read('Foo', {});
    expect(foos.rows).toHaveLength(1);
    const bars = await sandbox.read('Bar', {});
    expect(bars.rows).toHaveLength(1);

    const audits = await substrate.read(AUDIT_EVENT_TYPE, {});
    const refused = audits.rows.find(
      (r) => (r as unknown as { kind: string }).kind === 'destructive_op_refused'
    );
    expect(refused).toBeDefined();
    expect(refused).toMatchObject({
      actorKid: 'test-admin',
      targetKid: 'sandbox/Foo',
      kind: 'destructive_op_refused',
      details: {
        surface: 'drop_type',
        namespace: 'sandbox',
        type: 'Foo',
        cascade: 'refuse',
        dryRun: false
      }
    });
  });

  it('refusal audit row carries _metadata.createdBy = agent/<actor kid>', async () => {
    const res = await handler(
      makeReq('/x', { namespace: 'sandbox', type: 'Foo', confirm: 'sandbox/Foo' })
    );
    expect(res.status).toBe(403);

    const audits = await substrate.read(AUDIT_EVENT_TYPE, {});
    const refused = audits.rows.find(
      (r) => (r as unknown as { kind: string }).kind === 'destructive_op_refused'
    );
    expect(refused).toBeDefined();
    const meta = (
      refused as unknown as { _metadata?: { createdBy?: { kind: string; id: string } | null } }
    )._metadata;
    expect(meta?.createdBy).toEqual({ kind: 'agent', id: 'test-admin' });
  });

  it('confirm_mismatch still returns 400 (kill switch fires after param validation)', async () => {
    const res = await handler(
      makeReq('/x', { namespace: 'sandbox', type: 'Foo', confirm: 'sandbox' })
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).code).toBe('confirm_mismatch');
    const audits = await substrate.read(AUDIT_EVENT_TYPE, {});
    expect(
      audits.rows.filter(
        (r) => (r as unknown as { kind: string }).kind === 'destructive_op_refused'
      )
    ).toHaveLength(0);
  });
});
