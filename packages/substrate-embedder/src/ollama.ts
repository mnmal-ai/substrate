/**
 * OllamaEmbedder — sends `POST {baseUrl}/api/embed` with the modern Ollama
 * request shape `{ model, input, truncate }`. Returns the first row of the
 * `embeddings` array as Float32Array. Validates dimension. AbortController-
 * backed timeout. Throws `EmbedError` on every failure path so callers see a
 * typed error with a discriminated code.
 *
 * Use `/api/embed`, not the legacy `/api/embeddings`: the legacy endpoint
 * returns 200 with a degenerate vector for inputs past the context window
 * instead of truncating. `/api/embed` also returns L2-normalised vectors.
 *
 * Every request carries `num_ctx` and `num_batch` set to the model's context
 * length. Without them Ollama truncates at its default batch size (2048
 * tokens), not at the model's context, and says nothing.
 */
import { type Embedder, EmbedError, type EmbedOptions } from './types.js';

export interface OllamaEmbedderOptions {
  /** Ollama HTTP endpoint. Default: 'http://localhost:11434'. */
  baseUrl?: string;
  /** Model name. E.g. 'bge-small-en:v1.5'. Required. */
  model: string;
  /** Expected vector dimension. Validated at embed-time. Required. */
  dimension: number;
  /** Request timeout in ms. Default: 120000. Large because CPU-bound models
   * can take over 60s on long inputs. */
  timeoutMs?: number;
  /**
   * Context length in tokens, sent as `num_ctx` and `num_batch`. Default:
   * read once from `POST /api/show` (`model_info.<arch>.context_length`).
   */
  contextLength?: number;
}

export class OllamaEmbedder implements Embedder {
  readonly modelId: string;
  readonly dimension: number;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private contextLength: Promise<number> | undefined;

  constructor(opts: OllamaEmbedderOptions) {
    this.baseUrl = opts.baseUrl ?? 'http://localhost:11434';
    this.model = opts.model;
    this.dimension = opts.dimension;
    this.timeoutMs = opts.timeoutMs ?? 120000;
    this.modelId = `${opts.model}:${opts.dimension}`;
    if (opts.contextLength !== undefined) this.contextLength = Promise.resolve(opts.contextLength);
  }

  async embed(text: string, opts?: EmbedOptions): Promise<Float32Array> {
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const contextLength = await this.resolveContextLength(timeoutMs);
    const url = `${trimTrailingSlashes(this.baseUrl)}/api/embed`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `truncate: true` is the /api/embed default, set explicitly so an
        // Ollama default-flip cannot turn long inputs into failures.
        body: JSON.stringify({
          model: this.model,
          input: text,
          truncate: true,
          options: { num_ctx: contextLength, num_batch: contextLength }
        }),
        signal: controller.signal
      });
    } catch (err) {
      throw transportError(url, controller, timeoutMs, err);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const preview = await res.text().catch(() => '<unreadable>');
      throw new EmbedError(
        'unavailable',
        `OllamaEmbedder: POST ${url} returned ${res.status}: ${preview.slice(0, 200)}`
      );
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new EmbedError(
        'invalid_response',
        `OllamaEmbedder: response body was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }

    const embedding = this.extractEmbedding(body);
    if (embedding.length !== this.dimension) {
      throw new EmbedError(
        'invalid_response',
        `OllamaEmbedder: expected dimension ${this.dimension}, got ${embedding.length}`
      );
    }

    return Float32Array.from(embedding);
  }

  /** The model's context length, from the constructor or one `/api/show` call. */
  private resolveContextLength(timeoutMs: number): Promise<number> {
    if (this.contextLength === undefined) {
      this.contextLength = this.fetchContextLength(timeoutMs);
      // A failed lookup is retried on the next embed rather than cached.
      this.contextLength.catch(() => {
        this.contextLength = undefined;
      });
    }
    return this.contextLength;
  }

  private async fetchContextLength(timeoutMs: number): Promise<number> {
    const url = `${trimTrailingSlashes(this.baseUrl)}/api/show`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let body: unknown;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model }),
        signal: controller.signal
      });
      if (!res.ok) {
        const preview = await res.text().catch(() => '<unreadable>');
        throw new EmbedError(
          'unavailable',
          `OllamaEmbedder: POST ${url} returned ${res.status}: ${preview.slice(0, 200)}`
        );
      }
      body = await res.json();
    } catch (err) {
      if (err instanceof EmbedError) throw err;
      throw transportError(url, controller, timeoutMs, err);
    } finally {
      clearTimeout(timer);
    }
    const info = (body as { model_info?: unknown } | null)?.model_info;
    if (info !== null && typeof info === 'object') {
      for (const [key, value] of Object.entries(info)) {
        if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
          return value;
        }
      }
    }
    throw new EmbedError(
      'invalid_response',
      `OllamaEmbedder: ${url} reported no context length for '${this.model}'; set contextLength explicitly`
    );
  }

  private extractEmbedding(body: unknown): Array<number> {
    if (body === null || typeof body !== 'object') {
      throw new EmbedError('invalid_response', 'OllamaEmbedder: response body was not an object');
    }
    // /api/embed returns a batch: `embeddings: number[][]`. We send a single
    // input, so the vector is row 0. An empty outer array means no vector was
    // produced and is surfaced as a typed error.
    const embeddings = (body as { embeddings?: unknown }).embeddings;
    if (!Array.isArray(embeddings)) {
      throw new EmbedError(
        'invalid_response',
        "OllamaEmbedder: response missing 'embeddings' array"
      );
    }
    if (embeddings.length === 0) {
      throw new EmbedError(
        'invalid_response',
        'OllamaEmbedder: response contained empty embeddings (model returned no vector — input may exceed the context window with truncation disabled)'
      );
    }
    const first = embeddings[0];
    if (!Array.isArray(first) || first.some((v) => typeof v !== 'number')) {
      throw new EmbedError(
        'invalid_response',
        "OllamaEmbedder: response 'embeddings[0]' was not a numeric array"
      );
    }
    return first as Array<number>;
  }
}

/** `unavailable` for a failed request, naming the timeout when it was the abort. */
// A copy of substrate-types' trimTrailingSlashes: this package takes no dependencies.
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return url.slice(0, end);
}

function transportError(
  url: string,
  controller: AbortController,
  timeoutMs: number,
  err: unknown
): EmbedError {
  const detail = controller.signal.aborted
    ? `timed out after ${timeoutMs}ms`
    : `failed: ${err instanceof Error ? err.message : String(err)}`;
  return new EmbedError('unavailable', `OllamaEmbedder: POST ${url} ${detail}`, { cause: err });
}
