/**
 * A row policy sees the whole row on pg even when the caller selects only
 * some fields: selecting away the field a predicate reads must not unhide a row.
 */

import {
  Engine,
  MemoryEdgesStore,
  type NamespaceConfig,
  Registry,
  type Resolver
} from '@mnmal-ai/substrate-core';
import { MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { getResolver, listResolver } from '@mnmal-ai/substrate-sdk';
import type { Policy, RequestContext, Row, WsResponseFrame } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { PgDataset } from '../src/pg-dataset.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'test_row_policy_fields';

const hideSecret: Policy = () => ({
  allow: true,
  obligations: [
    { kind: 'row-filter', predicate: (_ctx: RequestContext, r: Row) => r.secret !== true }
  ]
});

describe.skipIf(!POSTGRES_URL)('row policy under a narrowed field selection (pg)', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    sql = postgres(POSTGRES_URL, { onnotice: () => {} });
    await runMigrations(sql);
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
  });

  afterAll(async () => {
    if (!POSTGRES_URL) return;
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
    await sql.end();
  });

  it('hides a row whose predicate field was not requested', async () => {
    const ds = new PgDataset({ namespace: NS, sql });
    await ds.write('Doc', [
      { id: 'open-1', secret: false },
      { id: 'hidden-1', secret: true }
    ]);
    const registry = new Registry();
    registry.register('Doc', { resolver: listResolver('Doc', ds), policy: hideSecret });
    registry.register('getDoc', { resolver: getResolver('Doc', ds), policy: hideSecret });
    const datasets = new MemoryDatasetRegistry();
    datasets.set(NS, ds);
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([[NS, { registry }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: () => new Date() })
    });

    const env = await engine.query({
      frame: {
        [`${NS}/Doc`]: { params: { limit: 10 }, fields: { id: true } },
        [`${NS}/getDoc`]: { params: { id: 'hidden-1' }, fields: { id: true } }
      },
      ctx: { identity: null }
    });

    expect(env.errors).toBeUndefined();
    expect((env.data[`${NS}/Doc`] as Row[]).map((r) => r.id)).toEqual(['open-1']);
    expect(env.data[`${NS}/getDoc`]).toBeNull();
  });

  /** An engine over pg with list, stream and create entries all under `hideSecret`. */
  async function engineFor(): Promise<Engine> {
    const ds = new PgDataset({ namespace: NS, sql });
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
    await ds.write('Doc', [
      { id: 'open-1', secret: false },
      { id: 'hidden-1', secret: true }
    ]);
    const registry = new Registry();
    registry.register('Doc', { resolver: listResolver('Doc', ds), policy: hideSecret });
    registry.register('streamDoc', {
      resolver: async function* () {
        for (const r of (await ds.read('Doc', {})).rows) yield r;
      },
      policy: hideSecret
    });
    const create: Resolver = async (_ctx, args) => {
      const row = { id: String(args.params?.id), secret: args.params?.secret === true };
      await args.dataset?.write('Doc', [row]);
      args.onWrite?.({ ns: NS, type: 'Doc', id: row.id, operation: 'create', row });
      return row;
    };
    registry.register('createDoc', { kind: 'mutation', resolver: create });
    const datasets = new MemoryDatasetRegistry();
    datasets.set(NS, ds);
    return new Engine({
      namespaces: new Map<string, NamespaceConfig>([[NS, { registry }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: () => new Date() })
    });
  }

  const until = async (frames: WsResponseFrame[], done: (f: WsResponseFrame[]) => boolean) => {
    for (let i = 0; i < 200 && !done(frames); i++) await new Promise((r) => setTimeout(r, 5));
  };

  it('subscribe: hides a row whose predicate field was not requested, in snapshot and live adds', async () => {
    const engine = await engineFor();
    const frames: WsResponseFrame[] = [];
    const handle = await engine.subscribe({
      id: 's1',
      frame: { [`${NS}/Doc`]: { params: {}, fields: { id: true } } },
      ctx: { identity: null },
      onFrame: (f) => void frames.push(f)
    });
    for (const [id, secret] of [
      ['hidden-2', true],
      ['open-2', false]
    ] as const) {
      await engine.mutate({
        frame: { [`${NS}/createDoc`]: { params: { id, secret }, fields: { id: true } } },
        ctx: { identity: null }
      });
    }
    await until(frames, (f) => f.some((x) => x.kind === 'add'));
    handle.cancel();

    const snapshot = frames.find((f) => f.kind === 'snapshot') as { data: Record<string, Row[]> };
    expect(snapshot.data[`${NS}/Doc`]?.map((r) => r.id)).toEqual(['open-1']);
    const adds = frames.filter((f) => f.kind === 'add') as Array<{ data: Record<string, Row> }>;
    expect(adds.map((a) => a.data[`${NS}/Doc`]?.id)).toEqual(['open-2']);
  });

  it('stream: hides a row whose predicate field was not requested', async () => {
    const engine = await engineFor();
    const frames: WsResponseFrame[] = [];
    engine.stream({
      id: 'str1',
      frame: { [`${NS}/streamDoc`]: { params: {}, fields: { id: true } } },
      ctx: { identity: null },
      onFrame: (f) => void frames.push(f)
    });
    await until(frames, (f) => f.some((x) => x.kind === 'end'));

    expect(frames.find((f) => f.kind === 'error')).toBeUndefined();
    expect(JSON.stringify(frames.filter((f) => f.kind === 'chunk'))).toContain('open-1');
    expect(JSON.stringify(frames)).not.toContain('hidden-1');
  });
});
