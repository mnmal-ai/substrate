/**
 * FakeEmbedder — deterministic hash-based embeddings for tests. Produces
 * a repeatable Float32Array of the configured dimension from any input
 * string. Never calls out to a real embedder. modelId = `fake:v1:<dim>`
 * so test vectors never collide with real-model vectors when both land
 * in the same dev database.
 */
import { createHash } from 'node:crypto';
import type { Embedder } from './types.js';

export interface FakeEmbedderOptions {
  /** Output vector dimension. Default: 384 (matches bge-small-en). */
  dimension?: number;
}

export class FakeEmbedder implements Embedder {
  readonly modelId: string;
  readonly dimension: number;

  constructor(opts: FakeEmbedderOptions = {}) {
    this.dimension = opts.dimension ?? 384;
    this.modelId = `fake:v1:${this.dimension}`;
  }

  async embed(text: string): Promise<Float32Array> {
    // Seed a deterministic byte stream from a stable hash of the input.
    // Expand via repeated SHA-256 with an incrementing counter so the byte
    // stream is as long as needed for the requested dimension.
    const out = new Float32Array(this.dimension);
    let counter = 0;
    let filled = 0;
    while (filled < this.dimension) {
      const hash = createHash('sha256').update(`${counter}:${text}`).digest();
      // Consume 4 bytes per float. Map bytes → int32 → [-1, 1) float.
      for (let offset = 0; offset < hash.length && filled < this.dimension; offset += 4) {
        const int = hash.readInt32BE(offset);
        out[filled++] = int / 2_147_483_648; // divide by 2^31
      }
      counter++;
    }
    return out;
  }
}
