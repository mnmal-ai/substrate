import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingsStore } from '../src/embeddings-store.js';
import { handleSalienceBoost, validateBoostInput } from '../src/salience-boost-core.js';

const target = { namespace: 'claude', type: 'Memory', id: 'm1' };

function makeBoostStore(boostSalience: EmbeddingsStore['boostSalience']): EmbeddingsStore {
  return {
    txScopeId: 'test-store',
    delete: async () => undefined,
    upsert: async () => undefined,
    knnSearch: async () => [],
    boostSalience,
    fetchEmbeddings: async () => [],
    selectCandidates: async () => []
  };
}

describe('validateBoostInput', () => {
  it('accepts targets + bump', () => {
    expect(validateBoostInput({ targets: [target], bump: 2 })).toEqual({
      targets: [target],
      bump: 2
    });
  });
  it('rejects non-object, empty targets, malformed target, bad bump, over-cap', () => {
    expect(() => validateBoostInput(null)).toThrowError(
      expect.objectContaining({ code: 'bad_request' })
    );
    expect(() => validateBoostInput({ targets: [] })).toThrowError(
      expect.objectContaining({ code: 'bad_request' })
    );
    expect(() => validateBoostInput({ targets: [{ namespace: 'a', type: 'b' }] })).toThrowError(
      expect.objectContaining({ code: 'bad_request' })
    );
    expect(() => validateBoostInput({ targets: [target], bump: 0 })).toThrowError(
      expect.objectContaining({ code: 'bad_request' })
    );
    expect(() =>
      validateBoostInput({ targets: Array.from({ length: 501 }, () => target) })
    ).toThrowError(expect.objectContaining({ code: 'bad_request' }));
  });
});

