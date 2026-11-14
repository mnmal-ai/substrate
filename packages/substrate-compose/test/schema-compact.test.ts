import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';

/** A namespace shaped like cortext's Todo: vocab enums with aliases and implies, crossRefs, a list. */
function cortextLike() {
  const ns = 'ctx';
  return defineNamespace(ns, {
    Decision: { fields: { topic: field.string(), choice: field.string() } },
    AgentIdentity: { fields: { kid: field.string() } },
    Todo: {
      fields: {
        title: field.string(),
        area: field.string(),
        status: field.vocab(['open', 'in_progress', 'blocked', 'deferred', 'closed'], {
          aliases: {
            done: 'closed',
            finished: 'closed',
            completed: 'closed',
            shipped: 'closed',
            cancelled: 'closed',
            dropped: 'closed',
            superseded: 'closed',
            not_started: 'open'
          },
          implies: {
            done: { resolution: 'completed' },
            finished: { resolution: 'completed' },
            completed: { resolution: 'completed' },
            shipped: { resolution: 'completed' },
            cancelled: { resolution: 'wont_do' },
            dropped: { resolution: 'wont_do' },
            superseded: { resolution: 'superseded' }
          },
          indexed: true
        }),
        resolution: field.vocab(
          ['completed', 'wont_do', 'superseded', 'duplicate', 'obsolete', 'unspecified'],
          {
            aliases: {
              done: 'completed',
              shipped: 'completed',
              wontfix: 'wont_do',
              declined: 'wont_do',
              dup: 'duplicate',
              moot: 'obsolete'
            },
            nullable: true
          }
        ),
        priority: field.enum(['low', 'medium', 'high']),
        notes: field.string({ nullable: true, indexed: false }),
        blockedBy: field.string({ nullable: true, indexed: false }),
        revisitWhen: field.string({ nullable: true, indexed: false }),
        body: field.string({ nullable: true, indexed: false }),
        tags: field.list(field.string(), { nullable: true, indexed: true }),
        archived: field.boolean({ default: false }),
        targetDate: field.date({ nullable: true }),
        implementsDecision: field.crossRef(ns, 'Decision', {
          nullable: true,
          onDelete: 'set_null'
        }),
        owner: field.crossRef(ns, 'AgentIdentity', { nullable: true, onDelete: 'set_null' }),
        project: field.string({ nullable: true, indexed: true })
      }
    }
  });
}

const TYPE = '/substrate/v1/schema/ctx/Todo';

interface Got {
  status: number;
  body: Record<string, unknown>;
  bytes: number;
}

async function withServer(
  fn: (get: (query?: Record<string, string>) => Promise<Got>) => Promise<void>
): Promise<void> {
  const server = new MemorySubstrateServer();
  const composed = await compose({
    systemActor: 'test',
    server,
    dataset: new MemoryDataset({ namespace: 'ctx' }),
    coordinators: [{ name: 'p', contractVersion: '*', namespaces: [cortextLike()] }]
  });
  await server.start();
  try {
    await fn(async (query = {}) => {
      const res = await server.inject({ method: 'GET', path: TYPE, query, headers: {} });
      const text = String(res.body);
      return { status: res.status, body: JSON.parse(text), bytes: text.length };
    });
  } finally {
    await composed.stop();
  }
}

describe('GET /substrate/v1/schema/:ns/:type — compact by default (#1787)', () => {
  it('names the type in generated CRUD instead of restating the field block', async () => {
    await withServer(async (get) => {
      const { status, body } = await get();
      expect(status).toBe(200);
      const m = body.mutations as Record<string, { params: unknown; returns: unknown }>;
      expect(m.createTodo).toMatchObject({ params: 'Todo fields', returns: 'Todo' });
      expect(m.getTodo).toMatchObject({
        params: { id: { kind: 'scalar', type: 'string' } },
        returns: 'Todo | null'
      });
      expect(m.updateTodo).toMatchObject({
        params: 'id, plus any subset of Todo fields',
        returns: 'Todo | null'
      });
      expect(m.updateManyTodo).toMatchObject({ params: { set: 'any subset of Todo fields' } });
      expect(body.mutationRefs).toEqual(expect.stringContaining("'Todo fields'"));
      // The field block itself is printed once, in full.
      expect((body.fields as Record<string, { aliases?: unknown }>).status?.aliases).toBeDefined();
    });
  });

  it('shape=full keeps the long form for callers that read every signature', async () => {
    await withServer(async (get) => {
      const { body } = await get({ shape: 'full' });
      const m = body.mutations as Record<string, { params: unknown; returns: unknown }>;
      expect(m.createTodo?.params).toEqual(body.fields);
      expect(m.createTodo?.returns).toEqual({ kind: 'struct', fields: body.fields });
      expect(body.mutationRefs).toBeUndefined();
    });
  });

  it('is under a third of the long form for a cortext/Todo-shaped type', async () => {
    await withServer(async (get) => {
      const compact = await get();
      const full = await get({ shape: 'full' });
      // Measured at 4,681 vs 15,843 bytes when this landed.
      expect(compact.bytes * 3).toBeLessThan(full.bytes);
    });
  });
});
