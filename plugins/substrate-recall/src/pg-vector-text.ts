/**
 * pgvector wire helpers, shared by PgEmbeddingsStore and PgClusterStore.
 *
 * pgvector parses a text literal `[v1,v2,...,vN]`; Float32Array is not a
 * recognised postgres.js parameter, so callers convert before interpolation
 * and cast inside SQL.
 */

export function vectorLiteral(v: Float32Array): string {
  return `[${Array.from(v).join(',')}]`;
}

export function parseVectorText(text: string): Float32Array {
  const parts = text.replace(/^\[|\]$/g, '').split(',');
  const out = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i]);
  return out;
}
