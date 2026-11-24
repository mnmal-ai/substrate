/**
 * OnnxEmbedder — in-process embedder on onnxruntime-node and the Hugging Face
 * tokenizer.
 *
 * Runs the model in-process, avoiding the HTTP hop, serialisation and
 * scheduler queue of OllamaEmbedder.
 *
 * Its two backends, `onnxruntime-node` and `@huggingface/tokenizers`, are
 * deliberately NOT declared — not as dependencies, and not as optional peers:
 * onnxruntime-node is about 300MB, and GitHub Packages' packument drops
 * `peerDependenciesMeta`, so pnpm would treat an optional peer as required and
 * install it anyway. The imports are deferred into `getEngine()` so this
 * module loads, type-checks and constructs on a host without them; only a
 * caller that actually embeds gets an error. The supported ranges live in the
 * error message below and in the README.
 *
 * Trade-offs:
 *   - Requires `pnpm add onnxruntime-node @huggingface/tokenizers` alongside
 *     substrate-embedder.
 *   - First embed() blocks on a one-time model download, cached at `cacheDir`.
 *   - Native module (onnxruntime-node) — can't be inlined by the bundler; must
 *     be installed alongside the bundled substrate binary or kept external.
 *   - Models are the set in `MODELS`, each from its Qdrant ONNX repository.
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type Embedder, EmbedError, type EmbedOptions } from './types.js';

/**
 * Structural mirrors of the two backends' surfaces this file uses, declared
 * locally rather than imported. An `import type` would put the specifier in
 * the emitted `.d.ts`, so a consumer who never installs them would fail to
 * type-check against this package.
 */
interface TensorLike {
  data: Float32Array;
  dims: readonly number[];
}
interface SessionLike {
  inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, TensorLike>>;
}
interface OrtModule {
  InferenceSession: {
    create(
      path: string,
      opts: { executionProviders: string[]; graphOptimizationLevel: string }
    ): Promise<SessionLike>;
  };
  Tensor: new (type: 'int64', data: BigInt64Array, dims: number[]) => unknown;
}
interface TokenizerLike {
  encode(
    text: string,
    opts: { return_token_type_ids: true }
  ): { ids: number[]; token_type_ids: number[] };
}
interface TokenizersModule {
  Tokenizer: new (tokenizer: object, config: object) => TokenizerLike;
}

export interface OnnxEmbedderOptions {
  /**
   * Short model name.
   * Supported: 'all-MiniLM-L6-v2', 'bge-small-en', 'bge-small-en-v1.5',
   * 'bge-base-en', 'bge-base-en-v1.5', 'multilingual-e5-large'.
   */
  model: string;
  /** Expected output dimension. Validated against the first embed result. */
  dimension: number;
  /**
   * Directory for downloaded ONNX files. The default is `local_cache`
   * relative to the working directory, so pass an absolute path.
   */
  cacheDir?: string;
  /** Max input tokens. Default 512, and never more than the model's own limit. */
  maxLength?: number;
}

interface ModelSource {
  /** Hugging Face repository holding the ONNX export. */
  repo: string;
  modelFile: string;
  /** Files the model file loads from beside itself. */
  additionalFiles?: string[];
  /** How token vectors become one vector: the first token's, or their mean. */
  pooling: 'cls' | 'mean';
}

/**
 * Short name → where its ONNX export lives and how it pools. The repositories,
 * files and pooling are the ones fastembed 3.0.0 used, so a vector made here
 * matches one made there and a model cache directory carries over.
 */
const MODELS: Record<string, ModelSource> = {
  'all-MiniLM-L6-v2': {
    repo: 'Qdrant/all-MiniLM-L6-v2-onnx',
    modelFile: 'model.onnx',
    pooling: 'mean'
  },
  'bge-base-en': {
    repo: 'Qdrant/fast-bge-base-en',
    modelFile: 'model_optimized.onnx',
    pooling: 'cls'
  },
  'bge-base-en-v1.5': {
    repo: 'Qdrant/bge-base-en-v1.5-onnx-Q',
    modelFile: 'model_optimized.onnx',
    pooling: 'cls'
  },
  'bge-small-en': {
    repo: 'Qdrant/bge-small-en',
    modelFile: 'model_optimized.onnx',
    pooling: 'cls'
  },
  'bge-small-en-v1.5': {
    repo: 'Qdrant/bge-small-en-v1.5-onnx-Q',
    modelFile: 'model_optimized.onnx',
    pooling: 'cls'
  },
  'multilingual-e5-large': {
    repo: 'Qdrant/multilingual-e5-large-onnx',
    modelFile: 'model.onnx',
    additionalFiles: ['model.onnx_data'],
    pooling: 'mean'
  }
};

const TOKENIZER_FILES = ['tokenizer.json', 'tokenizer_config.json'];
const DEFAULT_CACHE_DIR = 'local_cache';

/** A loaded model: its tokenizer, its session and what the session expects. */
interface Engine {
  tokenizer: TokenizerLike;
  session: SessionLike;
  ort: OrtModule;
  maxLength: number;
}

export class OnnxEmbedder implements Embedder {
  readonly modelId: string;
  readonly dimension: number;
  private readonly source: ModelSource;
  private readonly cacheDir: string;
  private readonly maxLength: number;
  private engine: Engine | null = null;
  private initPromise: Promise<Engine> | null = null;

