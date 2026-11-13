/**
 * compose/guards.ts — fail-closed boot guards.
 *
 * The check runs BEFORE anything is allocated so a misconfigured deployment
 * refuses at boot rather than serving with a hole.
 */

import type { Identity } from '@mnmal-ai/substrate-types';
import type { AuthConfig } from '../auth.js';

export interface BootGuards {
  systemIdentity: Identity | null;
}

export function resolveBootGuards(opts: { auth?: AuthConfig; systemActor?: string }): BootGuards {
  // Without auth nothing identifies a caller, and `resolveIdentity` refuses to
  // invent an actor — so an unauthenticated deployment must say who it writes
  // as. Refusing at boot beats every write failing at runtime.
  const systemActor = opts.systemActor?.trim();
  if (opts.auth === undefined && (systemActor === undefined || systemActor.length === 0)) {
    throw new Error(
      'compose: `systemActor` is required when auth is disabled — with no bearer ' +
        'there is nothing to attribute a write to, and Substrate no longer defaults to ' +
        '`system:anonymous`. Declare who this deployment writes as, ' +
        "e.g. systemActor: 'local-dev' (SUBSTRATE_SYSTEM_ACTOR for the binary). Enable " +
        'auth instead if callers should be attributed individually.'
    );
  }
  // The deployment's own actor, with its grant stated explicitly so
  // `describeIdentity` reports it. `read` + `mutate` and deliberately NOT
  // `admin`: admin-gated _system ops stay direct-engine-only.
  const systemIdentity: Identity | null =
    systemActor !== undefined && systemActor.length > 0
      ? { kind: 'system', id: systemActor, grants: { '*': ['read', 'mutate'] } }
      : null;
  return { systemIdentity };
}
