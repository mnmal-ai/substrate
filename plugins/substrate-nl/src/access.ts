import type { Query, Schema, SubstrateRequest } from '@mnmal-ai/substrate/sdk';

export interface NlEnvelope {
  data?: Record<string, unknown>;
  errors?: unknown[];
  _pagination?: Record<string, { nextCursor?: string; hasMore: boolean }>;
}

export interface NlEngineAccess {
  /** Live namespace schemas (with annotations). */
  federatedSchema(): Record<string, Schema>;
  /** The per-kind filter operator table for `ns`, or undefined when it has no dataset. */
  operators(ns: string): Record<string, readonly string[]> | undefined;
  /** Execute a frame under the caller's request context (identity, row policy, signal). */
  query(frame: Query, req: SubstrateRequest): Promise<NlEnvelope>;
}
