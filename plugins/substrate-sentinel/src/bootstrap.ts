/**
 * Structured-config bootstrap for `@mnmal-ai/substrate-sentinel`.
 *
 * Consumed by the `SUBSTRATE_PLUGIN_DIR` manifest-driven loader; the package's
 * `substrate.entry` manifest field points the loader here.
 */

import { defineBootstrap } from '@mnmal-ai/substrate/sdk';
import { z } from 'zod';
import { createSentinelPlugin } from './index.js';

const NamespaceSchema = z
  .string()
  .min(1, 'must not be empty')
  .refine((s) => !s.includes('/'), { message: "must not contain '/'" });

export const SentinelBootstrapConfigSchema = z
  .object({
    namespace: NamespaceSchema.default('sentinel'),
    /** Interval between liveness ticks in milliseconds. */
    pingIntervalMs: z.number().int().positive().default(30_000),
    /**
     * Max heartbeat age before a coordinator is marked offline. Checked once
     * per `pingIntervalMs` tick, so eviction lands up to one interval later.
     */
    staleThresholdMs: z.number().int().positive().default(90_000)
  })
  .strict();

export type SentinelBootstrapConfig = z.infer<typeof SentinelBootstrapConfigSchema>;

export const bootstrap = defineBootstrap.coordinator({
  schema: SentinelBootstrapConfigSchema,
  build: (config) =>
    createSentinelPlugin({
      namespace: config.namespace,
      pingIntervalMs: config.pingIntervalMs,
      staleThresholdMs: config.staleThresholdMs
    })
});

export default bootstrap;