describe('handleSalienceBoost', () => {
  it('reports what the store actually reinforced, not what was asked', async () => {
    // The store says it matched the target, so applied is 1 and nothing is
    // missing.
    const boostSalience = vi.fn<EmbeddingsStore['boostSalience']>().mockResolvedValue([target]);
    const out = await handleSalienceBoost(
      { targets: [target] },
      {
        store: makeBoostStore(boostSalience),
        halfLifeHours: 168,
        checkWritePolicy: () => ({ allow: true })
      }
    );
    expect(out).toEqual({ ok: true, requested: 1, applied: 1, missing: [] });
    expect(boostSalience).toHaveBeenCalledWith([target], 168, undefined);
  });

  it('a target that matched nothing is reported, not silently counted as success', async () => {
    // A well-formed reference to a real (namespace, type) whose id has no
    // embedding row. The store reinforces nothing, and the response must say
    // so rather than look like a boost that landed.
    const ghost = { namespace: 'cortext', type: 'AgentRule', id: 'no-such-row' };
    const boostSalience = vi.fn<EmbeddingsStore['boostSalience']>().mockResolvedValue([target]);
    const out = await handleSalienceBoost(
      { targets: [target, ghost] },
      {
        store: makeBoostStore(boostSalience),
        halfLifeHours: 168,
        checkWritePolicy: () => ({ allow: true })
      }
    );
    expect(out).toEqual({ ok: true, requested: 2, applied: 1, missing: [ghost] });
  });

  it('differences by identity, not by index — the store does not promise an order', async () => {
    // pg's RETURNING follows update order, not input order. Zipping by index
    // would mislabel which target missed.
    const a = { namespace: 'cortext', type: 'AgentRule', id: 'a' };
    const b = { namespace: 'cortext', type: 'AgentRule', id: 'b' };
    const c = { namespace: 'cortext', type: 'AgentRule', id: 'c' };
    const boostSalience = vi.fn<EmbeddingsStore['boostSalience']>().mockResolvedValue([c, a]); // deliberately neither input order nor sorted
    const out = await handleSalienceBoost(
      { targets: [a, b, c] },
      {
        store: makeBoostStore(boostSalience),
        halfLifeHours: 168,
        checkWritePolicy: () => ({ allow: true })
      }
    );
    expect(out).toEqual({ ok: true, requested: 3, applied: 2, missing: [b] });
  });

  it('every target missing still reports ok — accepted, but zero applied', async () => {
    // `ok` stays true because the REQUEST was well-formed and authorised;
    // that is a different question from whether anything moved. Keeping them
    // separate is why `applied` exists rather than `ok` being weakened.
    const boostSalience = vi.fn<EmbeddingsStore['boostSalience']>().mockResolvedValue([]);
    const out = await handleSalienceBoost(
      { targets: [target] },
      {
        store: makeBoostStore(boostSalience),
        halfLifeHours: 168,
        checkWritePolicy: () => ({ allow: true })
      }
    );
    expect(out).toEqual({ ok: true, requested: 1, applied: 0, missing: [target] });
  });
  it('throws policy_denied naming the scope; store untouched', async () => {
    const boostSalience = vi.fn<EmbeddingsStore['boostSalience']>().mockResolvedValue([]);
    await expect(
      handleSalienceBoost(
        { targets: [target] },
        {
          store: makeBoostStore(boostSalience),
          halfLifeHours: 168,
          checkReadPolicy: () => ({ allow: false, reason: 'nope' })
        }
      )
    ).rejects.toMatchObject({
      code: 'policy_denied',
      message: expect.stringContaining('claude/Memory')
    });
    expect(boostSalience).not.toHaveBeenCalled();
  });
  it('dedupes BOTH scope checks across targets sharing (namespace, type)', async () => {
    // Two targets, one scope. Neither gate should be consulted twice — a policy
    // probe can be expensive and the answer cannot differ within one request.
    const boostSalience = vi.fn<EmbeddingsStore['boostSalience']>().mockResolvedValue([]);
    const checkReadPolicy = vi.fn().mockReturnValue({ allow: true });
    const checkWritePolicy = vi.fn().mockReturnValue({ allow: true });
    await handleSalienceBoost(
      { targets: [target, { ...target, id: 'm2' }] },
      {
        store: makeBoostStore(boostSalience),
        halfLifeHours: 168,
        checkReadPolicy,
        checkWritePolicy
      }
    );
    expect(checkReadPolicy).toHaveBeenCalledTimes(1);
    expect(checkWritePolicy).toHaveBeenCalledTimes(1);
  });

  it('refuses the boost when the write policy denies, even though reads are allowed', async () => {
    // Regression: the boost must be gated by the WRITE probe. With
    // `auth.writes=identity` and open reads, the read probe would let an
    // unsigned caller move a row's salience.
    const boostSalience = vi.fn<EmbeddingsStore['boostSalience']>().mockResolvedValue([]);
    await expect(
      handleSalienceBoost(
        { targets: [target] },
        {
          store: makeBoostStore(boostSalience),
          halfLifeHours: 168,
          checkReadPolicy: () => ({ allow: true }),
          checkWritePolicy: () => ({ allow: false, reason: 'writes require an identity' })
        }
      )
    ).rejects.toThrowError(expect.objectContaining({ code: 'policy_denied' }));
    expect(boostSalience).not.toHaveBeenCalled();
  });

  it('refuses the boost when NO write policy is wired — absence is not permission', async () => {
    // Fails closed, unlike checkReadPolicy whose absence means open. Declining
    // to reinforce costs a ranking signal; reinforcing without authorisation is
    // the defect itself, so the two defaults point opposite ways on purpose.
    const boostSalience = vi.fn<EmbeddingsStore['boostSalience']>().mockResolvedValue([]);
    await expect(
      handleSalienceBoost(
        { targets: [target] },
        { store: makeBoostStore(boostSalience), halfLifeHours: 168 }
      )
    ).rejects.toThrowError(expect.objectContaining({ code: 'policy_denied' }));
    expect(boostSalience).not.toHaveBeenCalled();
  });
});
