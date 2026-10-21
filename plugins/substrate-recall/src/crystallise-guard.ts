/**
 * Mutual exclusion for crystallise passes: concurrent passes would each see the
 * same rows as unclaimed and form duplicate clusters.
 *
 * One instance must be shared by both transports (the route and the
 * `recall/crystallise` frame); `createRecallPlugin` builds it once. An
 * in-process flag covers this binary, and the optional `crossProcess` lock
 * (`ClusterStore.withFormationLock`) covers other binaries on the same store.
 * Either refusing throws `crystallise_in_flight`.
 */

export const CRYSTALLISE_IN_FLIGHT_CODE = 'crystallise_in_flight';

export interface CrystalliseGuard {
  /**
   * Run `fn` if no other pass is currently running; otherwise throw a coded
   * `crystallise_in_flight` error immediately (never queues). The flag is
   * cleared in a `finally`, so a throw from `fn` itself still releases it.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export function inFlightError(): Error {
  return Object.assign(
    new Error('a crystallise pass is already running — retry when it completes'),
    { code: CRYSTALLISE_IN_FLIGHT_CODE }
  );
}

export interface CrystalliseGuardOptions {
  /** Exclusion across processes; see `ClusterStore.withFormationLock`. */
  crossProcess?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export function createCrystalliseGuard(opts: CrystalliseGuardOptions = {}): CrystalliseGuard {
  let inFlight = false;
  return {
    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      if (inFlight) throw inFlightError();
      inFlight = true;
      try {
        return opts.crossProcess === undefined ? await fn() : await opts.crossProcess(fn);
      } finally {
        inFlight = false;
      }
    }
  };
}
