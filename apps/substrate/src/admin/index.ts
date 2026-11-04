/**
 * `substrate-admin`'s public surface, for tests, tooling and
 * `substrate federate enroll`. The parts:
 *
 *   env.ts        which files hold the admin identity
 *   identity.ts   which store a write lands in, and which key signs it
 *   keys.ts       Key row plumbing, keypair minting, admin classification
 *   route.ts      driving PATCH /substrate/v1/_system/keys, refusal -> exit codes
 *   usage.ts      the help text
 *   main.ts       argv -> subcommand dispatch
 *   run.ts        the process entry `bin/admin.ts` loads
 *   commands/*    one module per subcommand
 */

export {
  type BootstrapResult,
  formatBootstrapOutput,
  parseBootstrapArgs,
  runBootstrap
} from './commands/bootstrap.js';
export {
  type DirectoryReconciliation,
  type DoctorCheck,
  type DoctorReport,
  type DoctorStatus,
  doctorCommand,
  formatDoctorReport,
  reconcileIdentities,
  runDoctor
} from './commands/doctor.js';
export { type ListedKeyRow, parseListArgs, runList } from './commands/list.js';
export {
  formatChecklist,
  type OnboardActions,
  type OnboardIO,
  onboardCommand,
  runOnboard
} from './commands/onboard.js';
export {
  formatRegisterOutput,
  parseRegisterArgs,
  type RegisterResult,
  runRegister,
  runRegisterViaRoute
} from './commands/register.js';
export { formatRevokeOutput, type RevokeResult, runRevoke } from './commands/revoke.js';
export {
  formatRotateOutput,
  parseRotateArgs,
  type RotateResult,
  runRotate
} from './commands/rotate.js';
export {
  formatUpdateOutput,
  parseUpdateArgs,
  runUpdate,
  type UpdateResult
} from './commands/update.js';
export { type OpenDatasetFn, type OpenedDataset, openPgDataset } from './dataset.js';
export { isEntrypointPath } from './entrypoint.js';
export {
  type AdminCliEnv,
  type BootstrapEnv,
  bootstrapKidPath,
  resolveDefaultKeyPath,
  resolveDefaultKidPath
} from './env.js';
export { AdminCliError } from './errors.js';
export { describeGrant, grantLines } from './grant-display.js';
export {
  type AdminTarget,
  describeAdminTarget,
  resolveAdminAuth,
  resolveAdminTarget
} from './identity.js';
export {
  type AdminKeyRow,
  BootstrapError,
  listActiveAdminKeys,
  readEd25519PublicKey
} from './keys.js';
export { main } from './main.js';
