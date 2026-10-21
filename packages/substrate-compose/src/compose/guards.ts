/**
 * compose/guards.ts — fail-closed boot guards.
 *
 * Both checks run BEFORE anything is allocated so a misconfigured deployment
 * refuses at boot rather than serving with a hole.
 */

import type { Identity } from '@mnmal-ai/substrate-types';
import type { AuthConfig } from '../auth.js';

/**
 * Floor for the SSE stream-ticket HMAC key. 16 chars is the shortest length
 * that isn't trivially brute-forced offline — an attacker can test candidate
 * keys against any ticket they observe, with no server round-trip to rate-limit.
 */
const MIN_STREAM_TICKET_SECRET_LEN = 16;

export interface BootGuards {
  streamTicketSecret: string | undefined;
  systemIdentity: Identity | null;
}

export function resolveBootGuards(opts: {
  auth?: AuthConfig;
  streamTicketSecret?: string;
  systemActor?: string;
}): BootGuards {
  // `GET /substrate/v1/stream|subscribe` is deliberately ungated (EventSource can send
  // no Authorization header), so the ticket's HMAC signature is that path's
  // ONLY authentication; a weak key while auth is on is a total auth bypass.
  //
  // Node accepts `''` and `'   '` as HMAC keys, so validate the TRIMMED value,
  // then sign with it so instances whose env differs only in whitespace agree.
  const streamTicketSecret = opts.streamTicketSecret?.trim();
  if (
    opts.auth !== undefined &&
    (streamTicketSecret === undefined || streamTicketSecret.length < MIN_STREAM_TICKET_SECRET_LEN)
  ) {
    throw new Error(
      `compose: \`streamTicketSecret\` must be at least ${MIN_STREAM_TICKET_SECRET_LEN} characters when auth is enabled — it signs the SSE stream tickets that are the only authentication on GET /substrate/v1/stream and /substrate/v1/subscribe, so a short, empty, or whitespace-only key is a forgeable one (set SUBSTRATE_STREAM_TICKET_SECRET for the binary)`
    );
  }
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
  return { streamTicketSecret, systemIdentity };
}
