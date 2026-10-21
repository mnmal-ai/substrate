/**
 * The per-namespace vocabulary the NL parser works from: every type and field
 * a question can name, the operators each field accepts, and which concrete
 * values belong to which field. Built deterministically from `schema`
 * plus a profile of the data, and keyed to `schemaVersion` so it can be
 * rebuilt when the schema moves.
 */
import type {
  NlNamespacePack,
  NlPackField,
  NlPackType,
  NlPackValueRef
} from '@mnmal-ai/substrate/sdk';

export type NamespacePack = NlNamespacePack;
export type PackType = NlPackType;
export type PackField = NlPackField;
export type PackValueRef = NlPackValueRef;

/** Distinct values observed per (type, field). `truncated` once past the cap. */
export interface NamespaceProfile {
  types: Record<string, Record<string, FieldProfile>>;
}

export interface FieldProfile {
  values: string[];
  truncated: boolean;
}
