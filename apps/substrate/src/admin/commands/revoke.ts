/**
 * `revoke` — soft-delete a Key by stamping `revokedAt`.
 *
 * Refuses the last active admin. `checkRevocable` is shared with the route so
 * both transports enforce the same floor.
 */

import {
  AUDIT_EVENT_TYPE,
  buildAuditRow,
  checkRevocable,
  KEY_TYPE
} from '@mnmal-ai/substrate-compose';
import type { Row } from '@mnmal-ai/substrate-types';
import { type OpenDatasetFn, openPgDataset } from '../dataset.js';
import type { AdminCliEnv } from '../env.js';
import { AdminCliError } from '../errors.js';
import { ACTOR_HINT, CLI_ACTOR_KID, forUpdate, listActiveAdminKeys, readKeyById } from '../keys.js';
import { REVOKE_EXIT_CODES } from '../route.js';
import { argvError, RESTART_NOTE } from '../usage.js';

export interface RevokeResult {
  kid: string;
  revokedAt: string;
}

export async function runRevoke(
  kid: string,
  env: AdminCliEnv,
  openDataset: OpenDatasetFn = openPgDataset
): Promise<RevokeResult> {
  if (kid === undefined || kid.length === 0) {
    throw argvError('revoke', 'revoke requires a <kid> positional arg');
  }
  const adminCapability =
    env.SUBSTRATE_ADMIN_CAPABILITY !== undefined && env.SUBSTRATE_ADMIN_CAPABILITY.length > 0
      ? env.SUBSTRATE_ADMIN_CAPABILITY
      : 'admin';

  const { dataset, close } = await openDataset(env);
  try {
    return await dataset.withTransaction(async (tx) => {
      const existing = await readKeyById(tx, kid);
      // The rules live in substrate-policy (`checkRevocable`), re-exported by substrate-compose, so the route
      // transport shares them. This path gathers the facts through its own tx; the route gathers the
      // same facts through `engine.query`. Only the verdict is shared.
      const refusal = checkRevocable({
        kid,
        exists: existing !== null,
        existingRevokedAt: existing?.revokedAt,
        activeAdminKids: (await listActiveAdminKeys(tx, adminCapability)).map((a) => a.kid)
      });
      if (refusal !== null) {
        throw new AdminCliError(refusal.message, REVOKE_EXIT_CODES[refusal.code]);
      }

      const now = new Date();
      // `checkRevocable` returns `unknown_kid` when `exists` is false, so a
      // null here is unreachable — but the proof lives inside that function
      // and TS cannot follow it across the call.
      const mergedRow: Row = forUpdate({ ...existing!.row, revokedAt: now });
      await tx.write(KEY_TYPE, [mergedRow], ACTOR_HINT);
      await tx.write(
        AUDIT_EVENT_TYPE,
        [
          buildAuditRow({
            actorKid: CLI_ACTOR_KID,
            kind: 'key_revoked',
            targetKid: kid,
            details: { revokedAt: now.toISOString(), cliSubcommand: 'revoke' },
            now
          })
        ],
        ACTOR_HINT
      );
      return { kid, revokedAt: now.toISOString() };
    });
  } finally {
    await close();
  }
}

export function formatRevokeOutput(result: RevokeResult): string {
  // Direct-to-postgres: no interceptor fires, so the running server keeps
  // verifying the revoked key until re-prime.
  return [`Key ${result.kid} revoked at ${result.revokedAt}`, '', RESTART_NOTE, ''].join('\n');
}
