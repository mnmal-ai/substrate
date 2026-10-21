import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type {
  FieldDef,
  HttpHandler,
  Row,
  Schema,
  SubstrateRequest,
  SubstrateResponse
} from '@mnmal-ai/substrate-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { normaliseVocabRoute } from '../../src/_system/normalise-vocab.js';
import { AUDIT_EVENT_TYPE, SYSTEM_NAMESPACE } from '../../src/_system/types.js';

const status: FieldDef = {
  kind: 'scalar',
  type: 'string',
  indexed: true,
  enum: ['open', 'active', 'superseded'],
  aliases: { accepted: 'active', decided: 'active' }
};
const loose: FieldDef = {
  kind: 'scalar',
  type: 'string',
  indexed: true,
  enum: ['must', 'should'],
  aliases: { required: 'must' },
  strict: false
};
const schema: Schema = {
  schemaVersion: 'v',
  mutations: {},
  types: {
    Decision: { fields: { status, severity: loose, title: { kind: 'scalar', type: 'string' } } }
  }
};

function req(body: unknown): SubstrateRequest {
  return {
    method: 'POST',
    path: '/substrate/v1/_system/normalise-vocab',
    headers: {},
    query: {},
    params: {},
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    identity: { kid: 'test-admin', capabilities: ['admin'], namespaces: ['*'] }
  } as unknown as SubstrateRequest;
}
const json = (res: SubstrateResponse) =>
  JSON.parse(res.body!.toString('utf8')) as Record<string, unknown>;

describe('normaliseVocabRoute', () => {
  let ns: MemoryDataset;
  let substrate: MemoryDataset;
  let handler: HttpHandler;
  const past = new Date('2026-01-01T00:00:00Z');

  beforeEach(async () => {
    ns = new MemoryDataset({ namespace: 'journal' });
    substrate = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const rows: Row[] = [
      { id: 'a', status: 'active', severity: 'must' },
      { id: 'b', status: 'accepted', severity: 'required' },
      { id: 'c', status: 'accepted', severity: 'whatever' },
      { id: 'd', status: 'Decided', severity: 'should' },
      { id: 'e', status: 'weird', severity: 'must' }
    ];
    await ns.write('Decision', rows, { identity: { kind: 'agent', id: 'seed' }, now: past });
    handler = normaliseVocabRoute({
      resolveDataset: (n) => (n === 'journal' ? ns : n === SYSTEM_NAMESPACE ? substrate : null),
      schemaFor: (n) => (n === 'journal' ? schema : null),
      now: () => new Date('2026-10-03T12:00:00Z'),
      trustedProxies: []
    });
  });

  const statusOf = async (id: string) => (await ns.read('Decision', { id })).rows[0]?.status;

  it('plans a dry run from the alias table without writing', async () => {
    const res = await handler(req({ namespace: 'journal', type: 'Decision', field: 'status' }));
    expect(res.status).toBe(200);
    expect(json(res)).toMatchObject({
      applied: false,
      field: 'status',
      plan: [
        { from: 'Decided', to: 'active', count: 1 },
        { from: 'accepted', to: 'active', count: 2 }
      ],
      unmapped: [{ value: 'weird', count: 1 }]
    });
    expect(await statusOf('b')).toBe('accepted');
  });

  it('refuses to apply while a value is unmapped, naming it', async () => {
    const res = await handler(
      req({ namespace: 'journal', type: 'Decision', field: 'status', apply: true })
    );
    expect(res.status).toBe(409);
    expect(json(res)).toMatchObject({
      code: 'unmapped_values',
      unmapped: [{ value: 'weird', count: 1 }]
    });
    expect(await statusOf('b')).toBe('accepted');
  });

  it('applies when unmapped values are explicitly rejected, preserving updatedAt, and audits', async () => {
    const before = (await ns.read('Decision', { id: 'b' })).rows[0]?._metadata as
      | { updatedAt?: string }
      | undefined;
    const res = await handler(
      req({
        namespace: 'journal',
        type: 'Decision',
        field: 'status',
        apply: true,
        reject: ['weird']
      })
    );
    expect(res.status).toBe(200);
    expect(json(res)).toMatchObject({
      applied: true,
      migrated: [
        { from: 'Decided', to: 'active', count: 1 },
        { from: 'accepted', to: 'active', count: 2 }
      ],
      stranded: [{ value: 'weird', count: 1 }]
    });
    expect(await statusOf('b')).toBe('active');
    expect(await statusOf('d')).toBe('active');
    expect(await statusOf('e')).toBe('weird');
    const after = (await ns.read('Decision', { id: 'b' })).rows[0]?._metadata as
      | { updatedAt?: string }
      | undefined;
    expect(after?.updatedAt).toBe(before?.updatedAt);
    const audit = (await substrate.read(AUDIT_EVENT_TYPE, {})).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ kind: 'vocab_normalised', actorKid: 'test-admin' });
    expect(audit[0]?.details).toMatchObject({ ids: expect.arrayContaining(['b', 'c', 'd']) });
  });

  it('refuses _system', async () => {
    const res = await handler(
      req({ namespace: SYSTEM_NAMESPACE, type: 'AuditEvent', field: 'kind', apply: true })
    );
    expect(res.status).toBe(403);
    expect(json(res)).toMatchObject({ code: 'forbidden_namespace' });
  });

  it('on a non-strict field, rewrites aliases but leaves unknown values alone', async () => {
    const res = await handler(
      req({ namespace: 'journal', type: 'Decision', field: 'severity', apply: true })
    );
    expect(res.status).toBe(200);
    expect(json(res)).toMatchObject({
      migrated: [{ from: 'required', to: 'must', count: 1 }],
      unmapped: []
    });
    expect((await ns.read('Decision', { id: 'c' })).rows[0]?.severity).toBe('whatever');
  });

  it('refuses a field with no vocabulary, an unknown namespace, and missing params', async () => {
    expect(
      (await handler(req({ namespace: 'journal', type: 'Decision', field: 'title' }))).status
    ).toBe(400);
    expect(
      (await handler(req({ namespace: 'nope', type: 'Decision', field: 'status' }))).status
    ).toBe(404);
    expect((await handler(req({ namespace: 'journal' }))).status).toBe(400);
  });
});
