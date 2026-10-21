import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type {
  FieldDef,
  HttpHandler,
  Schema,
  SubstrateRequest,
  SubstrateResponse
} from '@mnmal-ai/substrate-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { backfillFieldRoute } from '../../src/_system/backfill-field.js';
import { AUDIT_EVENT_TYPE, SYSTEM_NAMESPACE } from '../../src/_system/types.js';

const resolution: FieldDef = {
  kind: 'scalar',
  type: 'string',
  indexed: true,
  nullable: true,
  enum: ['completed', 'wont_do', 'superseded'],
  aliases: { shipped: 'completed' }
};
const schema: Schema = {
  schemaVersion: 'v',
  mutations: {},
  types: {
    Todo: {
      fields: {
        resolution,
        title: { kind: 'scalar', type: 'string', indexed: true },
        shortId: { kind: 'scalar', type: 'number', indexed: true, readonly: true }
      }
    }
  }
};

function req(body: unknown): SubstrateRequest {
  return {
    method: 'POST',
    path: '/substrate/v1/_system/backfill-field',
    headers: {},
    query: {},
    params: {},
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    identity: { kid: 'test-admin', capabilities: ['admin'], namespaces: ['*'] }
  } as unknown as SubstrateRequest;
}
const json = (res: SubstrateResponse) =>
  JSON.parse(res.body!.toString('utf8')) as Record<string, unknown>;

describe('backfillFieldRoute', () => {
  let ns: MemoryDataset;
  let substrate: MemoryDataset;
  let handler: HttpHandler;
  const past = new Date('2026-01-01T00:00:00Z');
  const base = { namespace: 'journal', type: 'Todo', field: 'resolution' };
  const meta = async (id: string) =>
    (await ns.read('Todo', { id })).rows[0]?._metadata as { updatedAt?: string } | undefined;

  beforeEach(async () => {
    ns = new MemoryDataset({ namespace: 'journal' });
    substrate = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    await ns.write(
      'Todo',
      [
        { id: 'a', title: 'ship it' },
        { id: 'b', title: 'drop it' },
        { id: 'c', title: 'already set', resolution: 'superseded' }
      ],
      { identity: { kind: 'agent', id: 'seed' }, now: past }
    );
    handler = backfillFieldRoute({
      resolveDataset: (n) => (n === 'journal' ? ns : n === SYSTEM_NAMESPACE ? substrate : null),
      schemaFor: (n) => (n === 'journal' ? schema : null),
      now: () => new Date('2026-10-03T12:00:00Z'),
      trustedProxies: []
    });
  });

  it('dry-runs by default: counts, missing ids and kept values, nothing written', async () => {
    const res = await handler(
      req({ ...base, values: { a: 'shipped', b: 'wont_do', c: 'completed', zz: 'completed' } })
    );
    expect(res.status).toBe(200);
    expect(json(res)).toMatchObject({
      applied: false,
      write: 2,
      counts: { completed: 1, wont_do: 1 },
      missing: ['zz'],
      kept: 1
    });
    expect((await ns.read('Todo', { id: 'a' })).rows[0]?.resolution).toBeUndefined();
  });

  it('applies canonical values, never clobbers by default, preserves updatedAt, and audits', async () => {
    const before = await meta('a');
    const res = await handler(
      req({ ...base, apply: true, values: { a: 'shipped', b: 'wont_do', c: 'completed' } })
    );
    expect(json(res)).toMatchObject({ applied: true, write: 2, kept: 1 });
    const rows = (await ns.read('Todo', { ids: ['a', 'b', 'c'] })).rows;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.resolution]))).toEqual({
      a: 'completed',
      b: 'wont_do',
      c: 'superseded'
    });
    expect((await meta('a'))?.updatedAt).toBe(before?.updatedAt);
    const audit = (await substrate.read(AUDIT_EVENT_TYPE, {})).rows;
    expect(audit.map((r) => r.kind)).toEqual(['field_backfilled']);
    expect(audit[0]?.details).toMatchObject({ ids: ['a', 'b'], idsTruncated: false });
  });

  it('refuses _system, whose keys and audit trail it would otherwise rewrite', async () => {
    const res = await handler(
      req({
        namespace: SYSTEM_NAMESPACE,
        type: 'Key',
        field: 'revokedAt',
        values: { k1: null },
        apply: true,
        overwrite: true
      })
    );
    expect(res.status).toBe(403);
    expect(json(res)).toMatchObject({ code: 'forbidden_namespace' });
  });

  it('overwrite: true replaces an existing value', async () => {
    await handler(req({ ...base, apply: true, overwrite: true, values: { c: 'completed' } }));
    expect((await ns.read('Todo', { id: 'c' })).rows[0]?.resolution).toBe('completed');
  });

  it('refuses the whole request when any value is outside the vocabulary', async () => {
    const res = await handler(req({ ...base, apply: true, values: { a: 'completed', b: 'nope' } }));
    expect(res.status).toBe(400);
    expect(json(res)).toMatchObject({ code: 'invalid_values' });
    expect((await ns.read('Todo', { id: 'a' })).rows[0]?.resolution).toBeUndefined();
  });

  it('refuses a readonly field', async () => {
    const res = await handler(req({ ...base, field: 'shortId', values: { a: 1 } }));
    expect(json(res)).toMatchObject({ code: 'not_backfillable' });
  });
});
