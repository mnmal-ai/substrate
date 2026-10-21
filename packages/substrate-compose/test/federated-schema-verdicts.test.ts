import type { Engine } from '@mnmal-ai/substrate-core';
import type { Schema } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { federatedSchemaRoute } from '../src/routes/federated-schema.js';

/**
 * `GET /substrate/v1/federated-schema` joins `_system/EnumCheckVerdict` rows under
 * `_enumVerdicts`, best-effort: the key is omitted whenever the verdicts cannot
 * be read, because absent is UNKNOWN, never "unverified".
 */

function stubSchema(ns: string): Schema {
  return { schemaVersion: `v-${ns}`, types: {}, mutations: {} };
}

const VERDICT_ROW = {
  namespace: 'journal',
  type: 'Todo',
  field: 'status',
  vocabHash: 'abc',
  checkedAt: '2026-09-11T00:00:00.000Z',
  rowsScanned: 10,
  outlierCount: 0,
  truncated: false
};

/** Engine serving a verdict row (or a refusal) for the verdict frame only. */
function engineWith(opts: { verdicts?: unknown[]; refuse?: boolean }): Engine {
  return {
    federatedSchema(): Record<string, Schema> {
      return { journal: stubSchema('journal') };
    },
    query: async (_input: { frame: Record<string, unknown> }) => {
      if (opts.refuse === true) {
        return { data: {}, errors: [{ code: 'policy_denied', message: 'nope' }] };
      }
      return {
        data: { '_system/EnumCheckVerdict': opts.verdicts ?? [] },
        errors: []
      };
    }
  } as unknown as Engine;
}

const REQ = {
  method: 'GET',
  path: '/substrate/v1/federated-schema',
  headers: {},
  query: {},
  params: {},
  body: null
} as const;

describe('GET /substrate/v1/federated-schema + _enumVerdicts', () => {
  it('attaches per-field verdicts keyed ns/type.field when readable', async () => {
    const res = await federatedSchemaRoute(engineWith({ verdicts: [VERDICT_ROW] }))({ ...REQ });
    expect(res.status).toBe(200);
    const body = JSON.parse(String(res.body)) as Record<string, unknown>;
    expect(body.journal).toBeDefined();
    expect(body._enumVerdicts).toEqual({
      'journal/Todo.status': {
        checkedAt: '2026-09-11T00:00:00.000Z',
        vocabHash: 'abc',
        rowsScanned: 10,
        outlierCount: 0,
        truncated: false
      }
    });
  });

  it('omits the key — schema intact — when the verdict frame is refused', async () => {
    // An anonymous caller (or one without _system read) gets the schema as
    // before. Rendering every enum suspect for lack of a grant would invert
    // the field's meaning.
    const res = await federatedSchemaRoute(engineWith({ refuse: true }))({ ...REQ });
    expect(res.status).toBe(200);
    const body = JSON.parse(String(res.body)) as Record<string, unknown>;
    expect(body.journal).toBeDefined();
    expect('_enumVerdicts' in body).toBe(false);
  });

  it('skips malformed verdict rows rather than failing the schema read', async () => {
    const res = await federatedSchemaRoute(engineWith({ verdicts: [{ nope: 1 }, VERDICT_ROW] }))({
      ...REQ
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(String(res.body)) as {
      _enumVerdicts: Record<string, unknown>;
    };
    expect(Object.keys(body._enumVerdicts)).toEqual(['journal/Todo.status']);
  });
});

describe('the verdict probe runs only for a caller that can read _system', () => {
  // The engine records every refused frame in /substrate/v1/errors, so probing on behalf of a caller
  // that is certain to be refused logged one error per fresh non-admin client.
  function spyEngine(): { engine: Engine; calls: () => number } {
    let n = 0;
    const engine = {
      federatedSchema: () => ({ journal: stubSchema('journal') }),
      query: async () => {
        n += 1;
        return { data: { '_system/EnumCheckVerdict': [VERDICT_ROW] }, errors: [] };
      }
    } as unknown as Engine;
    return { engine, calls: () => n };
  }
  const as = (grants: Record<string, string[]>) => ({
    ...REQ,
    identity: { id: 'x', grants }
  });

  it('skips the probe for an identity whose grant gives no read on _system', async () => {
    const { engine, calls } = spyEngine();
    const res = await federatedSchemaRoute(engine)(as({ journal: ['read'] }) as never);
    const body = JSON.parse(String(res.body)) as Record<string, unknown>;
    expect(calls()).toBe(0);
    expect(body.journal).toBeDefined();
    expect('_enumVerdicts' in body).toBe(false);
  });

  it('skips it when an explicit _system entry is narrower than read, even under a wildcard', async () => {
    const { engine, calls } = spyEngine();
    await federatedSchemaRoute(engine)(as({ '*': ['read'], _system: [] }) as never);
    expect(calls()).toBe(0);
  });

  it('probes for an identity that can read _system, explicitly or by wildcard', async () => {
    for (const grants of [{ _system: ['read', 'admin'] }, { '*': ['read'] }]) {
      const { engine, calls } = spyEngine();
      const res = await federatedSchemaRoute(engine)(as(grants) as never);
      expect(calls()).toBe(1);
      expect('_enumVerdicts' in (JSON.parse(String(res.body)) as object)).toBe(true);
    }
  });
});
