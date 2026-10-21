/**
 * Runtime kill switch for hard-destructive operations. When
 * `SUBSTRATE_HARD_DELETE=refuse`, every gated apply path refuses with
 * `ResolverFrameError('destructive_ops_disabled')` regardless of caller
 * capability. Unset or 'allow' permits them.
 *
 * Lives in substrate-types so substrate-sdk can call it without a runtime dep on
 * substrate-core. The env is read at call time, not module load.
 */

import { ResolverFrameError } from './errors.js';

const ENV_VAR = 'SUBSTRATE_HARD_DELETE';
const VALUE_ALLOW = 'allow';
const VALUE_REFUSE = 'refuse';

export function assertHardDeleteAllowed(): void {
  if (process.env[ENV_VAR] === VALUE_REFUSE) {
    throw new ResolverFrameError(
      'destructive_ops_disabled',
      `${ENV_VAR}=${VALUE_REFUSE} on this instance; restart with ${ENV_VAR}=${VALUE_ALLOW} (or unset) to authorise destructive ops.`
    );
  }
}

export function validateHardDeleteEnv(): void {
  const v = process.env[ENV_VAR];
  if (v !== undefined && v !== VALUE_ALLOW && v !== VALUE_REFUSE) {
    throw new Error(
      `${ENV_VAR} must be '${VALUE_ALLOW}' or '${VALUE_REFUSE}' (got '${v}'). Unset = ${VALUE_ALLOW}.`
    );
  }
}
