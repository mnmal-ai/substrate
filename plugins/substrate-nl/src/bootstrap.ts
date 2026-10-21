/**
 * Structured-config bootstrap for `@mnmal-ai/substrate-nl`.
 *
 * Operator-overridable (`<pluginDir>/substrate-nl.config.json`):
 *   - `judge`     optional; Ollama for the constrained judge. Absent = parser-only:
 *                 every escalation is an honest hand-off.
 *   - `rulings`   optional; per-namespace override merged over declared rulings.
 *   - `packTtlMs` how long a served pack is reused. Default 300000.
 * Host-supplied (`hostDeps.nlEngine`): schema, operators and query access.
 */
import { defineBootstrap } from '@mnmal-ai/substrate/sdk';
import { z } from 'zod';
import type { NlEngineAccess } from './access.js';
import { OllamaJudge } from './judge/ollama.js';
import { createNlPlugin } from './plugin.js';
import { NamespaceRulingsSchema } from './rulings/schema.js';

const JudgeSchema = z
  .object({
    baseUrl: z.url(),
    model: z.string().min(1),
    timeoutMs: z.number().int().positive().default(20_000)
  })
  .strict();

export const NlBootstrapConfigSchema = z
  .object({
    judge: JudgeSchema.optional(),
    rulings: z.record(z.string(), NamespaceRulingsSchema).optional(),
    packTtlMs: z.number().int().positive().default(300_000)
  })
  .strict();

export type NlBootstrapConfig = z.infer<typeof NlBootstrapConfigSchema>;

export interface NlHostDeps {
  nlEngine: NlEngineAccess;
}

export const bootstrap = defineBootstrap.kernel<NlBootstrapConfig, NlHostDeps>({
  schema: NlBootstrapConfigSchema,
  build: (config, deps) =>
    createNlPlugin({
      engine: deps.nlEngine,
      packTtlMs: config.packTtlMs,
      ...(config.judge !== undefined
        ? { judge: new OllamaJudge(config.judge), judgeTimeoutMs: config.judge.timeoutMs }
        : {}),
      ...(config.rulings !== undefined ? { rulings: config.rulings } : {})
    })
});

// The manifest loader requires a default-exported bootstrap function.
export default bootstrap;
