/**
 * Structured-config bootstrap for `@mnmal-ai/substrate-proposals`.
 *
 * The canonical entry consumed by the binary's `SUBSTRATE_PLUGIN_DIR` loader.
 *
 * `pubsub` and `datasetFor` are intentionally NOT in the schema — they're
 * code-shaped:
 * - `pubsub` defaults to no-op (single-instance).
 * - `datasetFor` stays undefined; the plugin's `onStart` resolves it off
 *   `EngineHandle.datasetFor`.
 *
 * The committed `config.schema.json` (used by `package.json#substrate` for
 * ops-surface declaration) is locked against `z.toJSONSchema(Schema)` by
 * `test/schema-parity.test.ts` — drift fails the test and the schema can be
 * regenerated via `UPDATE_SCHEMA=1 pnpm test`.
 */

import { defineBootstrap } from '@mnmal-ai/substrate-bootstrap';
import type { CoordinatorPlugin } from '@mnmal-ai/substrate-types';
import { z } from 'zod';
import { createNoopPubSub } from './config.js';
import { createProposalsPlugin } from './index.js';

export const ProposalsBootstrapConfigSchema = z
  .object({
    ownedNamespaces: z.array(z.string().min(1)).default([]),
    proposeCapability: z.string().min(1).default('substrate.propose')
  })
  .strict();

export type ProposalsBootstrapConfig = z.infer<typeof ProposalsBootstrapConfigSchema>;

export const bootstrap = defineBootstrap.coordinator({
  schema: ProposalsBootstrapConfigSchema,
  build: (config): CoordinatorPlugin =>
    createProposalsPlugin({
      ownedNamespaces: config.ownedNamespaces,
      pubsub: createNoopPubSub(),
      proposeCapability: config.proposeCapability
    })
});

export default bootstrap;
