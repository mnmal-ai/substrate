/**
 * substrate-sentinel plugin config type. Populated by the structured-config
 * bootstrap (`bootstrap.ts`) or by direct programmatic callers (tests).
 */

export interface SentinelPluginConfig {
  /** Namespace the plugin's types and routes register under. */
  namespace: string;
  /** Interval between liveness ticks in milliseconds. */
  pingIntervalMs: number;
  /**
   * Max heartbeat age before a coordinator is marked offline. Checked once
   * per `pingIntervalMs` tick, so eviction lands up to one interval later.
   */
  staleThresholdMs: number;
}
