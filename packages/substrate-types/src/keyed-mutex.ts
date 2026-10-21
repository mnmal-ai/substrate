/**
 * A process-local mutual-exclusion lock per string key.
 *
 * Holders of the same key run one at a time in arrival order; holders of
 * different keys never wait on each other. A key's entry is dropped once its
 * last holder settles, so the map does not grow with the key space.
 */
export type KeyedMutex = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Create an independent keyed mutex.
 *
 * @returns a function that runs `fn` once every earlier holder of `key` has
 *   settled, and resolves or rejects with `fn`'s outcome. Not re-entrant.
 */
export function createKeyedMutex(): KeyedMutex {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prior = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => held);
    tails.set(key, tail);
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
