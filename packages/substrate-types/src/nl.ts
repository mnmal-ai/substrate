/**
 * Natural-language translation primitives. Consumed by `@mnmal-ai/substrate-nl` and
 * by the `POST /substrate/v1/nl` binary route. Kept in substrate-types (zero-runtime) so
 * route handlers can reason about the shape without importing the NL agent
 * itself — the agent is optional at deploy time.
 *
 * `Query` mirrors the engine's frame grammar (qualified keys →
 * { params?, fields }); `fields` is `FieldInput` so the positional encoder
 * can reuse it verbatim.
 */

import type { FieldInput } from './schema.js';

/**
 * The engine-dispatchable frame a successful NL translation produces. Keys
 * are qualified (`<ns>/<TypeName>` or `<ns>/<mutationName>`) so the caller can
 * pass it straight to `engine.query({ frame })`.
 */
export type Query = Record<string, { params?: Record<string, unknown>; fields: FieldInput }>;

/**
 * In-context exemplar the NL agent embeds in the system prompt. Pairs the raw
 * user prompt with the target Query for few-shot grounding.
 */
export interface NLBase {
  prompt: string;
  query: Query;
  explanation?: string;
}

/**
 * The shape returned by `NLQueryAgent.translate`. `rawOutput` is the provider's
 * verbatim text (used for debugging + `_nl` diagnostics on the route response).
 */
export interface NLResult {
  query: Query;
  rawOutput: string;
  explanation?: string;
}

/**
 * Optional vocabulary hint block — maps a user-visible term (`"mellow"`) to a
 * concrete field/operator/value triple. The prompt builder renders it, but the
 * `POST /substrate/v1/nl` body does not expose it.
 */
export interface NLVocabularyHint {
  term: string;
  field: string;
  operator: string;
  value: unknown;
  notes?: string;
}
