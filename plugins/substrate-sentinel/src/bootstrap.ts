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
    /**
     * Interval between heartbeat frames to every open peer, in milliseconds. At
     * most 30 s: sentinel clients drop a watch stream silent for 95 s.
     */
    pingIntervalMs: z.number().int().positive().max(30_000).default(30_000),
    /** Ignored: a peer is online while its stream is open. Accepted so older config files still load. */
    staleThresholdMs: z.number().int().positive().optional()
  })
  .strict();

export type SentinelBootstrapConfig = z.infer<typeof SentinelBootstrapConfigSchema>;

export const bootstrap = defineBootstrap.coordinator({
  schema: SentinelBootstrapConfigSchema,
  build: (config) =>
    createSentinelPlugin({
      namespace: config.namespace,
      pingIntervalMs: config.pingIntervalMs
    })
});

export default bootstrap;
