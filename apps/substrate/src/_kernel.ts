/**
 * Substrate-tier composition now lives in @mnmal-ai/substrate-compose, so
 * the binary and self-composing hosts run one implementation. Re-exported for
 * the binary's existing imports.
 */
export {
  composeKernelPlugins,
  type KernelComposeContext,
  mountKernelRoute
} from '@mnmal-ai/substrate-compose';
