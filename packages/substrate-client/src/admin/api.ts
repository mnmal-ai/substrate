/** The admin-gated routes, typed. Each call needs an identity whose grant confers `admin`. */

import type { HttpTransport } from '../transport/http.js';
import { createSurgeryApi, type SurgeryApi } from './surgery.js';

export interface AdminKeyRow {
  readonly id: string;
  readonly kid: string;
  readonly name: string;
  readonly algorithm: string;
  /** Stored csv, as the route returns it; render with substrate-policy `describeGrant`. */
  readonly namespaces: string;
  readonly capabilities: string;
  readonly createdAt: string;
}

export interface AdminGrantChange {
  readonly kid: string;
  /** Grant entries, e.g. `['notes:read+mutate', 'tasks']`, as substrate-policy `encodeGrant` writes them. */
  readonly namespaces: readonly string[];
  /** The default capabilities a bare entry gets. */
  readonly capabilities: readonly string[];
  readonly widen?: boolean;
  readonly allowAdmin?: boolean;
  readonly allowUnknownNs?: boolean;
}

export interface AdminUpdateResult {
  readonly kid: string;
  readonly revoked: false;
  readonly namespaces: string[];
  readonly capabilities: string[];
}

export interface AdminRevokeResult {
  readonly kid: string;
  readonly revoked: true;
  readonly revokedAt: string;
}

export type AdminKeyAlgorithm = 'EdDSA' | 'RS256' | 'ES256';

export interface AdminRegisterInput {
  readonly kid: string;
  /** PEM text of the PUBLIC key. */
  readonly publicKey: string;
  readonly algorithm: AdminKeyAlgorithm;
  /** Omitted: the server uses the kid. */
  readonly name?: string;
  readonly namespaces: readonly string[];
  readonly capabilities: readonly string[];
  /** Omitted: the server writes the directory row when it has a directory configured. */
  readonly directory?: boolean;
  readonly allowAdmin?: boolean;
  readonly allowUnknownNs?: boolean;
}

export interface AdminRegisterResult {
  readonly kid: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly algorithm: AdminKeyAlgorithm;
  readonly namespaces: string[];
  readonly capabilities: string[];
  readonly replacedRevoked: boolean;
  /** The identity-directory row beside the credential, as the register route reports it. */
  readonly directory?: AdminRegisterDirectory;
}

/** `created: true` names the directory frame written; `false` says why none was
 *  (`not_configured`, `opted_out`). */
export type AdminRegisterDirectory =
  | { readonly created: true; readonly frame: string }
  | { readonly created: false; readonly reason: 'not_configured' | 'opted_out' };

export interface AdminInviteInput {
  readonly namespaces: readonly string[];
  readonly capabilities: readonly string[];
  /** Omitted: the server's default TTL. */
  readonly ttlMs?: number;
}

export interface AdminInviteResult {
  /** The one-time code. A secret until redeemed: never log or print it. */
  readonly code: string;
  readonly expiresAt: string;
  readonly namespaces: string[];
  readonly capabilities: string[];
}

export interface AdminApi extends SurgeryApi {
  /** GET /substrate/v1/_system/keys, paged to completion: a truncated key table is never silent. */
  keys(opts?: { signal?: AbortSignal }): Promise<AdminKeyRow[]>;
  /** PATCH of a key's grant. REPLACES both lists (namespaces and capabilities) with `change`'s; nothing is merged with what the key held. */
  update(change: AdminGrantChange, opts?: { signal?: AbortSignal }): Promise<AdminUpdateResult>;
  revoke(kid: string, opts?: { signal?: AbortSignal }): Promise<AdminRevokeResult>;
  register(
    input: AdminRegisterInput,
    opts?: { signal?: AbortSignal }
  ): Promise<AdminRegisterResult>;
  invite(input: AdminInviteInput, opts?: { signal?: AbortSignal }): Promise<AdminInviteResult>;
}

interface KeysPage {
  keys: AdminKeyRow[];
  hasMore?: boolean;
  nextCursor?: string;
}

export function createAdminApi(t: HttpTransport): AdminApi {
  return {
    ...createSurgeryApi(t),
    async keys(opts = {}) {
      const out: AdminKeyRow[] = [];
      let cursor: string | undefined;
      for (;;) {
        const qs = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
        const res = await t.raw(`/substrate/v1/_system/keys${qs}`, {
          method: 'GET',
          ...(opts.signal !== undefined ? { signal: opts.signal } : {})
        });
        const page = (await res.json()) as KeysPage;
        out.push(...page.keys);
        if (page.hasMore !== true) return out;
        if (typeof page.nextCursor !== 'string') {
          throw new Error(
            'server reported hasMore with no nextCursor — refusing to report a partial key table as complete'
          );
        }
        cursor = page.nextCursor;
      }
    },
    async update(change, opts = {}) {
      const body: Record<string, unknown> = {
        kid: change.kid,
        namespaces: [...change.namespaces],
        capabilities: [...change.capabilities]
      };
      if (change.widen === true) body.widen = true;
      if (change.allowAdmin === true) body.allowAdmin = true;
      if (change.allowUnknownNs === true) body.allowUnknownNs = true;
      const res = await t.raw('/substrate/v1/_system/keys', {
        method: 'PATCH',
        body,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {})
      });
      return (await res.json()) as AdminUpdateResult;
    },
    async revoke(kid, opts = {}) {
      const res = await t.raw('/substrate/v1/_system/keys', {
        method: 'PATCH',
        body: { kid, revoke: true },
        ...(opts.signal !== undefined ? { signal: opts.signal } : {})
      });
      return (await res.json()) as AdminRevokeResult;
    },
    async register(input, opts = {}) {
      const body: Record<string, unknown> = {
        kid: input.kid,
        publicKey: input.publicKey,
        algorithm: input.algorithm,
        namespaces: [...input.namespaces],
        capabilities: [...input.capabilities]
      };
      if (input.name !== undefined) body.name = input.name;
      if (input.directory !== undefined) body.directory = { create: input.directory };
      if (input.allowAdmin === true) body.allowAdmin = true;
      if (input.allowUnknownNs === true) body.allowUnknownNs = true;
      const res = await t.raw('/substrate/v1/_system/keys', {
        method: 'POST',
        body,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {})
      });
      return (await res.json()) as AdminRegisterResult;
    },
    async invite(input, opts = {}) {
      const body: Record<string, unknown> = {
        namespaces: [...input.namespaces],
        capabilities: [...input.capabilities]
      };
      if (input.ttlMs !== undefined) body.ttlMs = input.ttlMs;
      const res = await t.raw('/substrate/v1/_system/invites', {
        method: 'POST',
        body,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {})
      });
      return (await res.json()) as AdminInviteResult;
    }
  };
}
