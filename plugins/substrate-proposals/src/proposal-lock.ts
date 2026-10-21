/**
 * Serialises each propose_* check-and-write per proposal identity, so a second
 * concurrent proposal reads the first one's committed row instead of racing it.
 */

import type { Dataset } from '@mnmal-ai/substrate-types';

export type ProposalKind = 'type' | 'field' | 'namespace';

const localTails = new Map<string, Promise<void>>();

/** The lock key for one proposal identity: `substrate-proposals:<kind>:<ns>/<name>`. */
export function proposalLockKey(kind: ProposalKind, ns: string, name: string): string {
  return `substrate-proposals:${kind}:${ns}/${name}`;
}

/**
 * Run `fn` while holding the lock for `key`. Uses the dataset's
 * `withAdvisoryLock` when it has one (pg: excludes every process on the
 * database); otherwise a process-local mutex, which leaves instances in other
 * processes unserialised.
 *
 * @returns whatever `fn` resolves to
 * @throws whatever `fn` throws, after the lock is released
 */
export function withProposalLock<T>(
  dataset: Dataset,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  if (typeof dataset.withAdvisoryLock === 'function') {
    return dataset.withAdvisoryLock(key, fn);
  }
  return withLocalLock(key, fn);
}

// Kept local rather than imported from substrate-types so the plugin's peer range
// stays satisfiable by substrate-types releases that predate the shared helper.
async function withLocalLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = localTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.then(() => held);
  localTails.set(key, tail);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (localTails.get(key) === tail) localTails.delete(key);
  }
}
