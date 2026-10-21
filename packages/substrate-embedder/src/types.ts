/**
 * Embedder interface: pluggable text-to-vector backend for Substrate's
 * semantic-recall surface. Implementations live
 * alongside this type (`./ollama.ts` for local Ollama, `./fake.ts` for
 * tests). Writers / readers depend on this interface, never on a concrete
 * class.
 */
export interface Embedder {
  /**
   * Identity of the model, INCLUDING dimension. Stored alongside each vector
   * in `embeddings.model`. MUST encode dimension so same-family-
   * different-dim (e.g. bge-small 384 vs bge-base 768) never collide in
   * the model column.
   *
   * Format: `<family>:<version>:<dim>`.
   * Examples: `bge-small-en:v1.5:384`, `fake:v1:384`.
   */
  readonly modelId: string;

  /** Must match the pgvector column type AND the suffix of modelId. */
  readonly dimension: number;

  /**
   * Embed a single text. Throws EmbedError on transport failure, timeout,
   * non-2xx response, malformed vector shape, or dimension mismatch.
   * Callers decide whether to continue on failure (write-path) or surface
   * to user (read-path).
   */
  embed(text: string, opts?: EmbedOptions): Promise<Float32Array>;
}

export interface EmbedOptions {
  /** Per-call timeout in ms, overriding the embedder's own default. */
  timeoutMs?: number;
}

export class EmbedError extends Error {
  override readonly name = 'EmbedError';
  constructor(
    readonly code: 'unavailable' | 'invalid_response',
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}
