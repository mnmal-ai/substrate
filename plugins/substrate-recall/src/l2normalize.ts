/**
 * L2 normalisation for the crystallise input path.
 *
 * A byte-for-byte copy of `l2normalize` in `@mnmal-ai/holomap-clusterer`'s
 * `npm/test/fixture.ts`, because the corpus regression gate measures against
 * figures that function produced; the clustering pipeline is sensitive enough
 * that an equivalent-in-the-limit function is not the same function.
 *
 * `sum` accumulates in f64 over the f32 values and only re-rounds on store.
 * Do NOT "simplify" this to operate on the pre-cast values: it looks like a
 * cleanup and changes the results.
 */
export function l2normalize(vectors: readonly Float32Array[]): Float32Array[] {
  return vectors.map((v) => {
    let sum = 0;
    for (const x of v) sum += x * x;
    const norm = Math.sqrt(sum);
    if (norm === 0) return new Float32Array(v);
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
    return out;
  });
}
