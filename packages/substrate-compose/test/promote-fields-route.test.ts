/**
 * The promotion sweep's server side, over a dataset that scripts its answers:
 * `POST /substrate/v1/_system/promote-fields` is admin-gated and runs one
 * sweep; each promoted or failed field is written as an `_system/AuditEvent`
 * and announced to subscribers (a busy one is not); `/health` carries the
 * dataset's field warnings; the scoped schema route marks a pending field;
 * the timer runs the sweep; and `stop()` aborts a running sweep and waits
 * for it.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  CoordinatorPlugin,
  PromotionEvent,
  SubstrateResponse,
  TypeStorageReport
} from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { signHs256 } from '../src/auth.js';
import { type ComposeResult, compose } from '../src/compose.js';

const SECRET = 'promote-fields-secret';
const NS = 'pfr';

const plugin: CoordinatorPlugin = {
  name: 'pfr-fixture',
  contractVersion: '*',
  namespaces: [
    defineNamespace(NS, { Note: { fields: { title: field.string(), rank: field.number() } } })
  ]
};

const EVENTS: PromotionEvent[] = [
  { kind: 'promoted', namespace: NS, type: 'Note', field: 'rank', attempts: 1 },
  { kind: 'busy', namespace: NS, type: 'Note', field: 'size', attempts: 1 },
  {
    kind: 'failed',
    namespace: NS,
    type: 'Note',
    field: 'code',
    attempts: 3,
    error: 'unique index note_code refuses a duplicate value of code'
  }
];

/** A dataset whose sweep answers `EVENTS`, or waits for its signal when `hold` is set. */
class SweepingDataset extends MemoryDataset {
  calls: Array<{
    lockTimeoutMs: number;
    batchRows: number;
    signal?: AbortSignal;
    retryConflicts?: boolean;
  }> = [];
  hold = false;
  warnings: () => Promise<string[]> = async () => [
    '1 field pending promotion — see the storage report'
  ];

  async promotePendingFields(opts: {
    lockTimeoutMs: number;
    batchRows: number;
    signal?: AbortSignal;
    retryConflicts?: boolean;
  }): Promise<PromotionEvent[]> {
    this.calls.push(opts);
    if (!this.hold) return EVENTS;
    await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve()));
    return [];
  }

  fieldWarnings(): Promise<string[]> {
    return this.warnings();
  }

  async describeStorage(): Promise<TypeStorageReport> {
    return {
      layout: 'tables',
      table: 't__pfr__note',
      indexes: [],
      pending: ['rank'],
      orphaned: []
    };
  }
}

const json = (res: SubstrateResponse) => JSON.parse(String(res.body)) as Record<string, unknown>;

let composed: ComposeResult | null = null;
afterEach(async () => {
  await composed?.stop();
  composed = null;
});

async function boot(dataset: SweepingDataset, intervalMs = 0) {
  const server = new MemorySubstrateServer();
  composed = await compose({
    server,
    dataset,
    datasets: { [NS]: dataset },
    coordinators: [plugin],
    auth: { keys: [{ kid: 'file', alg: 'HS256', publicKey: SECRET }], adminCapability: 'admin' },
    streamTicketSecret: 'promote-fields-ticket',
    promoteFields: { intervalMs }
  });
  const token = (capabilities: string[], ns: string[] = ['*']) =>
    signHs256({ sub: 'op', exp: Math.floor(Date.now() / 1000) + 120, capabilities, ns }, SECRET, {
      kid: 'file'
    });
  const post = (capabilities: string[], ns?: string[]) =>
    server.inject({
      method: 'POST',
      path: '/substrate/v1/_system/promote-fields',
      headers: { authorization: `Bearer ${token(capabilities, ns)}` }
    });
  const get = (path: string) =>
    server.inject({
      method: 'GET',
      path,
      headers: { authorization: `Bearer ${token(['read'])}` }
    });
  return { app: composed, post, get };
}

/** Subscribes to `_system/AuditEvent` and collects each pushed row's `kind` and `details`. */
async function auditSubscriber(app: ComposeResult) {
  const seen: Array<Record<string, unknown>> = [];
  await app.engine.subscribe({
    id: 'audit',
    frame: {
      '_system/AuditEvent': {
        params: {},
        fields: { id: true, kind: true, actorKid: true, details: true }
      }
    },
    ctx: {
      identity: { id: 'op', tokenId: 'op', grants: { '*': ['admin', 'read'] } }
    } as never,
    onFrame: (f: { kind: string; data?: unknown }) => {
      if (f.kind === 'add') {
        seen.push((f.data as Record<string, Record<string, unknown>>)['_system/AuditEvent'] ?? {});
      }
    }
  });
  return seen;
}

