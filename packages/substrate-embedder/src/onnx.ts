/**
 * OnnxEmbedder — in-process embedder via fastembed (which uses
 * onnxruntime-node + Hugging Face tokenizers under the hood).
 *
 * Runs the model in-process, avoiding the HTTP hop, serialisation and
 * scheduler queue of OllamaEmbedder.
 *
 * `fastembed` is deliberately NOT declared — not as a dependency, and not as
 * an optional peer: it pulls `onnxruntime-node` (~520MB), and GitHub Packages'
 * packument drops `peerDependenciesMeta`, so pnpm would treat an optional peer
 * as required and install it anyway. The import is deferred into `getEngine()`
 * so this module loads, type-checks and constructs on a host without it; only
 * a caller that actually embeds gets an error. The supported range lives in
 * the error message below and in the README.
 *
 * Trade-offs:
 *   - Requires `pnpm add fastembed` alongside substrate-embedder.
 *   - First embed() blocks on a one-time model download, cached at `cacheDir`.
 *   - Native module (onnxruntime-node) — can't be inlined by the bundler; must
 *     be installed alongside the bundled substrate binary or kept external.
 *   - Models are the fastembed-curated set (see `MODEL_MAP`).
 */

import { type Embedder, EmbedError, type EmbedOptions } from './types.js';

/**
 * Structural mirror of the fastembed surface this file uses, declared locally
 * rather than imported. An `import type` would put the specifier in the
 * emitted `.d.ts`, so a consumer who never installs fastembed would fail to
 * type-check against this package.
 */
interface FlagEmbeddingLike {
  embed(texts: string[], batchSize?: number): AsyncIterable<number[][]>;
}

interface FastembedModule {
  FlagEmbedding: {
    init(opts: {
      model: string;
      maxLength: number;
      executionProviders: string[];
      cacheDir?: string;
    }): Promise<FlagEmbeddingLike>;
  };
}

export interface OnnxEmbedderOptions {
  /**
   * Short model name. Mapped to a fastembed model id internally.
   * Supported: 'all-MiniLM-L6-v2', 'bge-small-en', 'bge-small-en-v1.5',
   * 'bge-base-en', 'bge-base-en-v1.5', 'multilingual-e5-large'.
   */
  model: string;
  /** Expected output dimension. Validated against the first embed result. */
  dimension: number;
  /**
   * Directory for downloaded ONNX files. fastembed's default is `local_cache`
   * relative to the working directory, so pass an absolute path.
   */
  cacheDir?: string;
  /** Max input tokens. Default 512 (bge-small standard). */
  maxLength?: number;
}

/**
 * Short name → fastembed `EmbeddingModel` value. The enum is a string enum, so
 * these literals ARE its values; spelling them out is what lets the mapping be
 * validated in the constructor without loading fastembed. Pinned by
 * `test/onnx-undeclared-backend.test.ts`, which compares these literals to the
 * real enum and fails if either side moves.
 */
const MODEL_MAP: Record<string, string> = {
  'all-MiniLM-L6-v2': 'fast-all-MiniLM-L6-v2',
  'bge-base-en': 'fast-bge-base-en',
  'bge-base-en-v1.5': 'fast-bge-base-en-v1.5',
  'bge-small-en': 'fast-bge-small-en',
  'bge-small-en-v1.5': 'fast-bge-small-en-v1.5',
  'multilingual-e5-large': 'fast-multilingual-e5-large'
};

/** fastembed's `ExecutionProvider.CPU`. Same string-enum reasoning as MODEL_MAP. */
const EXECUTION_PROVIDER_CPU = 'cpu';

export class OnnxEmbedder implements Embedder {
  readonly modelId: string;
  readonly dimension: number;
  private readonly modelKey: string;
  private readonly cacheDir: string | undefined;
  private readonly maxLength: number;
  private engine: FlagEmbeddingLike | null = null;
  private initPromise: Promise<FlagEmbeddingLike> | null = null;

  constructor(opts: OnnxEmbedderOptions) {
    const mapped = MODEL_MAP[opts.model];
    if (mapped === undefined) {
      throw new Error(
        `OnnxEmbedder: unknown model '${opts.model}'. Supported: ${Object.keys(MODEL_MAP).join(', ')}`
      );
    }
    this.modelKey = mapped;
    this.dimension = opts.dimension;
    this.cacheDir = opts.cacheDir;
    this.maxLength = opts.maxLength ?? 512;
    this.modelId = `${opts.model}:${opts.dimension}`;
  }

  /**
   * `opts.timeoutMs` bounds the wait, not the work: in-process inference
   * cannot be cancelled, so a timed-out embed still finishes in the background.
   */
  async embed(text: string, opts?: EmbedOptions): Promise<Float32Array> {
    const timeoutMs = opts?.timeoutMs;
    if (timeoutMs === undefined) return this.embedNow(text);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new EmbedError('unavailable', `OnnxEmbedder: timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    try {
      return await Promise.race([this.embedNow(text), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async embedNow(text: string): Promise<Float32Array> {
    const engine = await this.getEngine();
    const generator = engine.embed([text], 1);
    let first: number[] | undefined;
    for await (const batch of generator) {
      first = batch[0];
      break;
    }
    if (first === undefined) {
      throw new EmbedError('invalid_response', 'OnnxEmbedder: fastembed yielded no batches');
    }
    if (first.length !== this.dimension) {
      throw new EmbedError(
        'invalid_response',
        `OnnxEmbedder: expected ${this.dimension} dimensions, got ${first.length}`
      );
    }
    return new Float32Array(first);
  }

  /**
   * Lazy-init the underlying engine. First call imports fastembed,
   * and may then block on a model download; subsequent calls return the same
   * engine. Concurrent first calls share one `initPromise` so neither the
   * import nor the download is duplicated.
   */
  private async getEngine(): Promise<FlagEmbeddingLike> {
    if (this.engine !== null) return this.engine;
    if (this.initPromise === null) {
      this.initPromise = this.init().catch((err: unknown) => {
        this.initPromise = null;
        throw err;
      });
    }
    this.engine = await this.initPromise;
    return this.engine;
  }

  private async init(): Promise<FlagEmbeddingLike> {
    const { FlagEmbedding } = await loadFastembed();
    const initOpts: Parameters<FastembedModule['FlagEmbedding']['init']>[0] = {
      model: this.modelKey,
      maxLength: this.maxLength,
      executionProviders: [EXECUTION_PROVIDER_CPU]
    };
    if (this.cacheDir !== undefined) initOpts.cacheDir = this.cacheDir;
    try {
      return await FlagEmbedding.init(initOpts);
    } catch (err) {
      throw new EmbedError(
        'unavailable',
        `OnnxEmbedder: failed to initialize ${this.modelId}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
  }
}

/**
 * Import fastembed, translating "never installed" into an actionable
 * error rather than a bare MODULE_NOT_FOUND. Kept separate from `init` so the
 * two failure modes stay distinguishable: absent backend vs. broken backend.
 */
async function loadFastembed(): Promise<FastembedModule> {
  try {
    return (await import('fastembed')) as unknown as FastembedModule;
  } catch (err) {
    throw new EmbedError(
      'unavailable',
      "OnnxEmbedder requires 'fastembed' (^2.1.1), which is not installed. " +
        'Install it alongside @mnmal-ai/substrate-embedder (`pnpm add fastembed`), or use ' +
        'the ollama embedder instead. It is deliberately undeclared because it pulls ' +
        'onnxruntime-node (~520MB) and most deployments never use it.',
      { cause: err }
    );
  }
}
