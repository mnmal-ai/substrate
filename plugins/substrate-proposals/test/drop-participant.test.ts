/**
 * The drop participant archives a dropped namespace's proposal rows from the
 * control plane alone, so it works on a process that never installed it.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { describe, expect, it } from 'vitest';
import { CONTROL_NAMESPACE } from '../src/control-plane.js';
import { namespaceDropParticipant } from '../src/multi-instance.js';

describe('namespaceDropParticipant', () => {
  it('archives every row for the namespace, past one page, and no other', async () => {
    const control = new MemoryDataset({ namespace: CONTROL_NAMESPACE });
    const row = (id: string, ns: string) => ({
      id,
      ns,
      proposedBy: 'a',
      proposedAt: new Date(),
      proposedReason: '',
      applied: true,
      appliedAt: new Date(),
      supersededByCode: false,
      archived: false
    });
    await control.write('NamespaceProposal', [
      ...Array.from({ length: 501 }, (_, i) => row(`d${i}`, 'dropped')),
      row('k', 'kept')
    ]);

    await namespaceDropParticipant(CONTROL_NAMESPACE).onDrop('dropped', () => control);

    const all = (await control.read('NamespaceProposal', { limit: 1000 })).rows;
    expect(all.filter((r) => r.ns === 'dropped' && r.archived !== true)).toHaveLength(0);
    expect(all.find((r) => r.ns === 'kept')?.archived).toBe(false);
  });
});