const until = async (check: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
};

describe('POST /substrate/v1/_system/promote-fields', () => {
  it('needs admin', async () => {
    const dataset = new SweepingDataset({ namespace: 'default' });
    const { post } = await boot(dataset);
    expect((await post(['read', 'mutate'])).status).toBe(403);
    expect(dataset.calls).toHaveLength(0);
  });

  it('needs admin held store-wide: an admin of one namespace is refused, a * admin runs it', async () => {
    const dataset = new SweepingDataset({ namespace: 'default' });
    const { post } = await boot(dataset);
    const scoped = await post(['admin', 'read'], [NS]);
    expect(scoped.status).toBe(403);
    expect(json(scoped)).toEqual({ code: 'forbidden', required: '*:admin' });
    expect(dataset.calls).toHaveLength(0);
    expect((await post(['admin'], ['*'])).status).toBe(200);
    expect(dataset.calls).toHaveLength(1);
  });

  it('runs one sweep and answers its events; promoted and failed are audited and announced, busy is not', async () => {
    const dataset = new SweepingDataset({ namespace: 'default' });
    const { app, post } = await boot(dataset);
    const seen = await auditSubscriber(app);
    const res = await post(['admin']);
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({ events: EVENTS });
    // The operator's run also retries fields a unique conflict holds back.
    expect(dataset.calls[0]).toMatchObject({
      lockTimeoutMs: 2000,
      batchRows: 1000,
      retryConflicts: true
    });
    expect(dataset.calls[0]?.signal).toBeInstanceOf(AbortSignal);

    await until(() => seen.length >= 2);
    expect(seen.map((r) => [r.kind, r.actorKid, r.details])).toEqual([
      ['field_promoted', 'system', { namespace: NS, type: 'Note', field: 'rank', attempts: 1 }],
      [
        'field_promotion_failed',
        'system',
        {
          namespace: NS,
          type: 'Note',
          field: 'code',
          attempts: 3,
          error: 'unique index note_code refuses a duplicate value of code'
        }
      ]
    ]);
    const stored = await app.datasets.get('_system')?.read('AuditEvent', {
      where: { kind: { in: ['field_promoted', 'field_promotion_failed', 'field_pending'] } }
    });
    expect(stored?.rows).toHaveLength(2);
  });

  it('the timer runs the sweep every intervalMs', async () => {
    const dataset = new SweepingDataset({ namespace: 'default' });
    await boot(dataset, 20);
    await until(() => dataset.calls.length >= 2);
    expect(dataset.calls.length).toBeGreaterThanOrEqual(2);
    // The timed sweep leaves a unique conflict for its type's catalog to change.
    expect(dataset.calls.every((c) => c.retryConflicts === undefined)).toBe(true);
  });

  it('stop() aborts a running sweep and waits for it', async () => {
    const dataset = new SweepingDataset({ namespace: 'default' });
    dataset.hold = true;
    const { app, post } = await boot(dataset);
    const running = post(['admin']);
    await until(() => dataset.calls.length === 1);
    await app.stop();
    composed = null;
    expect(dataset.calls[0]?.signal?.aborted).toBe(true);
    expect((await running).status).toBe(200);
  });
});

describe('field warnings and pending fields on the read surfaces', () => {
  it('/health carries the field warnings and stays ok; a failing catalog leaves them out', async () => {
    const dataset = new SweepingDataset({ namespace: 'default' });
    const { get } = await boot(dataset);
    const body = json(await get('/health'));
    expect(body.status).toBe('ok');
    expect(body.warnings).toEqual(['1 field pending promotion — see the storage report']);
    dataset.warnings = async () => {
      throw new Error('catalog down');
    };
    expect(json(await get('/health'))).toMatchObject({ status: 'ok', warnings: [] });
  });

  it("the scoped schema route marks a pending field storage: 'pending' and no other", async () => {
    const dataset = new SweepingDataset({ namespace: 'default' });
    const { get } = await boot(dataset);
    const body = json(await get(`/substrate/v1/schema/${NS}/Note`));
    const fields = body.fields as Record<string, Record<string, unknown>>;
    expect(fields.rank?.storage).toBe('pending');
    expect(fields.title).not.toHaveProperty('storage');
    expect((body.storage as TypeStorageReport).orphaned).toEqual([]);
  });
});
