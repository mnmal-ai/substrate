/**
 * Re-exports the hard-delete kill-switch helpers from `@mnmal-ai/substrate-types`,
 * where they live so substrate-sdk can call them without importing substrate-core.
 */

export { assertHardDeleteAllowed, validateHardDeleteEnv } from '@mnmal-ai/substrate-types';
