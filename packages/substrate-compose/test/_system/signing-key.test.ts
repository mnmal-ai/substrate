import type { EngineInput, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import {
  createSigningKeyResolver,
  type KeyRecord,
  type KeyRegistry,
  type SigningKeyMetric
} from '../../src/_system/index.js';

function makeRegistry(records: Map<string, KeyRecord>): KeyRegistry {
  return {
    lookup(kid) {
      return records.get(kid) ?? null;
    },
    install: () => true,
    refresh: async () => {},
    evict: () => {},
    primeFromDataset: async () => {},
    dispose: () => {}
  };
}

const liveRecord: KeyRecord = {
  kid: 'live-kid',
  algorithm: 'EdDSA',
  publicKey: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----',
  namespaces: ['home', 'home-admin'],
  capabilities: ['read', 'write'],
  revokedAt: null
};

function makeArgs(where: Record<string, unknown> | undefined): EngineInput {
  return {
    params: where === undefined ? {} : { where: where as never },
    fields: { id: true, publicKey: true, algorithm: true }
  } as unknown as EngineInput;
}

describe('createSigningKeyResolver', () => {
  it('returns one row containing id/publicKey/algorithm for a live kid', async () => {
    const registry = makeRegistry(new Map([['live-kid', liveRecord]]));
    const resolver = createSigningKeyResolver(registry);
    const result = (await resolver({} as never, makeArgs({ id: { eq: 'live-kid' } }))) as Row[];
    expect(result).toEqual([
      {
        id: 'live-kid',
        publicKey: liveRecord.publicKey,
        algorithm: 'EdDSA'
      }
    ]);
  });

  it('does not leak namespaces, capabilities, or revokedAt', async () => {
    const registry = makeRegistry(new Map([['live-kid', liveRecord]]));
    const resolver = createSigningKeyResolver(registry);
    const result = (await resolver({} as never, makeArgs({ id: { eq: 'live-kid' } }))) as Row[];
    const row = result[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(['algorithm', 'id', 'publicKey']);
    expect('namespaces' in row).toBe(false);
    expect('capabilities' in row).toBe(false);
    expect('revokedAt' in row).toBe(false);
  });

  it('returns [] when the kid is missing from the registry', async () => {
    const registry = makeRegistry(new Map());
    const resolver = createSigningKeyResolver(registry);
    const result = await resolver({} as never, makeArgs({ id: { eq: 'unknown-kid' } }));
    expect(result).toEqual([]);
  });

  it('returns [] when the registry filters the kid as revoked', async () => {
    // The registry's own lookup() honours revokedAt and returns null for
    // revoked rows — we just need to confirm the resolver passes that null
    // straight through as an empty list.
    const registry = makeRegistry(new Map());
    const resolver = createSigningKeyResolver(registry);
    const result = await resolver({} as never, makeArgs({ id: { eq: 'revoked-kid' } }));
    expect(result).toEqual([]);
  });

  it('works when ctx.identity is null (the whole point of this type)', async () => {
    const registry = makeRegistry(new Map([['live-kid', liveRecord]]));
    const resolver = createSigningKeyResolver(registry);
    const ctxWithNullIdentity = { identity: null } as never;
    const result = (await resolver(
      ctxWithNullIdentity,
      makeArgs({ id: { eq: 'live-kid' } })
    )) as Row[];
    expect(result).toHaveLength(1);
    expect((result[0] as { id: string }).id).toBe('live-kid');
  });

  it('returns [] when no where clause is supplied', async () => {
    const registry = makeRegistry(new Map([['live-kid', liveRecord]]));
    const resolver = createSigningKeyResolver(registry);
    const result = await resolver({} as never, makeArgs(undefined));
    expect(result).toEqual([]);
  });

  it('returns [] when where targets a field other than id', async () => {
    const registry = makeRegistry(new Map([['live-kid', liveRecord]]));
    const resolver = createSigningKeyResolver(registry);
    const result = await resolver(
      {} as never,
      makeArgs({ publicKey: { eq: liveRecord.publicKey } })
    );
    expect(result).toEqual([]);
  });

  it('returns [] when where.id uses an operator other than eq', async () => {
    const registry = makeRegistry(new Map([['live-kid', liveRecord]]));
    const resolver = createSigningKeyResolver(registry);
    const result = await resolver({} as never, makeArgs({ id: { in: ['live-kid', 'other-kid'] } }));
    expect(result).toEqual([]);
  });

  it('returns [] when where.id.eq is not a non-empty string', async () => {
    const registry = makeRegistry(new Map([['live-kid', liveRecord]]));
    const resolver = createSigningKeyResolver(registry);
    expect(await resolver({} as never, makeArgs({ id: { eq: '' } }))).toEqual([]);
    expect(await resolver({} as never, makeArgs({ id: { eq: 123 as never } }))).toEqual([]);
  });
});

describe('createSigningKeyResolver — unsupported where shapes', () => {
  it('returns [] and emits metric with reason=compound for AND predicates', async () => {
    const registry = makeRegistry(new Map([['live-kid', liveRecord]]));
    const metric = vi.fn<SigningKeyMetric>();
    const resolver = createSigningKeyResolver(registry, { onMetric: metric });
    const result = await resolver(
      {} as never,
      makeArgs({ AND: [{ id: { eq: 'live-kid' } }] } as never)
    );
    expect(result).toEqual([]);
    expect(metric).toHaveBeenCalledOnce();
    expect(metric).toHaveBeenCalledWith('engine_signing_key_unsupported_where', {
      reason: 'compound'
    });
  });

  it('returns [] and emits metric with reason=compound for OR predicates', async () => {
    const registry = makeRegistry(new Map([['live-kid', liveRecord]]));
    const metric = vi.fn<SigningKeyMetric>();
    const resolver = createSigningKeyResolver(registry, { onMetric: metric });
    const result = await resolver(
      {} as never,
      makeArgs({ OR: [{ id: { eq: 'live-kid' } }] } as never)
    );
    expect(result).toEqual([]);
    expect(metric).toHaveBeenCalledOnce();
    expect(metric).toHaveBeenCalledWith('engine_signing_key_unsupported_where', {
      reason: 'compound'
    });
  });

  it('returns [] and emits metric with reason=compound for NOT predicates', async () => {
    const registry = makeRegistry(new Map([['live-kid', liveRecord]]));
    const metric = vi.fn<SigningKeyMetric>();
    const resolver = createSigningKeyResolver(registry, { onMetric: metric });
    const result = await resolver(
      {} as never,
      makeArgs({ NOT: { id: { eq: 'live-kid' } } } as never)
    );
    expect(result).toEqual([]);
    expect(metric).toHaveBeenCalledOnce();
    expect(metric).toHaveBeenCalledWith('engine_signing_key_unsupported_where', {
      reason: 'compound'
    });
  });

  it('returns [] and emits metric with reason=extra_fields when where has extra keys alongside id', async () => {
    const registry = makeRegistry(new Map([['live-kid', liveRecord]]));
    const metric = vi.fn<SigningKeyMetric>();
    const resolver = createSigningKeyResolver(registry, { onMetric: metric });
    // A caller who adds defence-in-depth filters e.g. revokedAt: { eq: null }
    // believes they are filtering but the resolver cannot honour it.
    const result = await resolver(
      {} as never,
      makeArgs({ id: { eq: 'live-kid' }, revokedAt: { eq: null } } as never)
    );
    expect(result).toEqual([]);
    expect(metric).toHaveBeenCalledOnce();
    expect(metric).toHaveBeenCalledWith('engine_signing_key_unsupported_where', {
      reason: 'extra_fields',
      keys: expect.arrayContaining(['id', 'revokedAt'])
    });
  });

  it('returns [] and emits metric with reason=extra_fields for where with only non-id key', async () => {
    const registry = makeRegistry(new Map([['live-kid', liveRecord]]));
    const metric = vi.fn<SigningKeyMetric>();
    const resolver = createSigningKeyResolver(registry, { onMetric: metric });
    const result = await resolver({} as never, makeArgs({ algorithm: { eq: 'EdDSA' } } as never));
    expect(result).toEqual([]);
    expect(metric).toHaveBeenCalledOnce();
    expect(metric).toHaveBeenCalledWith('engine_signing_key_unsupported_where', {
      reason: 'extra_fields',
      keys: ['algorithm']
    });
  });

  it('does not emit metric for a well-formed id.eq where clause', async () => {
    const registry = makeRegistry(new Map([['live-kid', liveRecord]]));
    const metric = vi.fn<SigningKeyMetric>();
    const resolver = createSigningKeyResolver(registry, { onMetric: metric });
    const result = (await resolver({} as never, makeArgs({ id: { eq: 'live-kid' } }))) as Row[];
    expect(result).toHaveLength(1);
    expect(metric).not.toHaveBeenCalled();
  });

  it('does not emit metric when where is undefined', async () => {
    const registry = makeRegistry(new Map([['live-kid', liveRecord]]));
    const metric = vi.fn<SigningKeyMetric>();
    const resolver = createSigningKeyResolver(registry, { onMetric: metric });
    const result = await resolver({} as never, makeArgs(undefined));
    expect(result).toEqual([]);
    expect(metric).not.toHaveBeenCalled();
  });

  it('works without onMetric option (does not throw for unsupported shapes)', async () => {
    const registry = makeRegistry(new Map([['live-kid', liveRecord]]));
    const resolver = createSigningKeyResolver(registry); // no opts
    const result = await resolver(
      {} as never,
      makeArgs({ AND: [{ id: { eq: 'live-kid' } }] } as never)
    );
    expect(result).toEqual([]);
  });
});
