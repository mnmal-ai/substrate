/**
 * substrate-sentinel plugin config type. Populated by the structured-config
 * bootstrap (`bootstrap.ts`) or by direct programmatic callers (tests).
 */

export interface SentinelPluginConfig {
  /** Namespace the plugin's types and routes register under. */
  namespace: string;
  /** Interval between heartbeat frames to every open peer, in milliseconds. */
  pingIntervalMs: number;
}