  constructor(opts: OnnxEmbedderOptions) {
    const source = Object.hasOwn(MODELS, opts.model) ? MODELS[opts.model] : undefined;
    if (source === undefined) {
      throw new Error(
        `OnnxEmbedder: unknown model '${opts.model}'. Supported: ${Object.keys(MODELS).join(', ')}`
      );
    }
    this.source = source;
    this.dimension = opts.dimension;
    this.cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
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
    const { tokenizer, session, ort, maxLength } = await this.getEngine();
    const encoded = tokenizer.encode(text, { return_token_type_ids: true });
    // Truncation keeps the closing special token, as the model was trained with it.
    const cut = <T>(xs: T[]): T[] =>
      xs.length <= maxLength ? xs : [...xs.slice(0, maxLength - 1), xs[xs.length - 1] as T];
    const ids = cut(encoded.ids);
    const tensor = (xs: number[]): unknown =>
      new ort.Tensor('int64', BigInt64Array.from(xs, BigInt), [1, xs.length]);
    const feeds: Record<string, unknown> = {
      input_ids: tensor(ids),
      // One text and no padding, so every token is attended to.
      attention_mask: tensor(ids.map(() => 1))
    };
    if (session.inputNames.includes('token_type_ids')) {
      feeds.token_type_ids = tensor(cut(encoded.token_type_ids));
    }
    const hidden = (await session.run(feeds)).last_hidden_state;
    if (hidden === undefined) {
      throw new EmbedError('invalid_response', 'OnnxEmbedder: the model returned no hidden state');
    }
    const [, tokens = 0, width = 0] = hidden.dims;
    if (width !== this.dimension) {
      throw new EmbedError(
        'invalid_response',
        `OnnxEmbedder: expected ${this.dimension} dimensions, got ${width}`
      );
    }
    const out = new Float32Array(width);
    const pooled = this.source.pooling === 'cls' ? 1 : tokens;
    for (let t = 0; t < pooled; t++) {
      for (let i = 0; i < width; i++)
        out[i] = (out[i] as number) + (hidden.data[t * width + i] as number);
    }
    let norm = 0;
    for (let i = 0; i < width; i++) {
      out[i] = (out[i] as number) / Math.max(pooled, 1);
      norm += (out[i] as number) ** 2;
    }
    const scale = Math.max(Math.sqrt(norm), 1e-12);
    for (let i = 0; i < width; i++) out[i] = (out[i] as number) / scale;
    return out;
  }

  /**
   * Lazy-init the underlying engine. First call imports the backends, and may
   * then block on a model download; subsequent calls return the same engine.
   * Concurrent first calls share one `initPromise` so neither the import nor
   * the download is duplicated.
   */
  private async getEngine(): Promise<Engine> {
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

  private async init(): Promise<Engine> {
    const { ort, tokenizers } = await loadBackends();
    try {
      const dir = await this.fetchModel();
      const read = (file: string): Record<string, unknown> =>
        JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
      const config = read('tokenizer_config.json');
      const limit = config.model_max_length;
      const session = await ort.InferenceSession.create(join(dir, this.source.modelFile), {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all'
      });
      return {
        tokenizer: new tokenizers.Tokenizer(read('tokenizer.json'), config),
        session,
        ort,
        maxLength: typeof limit === 'number' ? Math.min(this.maxLength, limit) : this.maxLength
      };
    } catch (err) {
      throw new EmbedError(
        'unavailable',
        `OnnxEmbedder: failed to initialize ${this.modelId}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
  }

  /**
   * The model's directory under `cacheDir`, with every file it needs. A file
   * already there is kept, so an interrupted download resumes with the rest.
   */
  private async fetchModel(): Promise<string> {
    const { repo, modelFile, additionalFiles = [] } = this.source;
    const dir = join(this.cacheDir, repo.replace('/', '_'));
    const endpoint = process.env.HF_ENDPOINT || 'https://huggingface.co';
    for (const file of [modelFile, ...additionalFiles, ...TOKENIZER_FILES]) {
      const path = join(dir, file);
      if (existsSync(path)) continue;
      const url = `${endpoint}/${repo}/resolve/main/${file}`;
      const response = await fetch(url);
      if (!response.ok || response.body === null) {
        throw new Error(`failed to download ${url}: ${response.status} ${response.statusText}`);
      }
      // Written beside its final name first: a partial file is never taken for a whole one.
      const partial = `${path}.part`;
      mkdirSync(dirname(path), { recursive: true });
      try {
        await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial));
      } catch (err) {
        rmSync(partial, { force: true });
        throw err;
      }
      renameSync(partial, path);
    }
    return dir;
  }
}

/**
 * Import the two backends, translating "never installed" into an actionable
 * error rather than a bare MODULE_NOT_FOUND. Kept separate from `init` so the
 * two failure modes stay distinguishable: absent backend vs. broken backend.
 */
async function loadBackends(): Promise<{ ort: OrtModule; tokenizers: TokenizersModule }> {
  try {
    const [ort, tokenizers] = await Promise.all([
      import('onnxruntime-node'),
      import('@huggingface/tokenizers')
    ]);
    return {
      ort: ort as unknown as OrtModule,
      tokenizers: tokenizers as unknown as TokenizersModule
    };
  } catch (err) {
    throw new EmbedError(
      'unavailable',
      "OnnxEmbedder requires 'onnxruntime-node' (^1.30.0) and '@huggingface/tokenizers' (^0.2.0), " +
        'which are not installed. Install them alongside @mnmal-ai/substrate-embedder ' +
        '(`pnpm add onnxruntime-node @huggingface/tokenizers`), or use the ollama embedder ' +
        'instead. They are deliberately undeclared because onnxruntime-node is about 300MB ' +
        'and most deployments never use it.',
      { cause: err }
    );
  }
}
