/**
 * Structured error types for schema proposals.
 *
 * ProposalError carries a stable code string so NL agents and SDK clients can dispatch
 * on error.code without parsing human-readable messages. Details hold context-specific
 * metadata for recovery or logging.
 */

import { ResolverFrameError } from '@mnmal-ai/substrate-types';

export type ProposalErrorCode =
  | 'type_already_exists'
  | 'type_already_proposed'
  | 'field_already_exists'
  | 'destructive_change_required'
  | 'unknown_type'
  | 'unowned_namespace'
  | 'invalid_field_spec'
  | 'invalid_params'
  // propose_namespace error codes
  | 'invalid_namespace'
  | 'namespace_already_proposed'
  | 'namespace_retired'
  | 'dataset_not_provisioned'
  | 'engine_not_wired'
  // propose_index error codes
  | 'index_on_code_defined_type'
  | 'unknown_index'
  | 'not_engine_owned'
  | 'unique_index'
  | 'still_desired'
  | 'unknown_recommendation'
  | 'recommendation_closed'
  | 'recommendation_stale';

/**
 * Structured error for proposal operations with stable error codes.
 *
 * Supports wire serialization via toJSON() for consistent error handling
 * across HTTP boundaries.
 */
export class ProposalError extends ResolverFrameError {
  override readonly name = 'ProposalError';
  override readonly code: ProposalErrorCode;
  override readonly details: Record<string, unknown>;

  // A ResolverFrameError, so the engine reports `code` in the envelope (and
  // rolls the transaction back) rather than answering `internal_error`. The
  // engine sends `details` to the caller verbatim, so an underlying error goes
  // in `options.cause`, which stays server-side, never in `details`.
  constructor(
    code: ProposalErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options: { cause?: unknown } = {}
  ) {
    super(code, message, details);
    this.code = code;
    this.details = details;
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: options.cause, enumerable: false });
    }
    Object.setPrototypeOf(this, ProposalError.prototype);
  }

  toJSON(): {
    error: ProposalErrorCode;
    message: string;
    details: Record<string, unknown>;
  } {
    return {
      error: this.code,
      message: this.message,
      details: this.details
    };
  }
}
