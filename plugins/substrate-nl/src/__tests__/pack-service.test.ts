import type { Query, Schema, SubstrateRequest } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { NlEngineAccess, NlEnvelope } from '../access.js';
import { PackService } from '../pack/service.js';
import { OPERATORS, s } from './_fixture.js';

const SCHEMA: Schema = {
  schemaVersion: 'v1',
  mutations: {},
  types: { Todo: { fields: { title: s(), project: s() } } },
  annotations: { nl: { liveStatus: { Todo: 'open' } } }
};
const ROWS = [
  { id: '1', title: 'a', project: 'substrate' },
  { id: '2', title: 'b', project: 'secret' }
];
const req = (id: string | null, grants: Record<string, string[]> = {}): SubstrateRequest => {
  const base: SubstrateRequest = {
    method: 'GET',
    path: '/substrate/v1/nl/pack/ns',
    headers: {},
    query: {},
    params: { ns: 'ns' },
    body: null
  };
  if (id !== null) base.identity = { id, grants };
  return base;
};

/** Row policy: principal `restricted` never sees project `secret`. */
function engine(schema = SCHEMA): NlEngineAccess & { calls: number } {
  const e = {
    calls: 0,
    federatedSchema: () => ({ ns: schema }),
    operators: () => OPERATORS,
    async query(frame: Query, r: SubstrateRequest): Promise<NlEnvelope> {
      e.calls++;
      const key = Object.keys(frame)[0] as string;
      const rows =
        r.identity?.id === 'restricted' ? ROWS.filter((x) => x.project !== 'secret') : ROWS;
      return { data: { [key]: rows } };
    }
  };
  return e;
}

describe('PackService', () => {
  it('builds a pack with rulings and an etag; undefined for an unknown namespace', async () => {
    const svc = new PackService({ engine: engine() });
    const got = await svc.get('ns', req('a'));
    expect(got?.pack.namespace).toBe('ns');
    expect(got?.pack.rulings).toEqual({ liveStatus: { Todo: 'open' } });
    expect(got?.etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(await svc.get('nope', req('a'))).toBeUndefined();
  });

  it('profiles under the caller: a restricted principal never sees hidden values', async () => {
    const svc = new PackService({ engine: engine() });
    const full = await svc.get('ns', req('admin'));
    const narrow = await svc.get('ns', req('restricted'));
    expect(full?.pack.values.secret).toBeDefined();
    expect(narrow?.pack.values.secret).toBeUndefined();
    expect(narrow?.etag).not.toBe(full?.etag);
  });

  it('caches per (namespace, schemaVersion, principal) until the TTL lapses', async () => {
    let t = 0;
    const e = engine();
    const svc = new PackService({ engine: e, ttlMs: 1000, now: () => t });
    await svc.get('ns', req('a'));
    const after1 = e.calls;
    await svc.get('ns', req('a'));
    expect(e.calls).toBe(after1); // cached
    await svc.get('ns', req(null)); // anonymous is its own principal
    expect(e.calls).toBeGreaterThan(after1);
    const after2 = e.calls;
    t = 1001;
    await svc.get('ns', req('a'));
    expect(e.calls).toBeGreaterThan(after2); // expired
  });

  it('a new schemaVersion is a new entry', async () => {
    let schema = SCHEMA;
    const e = { ...engine(), federatedSchema: () => ({ ns: schema }) };
    const svc = new PackService({ engine: e });
    const a = await svc.get('ns', req('a'));
    schema = { ...SCHEMA, schemaVersion: 'v2' };
    const b = await svc.get('ns', req('a'));
    expect(b?.pack.schemaVersion).toBe('v2');
    expect(b?.etag).not.toBe(a?.etag);
  });

  it('surfaces invalid declared rulings as a warning and logs once per schemaVersion', async () => {
    const log = vi.fn();
    const bad = { ...SCHEMA, annotations: { nl: { liveStatus: 'open' } } };
    const svc = new PackService({ engine: engine(bad), log });
    const got = await svc.get('ns', req('a'));
    await svc.get('ns', req('b'));
    expect(got?.pack.warnings[0]).toMatch(/invalid/);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('applies the operator override over declared rulings', async () => {
    const svc = new PackService({
      engine: engine(),
      rulings: { ns: { fieldAliases: { repo: 'project' } } }
    });
    const got = await svc.get('ns', req('a'));
    expect(got?.pack.rulings).toEqual({
      liveStatus: { Todo: 'open' },
      fieldAliases: { repo: 'project' }
    });
  });

  it('keys the cache on grants as well as id', async () => {
    const e = engine();
    const svc = new PackService({ engine: e });
    await svc.get('ns', req('a', { ns: ['read'], '*': ['x'] }));
    const n = e.calls;
    await svc.get('ns', req('a', { '*': ['x'], ns: ['read'] })); // same grants, key order differs
    expect(e.calls).toBe(n);
    await svc.get('ns', req('a', { ns: [] })); // narrowed
    expect(e.calls).toBeGreaterThan(n);
  });

  it('keys the cache on every identity claim, not just id and grants', async () => {
    const e = engine();
    const svc = new PackService({ engine: e });
    const tenant = (t: string): SubstrateRequest => {
      const r = req('a');
      r.identity = { id: 'a', grants: {}, tenant: t };
      return r;
    };
    await svc.get('ns', tenant('t1'));
    const n = e.calls;
    await svc.get('ns', tenant('t2'));
    expect(e.calls).toBeGreaterThan(n);
  });

  it('two tokens differing only in expiry share a pack', async () => {
    const e = engine();
    const svc = new PackService({ engine: e });
    const token = (exp: number): SubstrateRequest => {
      const r = req('a');
      r.identity = { id: 'a', grants: { ns: ['read'] }, tokenId: 'a', expiresAt: exp };
      return r;
    };
    await svc.get('ns', token(1000));
    const n = e.calls;
    await svc.get('ns', token(2000));
    expect(e.calls).toBe(n);
  });

  it('evicts the least-recently-used entry past maxEntries', async () => {
    const e = engine();
    const svc = new PackService({ engine: e, maxEntries: 2 });
    await svc.get('ns', req('a'));
    await svc.get('ns', req('b'));
    await svc.get('ns', req('a')); // refresh a; b is now LRU
    await svc.get('ns', req('c')); // evicts b
    const n = e.calls;
    await svc.get('ns', req('a'));
    expect(e.calls).toBe(n);
    await svc.get('ns', req('b'));
    expect(e.calls).toBeGreaterThan(n);
  });

  it('coalesces concurrent misses into one build', async () => {
    const e = engine();
    const svc = new PackService({ engine: e });
    await Promise.all([svc.get('ns', req('a')), svc.get('ns', req('a'))]);
    expect(e.calls).toBe(1); // one type, one page, one build
  });

  it('does not cache a rejected build and retries next time', async () => {
    const e = engine();
    let fail = true;
    const inner = e.query;
    e.query = async (f, r) => {
      if (fail) throw new Error('boom');
      return inner(f, r);
    };
    const svc = new PackService({ engine: e });
    await expect(Promise.all([svc.get('ns', req('a')), svc.get('ns', req('a'))])).rejects.toThrow(
      'boom'
    );
    fail = false;
    expect((await svc.get('ns', req('a')))?.pack.namespace).toBe('ns');
  });
});
