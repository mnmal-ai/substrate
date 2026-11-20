import { describe, expect, it } from 'vitest';
import { normalise, runExample } from './_harness.ts';
import { app } from './recall/namespace.ts';
import { steps } from './recall/steps.ts';

type Hit = { id: string; namespace: string; type: string; row: Record<string, unknown> };

describe('recall example', () => {
  // Mechanics only: the fake embedder's ranking is noise, so nothing is snapshotted.
  it('returns Customer hits that carry no notes unless asked', async () => {
    const n = normalise(
      await runExample({ name: 'recall', namespaces: [app], embedder: 'fake' }, steps)
    );
    for (const s of n.steps) {
      expect(s.status, s.label).toBe(200);
      expect(s.response, s.label).not.toHaveProperty('errors');
    }
    expect(JSON.stringify(n)).not.toContain('"errors"');

    const last = n.steps[n.steps.length - 1] as (typeof n.steps)[number];
    expect(last.feed).toBe(true);
    const hits = (last.response as { data: { 'recall/Hit': Hit[] } }).data['recall/Hit'];
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit).toMatchObject({ namespace: 'app', type: 'Customer' });
      expect(hit.row).toHaveProperty('name');
      expect(hit.row).not.toHaveProperty('notes');
    }
  });
});
