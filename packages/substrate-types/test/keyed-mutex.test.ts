import { describe, expect, it } from 'vitest';
import { createKeyedMutex } from '../src/keyed-mutex.js';

function gate(): { open: () => void; wait: Promise<void> } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

describe('createKeyedMutex', () => {
  it('runs holders of one key one at a time, in arrival order', async () => {
    const lock = createKeyedMutex();
    const log: string[] = [];
    const g = gate();
    const first = lock('k', async () => {
      log.push('a:start');
      await g.wait;
      log.push('a:end');
    });
    const second = lock('k', async () => {
      log.push('b:start');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['a:start']);
    g.open();
    await Promise.all([first, second]);
    expect(log).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('does not make different keys wait on each other', async () => {
    const lock = createKeyedMutex();
    const g = gate();
    const held = lock('a', () => g.wait);
    await expect(lock('b', async () => 'ran')).resolves.toBe('ran');
    g.open();
    await held;
  });

  it('releases the key when the holder throws', async () => {
    const lock = createKeyedMutex();
    await expect(
      lock('k', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(lock('k', async () => 'next')).resolves.toBe('next');
  });
});
