/**
 * The admin identity while unlocked. Holds ONLY the token provider and the kid; every
 * admin operation builds its own SubstrateClient and closes it after, so no admin connection, cache
 * or socket outlives one. Lock, idle expiry and a rejected key all drop the provider; an
 * operation already running finishes on the client it holds.
 */

import { AdminBackfillError, AuthError, SubstrateClient } from '@mnmal-ai/substrate/client';

export type AdminState =
  | { readonly kind: 'locked'; readonly reason: string | null }
  | { readonly kind: 'unlocked'; readonly kid: string; readonly idleUntil: number };

export interface AdminOp {
  readonly client: SubstrateClient;
  /** The `Authorization` value, for the fetch-level callers (`diagnose`). */
  readonly authorization: () => string;
}

export interface AdminSession {
  state(): AdminState;
  unlocked(): boolean;
  /** The caller has already verified the identity (diagnose). Starts the idle timer. */
  unlock(kid: string, getToken: () => string): void;
  lock(reason: string): void;
  /** A fresh client signed as admin, closed after. Resets the idle timer unless `touch: false` (background polls). A rejected admin key locks. */
  run<T>(op: (admin: AdminOp) => Promise<T>, opts?: { touch?: boolean }): Promise<T>;
  onChange(fn: (s: AdminState) => void): () => void;
  dispose(): void;
}

export class AdminLockedError extends Error {
  override readonly name = 'AdminLockedError';
  constructor() {
    super('admin is locked — /admin unlock');
  }
}

export interface AdminSessionOpts {
  readonly endpoint: string;
  readonly idleMs: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Tests count constructions and closes through this. */
  readonly makeClient?: (getToken: () => string) => SubstrateClient;
}

export const ADMIN_IDLE_DEFAULT_MIN = 15;

/** setTimeout's ceiling: a longer delay overflows and fires at once, which would lock on unlock. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export function adminIdleMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.SUBSTRATE_TUI_ADMIN_IDLE_MINUTES);
  return Math.min(
    MAX_TIMER_MS,
    (Number.isInteger(n) && n > 0 ? n : ADMIN_IDLE_DEFAULT_MIN) * 60_000
  );
}

/** `SUBSTRATE_ADMIN_CAPABILITY` as the CLI reads it: unset or empty means diagnose's default. */
export function adminCapabilityOf(env: { SUBSTRATE_ADMIN_CAPABILITY?: string }): {
  adminCapability?: string;
} {
  const c = env.SUBSTRATE_ADMIN_CAPABILITY;
  return c !== undefined && c.length > 0 ? { adminCapability: c } : {};
}

/**
 * The admin key itself was refused: a 401, or the auth gate's 403 (no code, or `forbidden`). A
 * route's own coded 403 (`directory_denied`, `destructive_ops_disabled`) refuses the request, not
 * the key. A chunked backfill wraps every failure, so the cause is what is judged.
 */
export function isKeyRejection(err: unknown): boolean {
  const e = err instanceof AdminBackfillError ? err.cause : err;
  return (
    e instanceof AuthError && (e.status === 401 || e.code === undefined || e.code === 'forbidden')
  );
}

export function createAdminSession(opts: AdminSessionOpts): AdminSession {
  const now = opts.now ?? Date.now;
  const make =
    opts.makeClient ??
    ((getToken: () => string) =>
      new SubstrateClient({
        endpoint: opts.endpoint,
        getToken,
        ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
        // The default sink is console.warn, which would scribble over the Ink screen.
        onDiagnostics: () => {}
      }));
  let held: { kid: string; getToken: () => string } | null = null;
  let state: AdminState = { kind: 'locked', reason: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const listeners = new Set<(s: AdminState) => void>();

  const set = (s: AdminState) => {
    state = s;
    for (const fn of listeners) fn(s);
  };
  const lock = (reason: string) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    held = null;
    set({ kind: 'locked', reason });
  };
  const touch = () => {
    if (held === null) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(
      () => lock(`idle — no admin action for ${Math.round(opts.idleMs / 60_000)}m`),
      opts.idleMs
    );
    timer.unref?.();
    set({ kind: 'unlocked', kid: held.kid, idleUntil: now() + opts.idleMs });
  };

  return {
    state: () => state,
    unlocked: () => held !== null,
    unlock(kid, getToken) {
      if (disposed) return;
      held = { kid, getToken };
      touch();
    },
    lock,
    async run(op, runOpts) {
      if (held === null) throw new AdminLockedError();
      const { getToken } = held;
      if (runOpts?.touch !== false) touch();
      const client = make(getToken);
      try {
        return await op({ client, authorization: () => `Bearer ${getToken()}` });
      } catch (err) {
        // A 401, or the auth gate's 403, means the admin key itself was refused. A route's own
        // 403 (`directory_denied`, `policy_denied`) is a refusal of this request, shown as one.
        // A chunked backfill wraps every failure, a rejected key included; the rule reads the cause.
        if (isKeyRejection(err) && held !== null) {
          const e = (err instanceof AdminBackfillError ? err.cause : err) as AuthError;
          lock(`admin locked: ${e.status} — the admin key was rejected`);
        }
        throw err;
      } finally {
        await client.close();
      }
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      disposed = true;
      lock('session ended');
      listeners.clear();
    }
  };
}
