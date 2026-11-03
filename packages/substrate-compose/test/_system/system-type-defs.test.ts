/**
 * `SYSTEM_TYPE_DEFS` is what a dataset outside the engine (the admin CLI)
 * creates `_system` tables from, so it must match what `installSystemNamespace`
 * registers, as serve's boot reconciles: the same body fields, and `Key`'s
 * declared indexes.
 */

import { MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { isReservedAutoCrudField } from '@mnmal-ai/substrate-sdk';
import { describe, expect, it } from 'vitest';
import { installSystemNamespace } from '../../src/_system/install.js';
import { KEY_TYPE, SYSTEM_NAMESPACE } from '../../src/_system/types.js';
import { SYSTEM_TYPE_DEFS } from '../../src/index.js';

describe('SYSTEM_TYPE_DEFS', () => {
  it('lists every registered _system type, with its body fields and indexes', async () => {
    const registry = new Registry();
    await installSystemNamespace({
      registry,
      dataset: new MemoryDataset({ namespace: SYSTEM_NAMESPACE }),
      edges: new MemoryEdgesStore({ now: () => new Date() })
    });
    for (const [type, def] of Object.entries(SYSTEM_TYPE_DEFS)) {
      const entry = registry.get(type);
      expect(entry?.kind, type).toBe('type');
      if (entry?.kind !== 'type') continue;
      const registered = Object.fromEntries(
        Object.entries(entry.fields).filter(([, f]) => !isReservedAutoCrudField(f))
      );
      expect(def.fields, type).toEqual(registered);
      expect(def.indexes, type).toEqual(entry.indexes);
    }
    // The other way: a `_system` type the install registers is in the table, so
    // one added without an entry fails here rather than in a bare admin table.
    const registeredTypes = [...registry.all()]
      .filter(([, entry]) => entry.kind === 'type')
      .map(([type]) => type)
      .sort();
    expect(registeredTypes).toEqual(Object.keys(SYSTEM_TYPE_DEFS).sort());
    expect(SYSTEM_TYPE_DEFS[KEY_TYPE]?.indexes?.map((i) => i.name)).toEqual([
      'substrate_key_live_kid_uniq'
    ]);
  });
});
