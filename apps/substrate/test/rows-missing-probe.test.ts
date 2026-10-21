import type { Dataset, ReadParams, ReadResult, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { createRowsMissingProbe } from '../src/rows-missing-probe.js';

interface ReadCall {
  namespace: string;
  type: string;
  params: ReadParams;
}

/**
 * Minimal dataset stub: knows which ids exist per type, records every read.
 * `read` honours `ids` only — the probe is not allowed to need anything else.
 */
function fakeDataset(
  namespace: string,
  present: Record<string, string[]>,
  calls: ReadCall[]
): Dataset {
  return {
    txScopeId: 'fake',
    read: async (type: string, params: ReadParams): Promise<ReadResult> => {
      calls.push({ namespace, type, params });
      const known = new Set(present[type] ?? []);
      const asked = (params.ids ?? []).map(String);
      const rows = asked.filter((id) => known.has(id)).map((id) => ({ id }) as Row);
      return { rows, hasMore: false };
    }
  } as unknown as Dataset;
}

const ref = (
  namespace: string,
  type: string,
  id: string
): { namespace: string; type: string; id: string } => ({
  namespace,
  type,
  id
});

describe('createRowsMissingProbe', () => {
  it('issues one read per (namespace, type) group and names only the absent rows', async () => {
    const calls: ReadCall[] = [];
    const datasets: Record<string, Dataset> = {
      cortext: fakeDataset('cortext', { Decision: ['d1', 'd3'], SessionLog: ['s1'] }, calls),
      architecture: fakeDataset('architecture', { ArchitectureConcern: [] }, calls)
    };
    const probe = createRowsMissingProbe({ resolveDataset: (ns) => datasets[ns] ?? null });

    const missing = await probe([
      ref('cortext', 'Decision', 'd1'),
      ref('cortext', 'Decision', 'd2'),
      ref('cortext', 'Decision', 'd3'),
      ref('cortext', 'SessionLog', 's1'),
      ref('cortext', 'SessionLog', 's2'),
      ref('architecture', 'ArchitectureConcern', 'a1')
    ]);

    expect([...missing].sort()).toEqual([
      'architecture/ArchitectureConcern/a1',
      'cortext/Decision/d2',
      'cortext/SessionLog/s2'
    ]);

    // Three groups, three reads — one read per type, not per member.
    expect(calls).toHaveLength(3);
    const decision = calls.find((c) => c.type === 'Decision');
    expect(decision?.params.ids).toEqual(['d1', 'd2', 'd3']);
    // No `limit`: the datasets treat an absent limit as unbounded, and any
    // page cap here would read as "the rest of this batch is gone".
    expect(decision?.params.limit).toBeUndefined();
  });

  it('reports nothing for a namespace it cannot resolve', async () => {
    const calls: ReadCall[] = [];
    const datasets: Record<string, Dataset> = {
      cortext: fakeDataset('cortext', { Decision: [] }, calls)
    };
    const probe = createRowsMissingProbe({ resolveDataset: (ns) => datasets[ns] ?? null });

    const missing = await probe([
      ref('gone-ns', 'Whatever', 'x1'),
      ref('cortext', 'Decision', 'd1')
    ]);

    // 'x1' is unresolvable, not absent — the sweep departs what this set
    // names, and there is no un-depart, so an unanswerable ref must stay out
    // of it. 'd1' IS answerable and IS gone.
    expect([...missing]).toEqual(['cortext/Decision/d1']);
    expect(calls.map((c) => c.namespace)).toEqual(['cortext']);
  });

  it('de-duplicates repeated refs into a single asked id', async () => {
    const calls: ReadCall[] = [];
    const datasets: Record<string, Dataset> = {
      cortext: fakeDataset('cortext', { Decision: ['d1'] }, calls)
    };
    const probe = createRowsMissingProbe({ resolveDataset: (ns) => datasets[ns] ?? null });

    await probe([
      ref('cortext', 'Decision', 'd1'),
      ref('cortext', 'Decision', 'd1'),
      ref('cortext', 'Decision', 'd2')
    ]);

    expect(calls[0]?.params.ids).toEqual(['d1', 'd2']);
  });

  it('reads nothing for an empty batch', async () => {
    const calls: ReadCall[] = [];
    const probe = createRowsMissingProbe({
      resolveDataset: () => fakeDataset('cortext', {}, calls)
    });

    expect([...(await probe([]))]).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
