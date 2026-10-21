/**
 * `substrate federate enroll` — mint a single-use enrollment token on the callee.
 *
 * Transport is direct-to-pg, mirroring `substrate-admin register`: no admin JWT is
 * needed, and it works on an instance that was never bootstrapped. That is
 * what dissolves the chicken-and-egg — the operator with shell on the callee
 * is exactly the operator with authority to admit a peer.
 *
 * The `invite_created` audit row is emitted EXPLICITLY. The HTTP route gets it
 * from an autoCRUD mutation interceptor; going direct-to-pg bypasses the
 * engine, so nothing emits it implicitly. Same hand-rolled emit `runRegister`
 * does for `key_registered`.
 */

import { randomBytes } from 'node:crypto';
import {
  AUDIT_EVENT_TYPE,
  buildAuditRow,
  encodeList,
  INVITE_TYPE
} from '@mnmal-ai/substrate-compose';
import { type OpenDatasetFn, openPgDataset, type StoreEnv } from '../../admin/dataset.js';
import { AdminCliError } from '../../admin/errors.js';
import { type AuthPosture, probeAuthPosture } from './probe.js';
import { encodeJoinToken } from './token.js';

/** Actor stamped on audit rows written by the `substrate federate` verbs. */
const CLI_ACTOR_KID = 'substrate-federate-cli';

export interface EnrollArgs {
  /** Already normalised to `scheme://host[:port]` by `parseEnrollArgs`. */
  origin: string;
  namespaces: Array<string>;
  capabilities: Array<string>;
  ttlMs: number;
}

export interface EnrollResult {
  token: string;
  origin: string;
  expiresAt: string;
  namespaces: Array<string>;
  capabilities: Array<string>;
  /** Non-null when the auth probe could not reach the callee. */
  probeWarning: string | null;
}

export type ProbeFn = (origin: string) => Promise<AuthPosture>;

const defaultProbe: ProbeFn = (origin) => probeAuthPosture(origin);

export async function runEnroll(
  args: EnrollArgs,
  env: StoreEnv,
  openDataset: OpenDatasetFn = openPgDataset,
  probe: ProbeFn = defaultProbe
): Promise<EnrollResult> {
  // Posture check BEFORE any write. A token minted against an auth-disabled
  // callee yields a credential that verifies nothing, and the operator would
  // have no way to tell. No override flag: a flag that defeats the one check
  // that matters will get used.
  const posture = await probe(args.origin);
  if (posture === 'disabled') {
    throw new AdminCliError(
      `${args.origin} reports auth is DISABLED — a credential issued against it would verify nothing. ` +
        'Set SUBSTRATE_AUTH_MODE and SUBSTRATE_STREAM_TICKET_SECRET on the callee, restart it, then retry.',
      7
    );
  }
  const probeWarning =
    posture === 'unreachable'
      ? `could not reach ${args.origin} to confirm auth is enabled — minting anyway. ` +
        'Verify the callee shows `auth: enabled` in its boot banner.'
      : null;

  // 32 bytes of entropy, matching the code minted by the /invites route.
  const code = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + args.ttlMs);

  const { dataset, close } = await openDataset(env);
  try {
    await dataset.withTransaction(async (tx) => {
      await tx.write(
        INVITE_TYPE,
        [
          {
            id: code,
            namespaces: encodeList(args.namespaces),
            capabilities: encodeList(args.capabilities),
            expiresAt: expiresAt.toISOString(),
            consumedAt: null,
            consumedBy: null
          }
        ],
        { identity: { kind: 'system', id: CLI_ACTOR_KID }, now }
      );
      await tx.write(
        AUDIT_EVENT_TYPE,
        [
          buildAuditRow({
            actorKid: CLI_ACTOR_KID,
            kind: 'invite_created',
            targetKid: code,
            details: {
              origin: args.origin,
              namespaces: args.namespaces.join(','),
              capabilities: args.capabilities.join(','),
              expiresAt: expiresAt.toISOString()
            },
            now
          })
        ],
        { identity: { kind: 'system', id: CLI_ACTOR_KID }, now }
      );
    });
  } finally {
    await close();
  }

  return {
    token: encodeJoinToken({ origin: args.origin, code }),
    origin: args.origin,
    expiresAt: expiresAt.toISOString(),
    namespaces: args.namespaces,
    capabilities: args.capabilities,
    probeWarning
  };
}

export function formatEnrollOutput(result: EnrollResult): string {
  const lines: Array<string> = [];
  if (result.probeWarning !== null) {
    lines.push(`warning: ${result.probeWarning}`, '');
  }
  lines.push(
    'Enrollment token minted.',
    `  origin:       ${result.origin}`,
    `  namespaces:   ${result.namespaces.join(', ')}`,
    `  capabilities: ${result.capabilities.join(', ')}`,
    `  expires:      ${result.expiresAt}`,
    '',
    `  token:        ${result.token}`,
    '',
    'Run this ON THE CALLER and paste the token at the (silent) prompt.',
    'Single use — it stops working once redeemed.',
    '',
    '  read -rs SUBSTRATE_JOIN_TOKEN && SUBSTRATE_JOIN_TOKEN="$SUBSTRATE_JOIN_TOKEN" substrate federate join',
    ''
  );
  return lines.join('\n');
}
