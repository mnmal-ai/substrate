import { describe, expect, it } from 'vitest';
import { SubscribeError } from '../src/errors.js';
import { reduceSubscribeRows, watchRows } from '../src/subscribe-rows.js';
import type { SubscribeEvent } from '../src/transport/ws.js';

const QKEY = 'claude/Todo';

/** A controllable single-pass event source that records `return()` (cancel). */
function fakeEvents(
  events: SubscribeEvent[],
  onReturn?: () => void
): AsyncIterable<SubscribeEvent> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<SubscribeEvent>> {
          if (i < events.length) return { value: events[i++] as SubscribeEvent, done: false };
          return { value: undefined as unknown as SubscribeEvent, done: true };
        },
        async return(): Promise<IteratorResult<SubscribeEvent>> {
          onReturn?.();
          return { value: undefined as unknown as SubscribeEvent, done: true };
        }
      };
    }
  };
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('reduceSubscribeRows', () => {
  it('snapshot returns the full row list', () => {
    const next = reduceSubscribeRows([{ id: 1 }], QKEY, {
      kind: 'snapshot',
      data: { [QKEY]: [{ id: 2 }, { id: 3 }] }
    } as SubscribeEvent);
    expect(next).toEqual([{ id: 2 }, { id: 3 }]);
  });

  it('snapshot tolerates a single-object slot', () => {
    const next = reduceSubscribeRows([], QKEY, {
      kind: 'snapshot',
      data: { [QKEY]: { id: 1 } }
    } as SubscribeEvent);
    expect(next).toEqual([{ id: 1 }]);
  });

  it('snapshot of an absent/empty slot yields []', () => {
    expect(
      reduceSubscribeRows([{ id: 1 }], QKEY, { kind: 'snapshot', data: {} } as SubscribeEvent)
    ).toEqual([]);
  });

  it('add appends the row', () => {
    const next = reduceSubscribeRows([{ id: 1 }], QKEY, {
      kind: 'add',
      data: { [QKEY]: { id: 2 } }
    } as SubscribeEvent);
    expect(next).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('update replaces a row by id', () => {
    const next = reduceSubscribeRows(
      [
        { id: 1, t: 'a' },
        { id: 2, t: 'b' }
      ],
      QKEY,
      {
        kind: 'update',
        data: { [QKEY]: { id: 1, t: 'A' } }
      } as SubscribeEvent
    );
    expect(next).toEqual([
      { id: 1, t: 'A' },
      { id: 2, t: 'b' }
    ]);
  });

  it('update matches numeric ids via string coercion', () => {
    const next = reduceSubscribeRows([{ id: 1 }], QKEY, {
      kind: 'update',
      data: { [QKEY]: { id: '1', t: 'x' } }
    } as SubscribeEvent);
    expect(next).toEqual([{ id: '1', t: 'x' }]);
  });

  it('update with a row missing id is a no-op, returning the SAME reference', () => {
    const current = [{ id: 1 }];
    const next = reduceSubscribeRows(current, QKEY, {
      kind: 'update',
      data: { [QKEY]: { t: 'no-id' } }
    } as SubscribeEvent);
    expect(next).toBe(current);
  });

  it('remove drops a row by removedId (string coercion)', () => {
    const next = reduceSubscribeRows([{ id: 1 }, { id: 2 }], QKEY, {
      kind: 'remove',
      removedId: 2
    } as unknown as SubscribeEvent);
    expect(next).toEqual([{ id: 1 }]);
  });

  it('end / error / chunk leave the list unchanged (same reference)', () => {
    const current = [{ id: 1 }];
    for (const ev of [
      { kind: 'end' },
      { kind: 'error', errors: [{ message: 'x' }] },
      { kind: 'chunk', data: { [QKEY]: { id: 9 } } }
    ] as SubscribeEvent[]) {
      expect(reduceSubscribeRows(current, QKEY, ev)).toBe(current);
    }
  });
});

describe('watchRows', () => {
  it('keeps watching across an end the transport survives (restart, lapsed credential)', async () => {
    // The transport resubscribes after these; the fresh snapshot replaces the set.
    for (const reason of ['server_restart', 'credential_expired', 'credential_changed']) {
      const sets = await collect(
        watchRows(
          fakeEvents([
            { kind: 'snapshot', data: { [QKEY]: [{ id: 1 }] } },
            { kind: 'end', reason },
            { kind: 'snapshot', data: { [QKEY]: [{ id: 1 }, { id: 2 }] } },
            { kind: 'end' }
          ] as SubscribeEvent[]),
          QKEY
        )
      );
      expect(sets).toEqual([[{ id: 1 }], [{ id: 1 }, { id: 2 }]]);
    }
  });

  it('yields the maintained row-set after each delta', async () => {
    const sets = await collect(
      watchRows(
        fakeEvents([
          { kind: 'snapshot', data: { [QKEY]: [{ id: 1 }] } },
          { kind: 'add', data: { [QKEY]: { id: 2 } } },
          { kind: 'update', data: { [QKEY]: { id: 1, t: 'A' } } },
          { kind: 'remove', removedId: '2' },
          { kind: 'end' }
        ] as SubscribeEvent[]),
        QKEY
      )
    );
    expect(sets).toEqual([
      [{ id: 1 }],
      [{ id: 1 }, { id: 2 }],
      [{ id: 1, t: 'A' }, { id: 2 }],
      [{ id: 1, t: 'A' }]
    ]);
  });

  it('yields an empty set for an empty snapshot then completes on end', async () => {
    const sets = await collect(
      watchRows(
        fakeEvents([
          { kind: 'snapshot', data: { [QKEY]: [] } },
          { kind: 'end' }
        ] as SubscribeEvent[]),
        QKEY
      )
    );
    expect(sets).toEqual([[]]);
  });

  it('completes when the source iterator completes without an explicit end', async () => {
    const sets = await collect(
      watchRows(
        fakeEvents([{ kind: 'snapshot', data: { [QKEY]: [{ id: 1 }] } }] as SubscribeEvent[]),
        QKEY
      )
    );
    expect(sets).toEqual([[{ id: 1 }]]);
  });

  it('skips chunk events without yielding', async () => {
    const sets = await collect(
      watchRows(
        fakeEvents([
          { kind: 'snapshot', data: { [QKEY]: [{ id: 1 }] } },
          { kind: 'chunk', data: { [QKEY]: { id: 99 } } },
          { kind: 'add', data: { [QKEY]: { id: 2 } } }
        ] as SubscribeEvent[]),
        QKEY
      )
    );
    expect(sets).toEqual([[{ id: 1 }], [{ id: 1 }, { id: 2 }]]);
  });

  it('does not re-yield on a no-op update (row missing id)', async () => {
    const sets = await collect(
      watchRows(
        fakeEvents([
          { kind: 'snapshot', data: { [QKEY]: [{ id: 1 }] } },
          { kind: 'update', data: { [QKEY]: { t: 'no-id' } } }
        ] as SubscribeEvent[]),
        QKEY
      )
    );
    expect(sets).toEqual([[{ id: 1 }]]);
  });

  it('throws SubscribeError when an error event is surfaced', async () => {
    await expect(
      collect(
        watchRows(
          fakeEvents([
            { kind: 'snapshot', data: { [QKEY]: [] } },
            { kind: 'error', errors: [{ message: 'boom', code: 'overloaded' }] }
          ] as SubscribeEvent[]),
          QKEY
        )
      )
    ).rejects.toBeInstanceOf(SubscribeError);
  });

  it('propagates cancellation to the source iterator on early break', async () => {
    let returned = false;
    const it = watchRows(
      fakeEvents(
        [
          { kind: 'snapshot', data: { [QKEY]: [{ id: 1 }] } },
          { kind: 'add', data: { [QKEY]: { id: 2 } } }
        ] as SubscribeEvent[],
        () => {
          returned = true;
        }
      ),
      QKEY
    );
    for await (const _set of it) break; // consume one set, then bail
    expect(returned).toBe(true);
  });
});
