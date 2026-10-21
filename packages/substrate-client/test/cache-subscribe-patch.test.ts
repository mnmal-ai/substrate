import { describe, expect, it } from 'vitest';
import { CacheStore } from '../src/cache/store.js';
import type { SubscribeEvent } from '../src/transport/ws.js';

const KEY = 'claude/Todo:{}';
const QKEY = 'claude/Todo';

function make(): CacheStore {
  return new CacheStore({ idleGcMs: 1_000 });
}

describe('CacheStore.applySubscribeEvent', () => {
  it('snapshot replaces the entire data envelope', () => {
    const c = make();
    c.set(KEY, { [QKEY]: [{ id: 1 }] });
    c.applySubscribeEvent(KEY, QKEY, {
      kind: 'snapshot',
      data: { [QKEY]: [{ id: 2 }, { id: 3 }] }
    } as SubscribeEvent);
    expect(c.get(KEY).data.value).toEqual({ [QKEY]: [{ id: 2 }, { id: 3 }] });
  });

  it('add appends a row into the nested list', () => {
    const c = make();
    c.set(KEY, { [QKEY]: [{ id: 1 }] });
    c.applySubscribeEvent(KEY, QKEY, {
      kind: 'add',
      data: { [QKEY]: { id: 2 } }
    } as SubscribeEvent);
    expect(c.get(KEY).data.value).toEqual({ [QKEY]: [{ id: 1 }, { id: 2 }] });
  });

  it('update replaces a row by id in the nested list', () => {
    const c = make();
    c.set(KEY, {
      [QKEY]: [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' }
      ]
    });
    c.applySubscribeEvent(KEY, QKEY, {
      kind: 'update',
      data: { [QKEY]: { id: 1, title: 'A' } }
    } as SubscribeEvent);
    expect(c.get(KEY).data.value).toEqual({
      [QKEY]: [
        { id: 1, title: 'A' },
        { id: 2, title: 'b' }
      ]
    });
  });

  it('remove drops a row by removedId', () => {
    const c = make();
    c.set(KEY, { [QKEY]: [{ id: 1 }, { id: 2 }] });
    c.applySubscribeEvent(KEY, QKEY, {
      kind: 'remove',
      removedId: '1'
    } as SubscribeEvent);
    expect(c.get(KEY).data.value).toEqual({ [QKEY]: [{ id: 2 }] });
  });

  it('remove matches numeric ids via string coercion', () => {
    const c = make();
    c.set(KEY, { [QKEY]: [{ id: 1 }, { id: 2 }] });
    c.applySubscribeEvent(KEY, QKEY, { kind: 'remove', removedId: 2 } as unknown as SubscribeEvent);
    expect(c.get(KEY).data.value).toEqual({ [QKEY]: [{ id: 1 }] });
  });

  it('add on empty entry (no snapshot yet) initialises the list', () => {
    const c = make();
    c.get(KEY); // creates entry with undefined data
    c.applySubscribeEvent(KEY, QKEY, {
      kind: 'add',
      data: { [QKEY]: { id: 1 } }
    } as SubscribeEvent);
    expect(c.get(KEY).data.value).toEqual({ [QKEY]: [{ id: 1 }] });
  });

  it('update / remove on empty entry are no-ops', () => {
    const c = make();
    c.get(KEY);
    c.applySubscribeEvent(KEY, QKEY, {
      kind: 'update',
      data: { [QKEY]: { id: 1 } }
    } as SubscribeEvent);
    expect(c.get(KEY).data.value).toBeUndefined();
    c.applySubscribeEvent(KEY, QKEY, { kind: 'remove', removedId: '1' } as SubscribeEvent);
    expect(c.get(KEY).data.value).toBeUndefined();
  });

  it('terminal kinds (end / error / chunk) are ignored by the cache', () => {
    const c = make();
    c.set(KEY, { [QKEY]: [{ id: 1 }] });
    c.applySubscribeEvent(KEY, QKEY, { kind: 'end' } as SubscribeEvent);
    c.applySubscribeEvent(KEY, QKEY, {
      kind: 'error',
      errors: [{ message: 'x' }]
    } as SubscribeEvent);
    c.applySubscribeEvent(KEY, QKEY, {
      kind: 'chunk',
      data: { [QKEY]: { id: 2 } }
    } as SubscribeEvent);
    expect(c.get(KEY).data.value).toEqual({ [QKEY]: [{ id: 1 }] });
  });
});
