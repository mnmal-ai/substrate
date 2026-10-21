/**
 * @mnmal-ai/substrate-sentinel-client — helper library for dynamic bridge
 * discovery via a sentinel instance. Spec: §5.11 (coordinator plugin seam)
 * is NOT changed by this package — sentinel-client is a wiring library,
 * called from a host binary's composition root.
 */

export {
  type MetricSink,
  type SentinelClientEngineHandle,
  type SentinelClientHandle,
  type StartSentinelClientOpts,
  startSentinelClient,
  type WritableBridgeRegistry
} from './client.js';
export { loadConfig, type SentinelClientConfig } from './config.js';
