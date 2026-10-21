/**
 * Bridge federation — remote Substrate instance represented locally. Spec §5.8.
 *
 * A `BridgeClient` is the per-remote transport surface: schema fetch, proxied
 * query/mutate, per-row read for sweep resolveTarget, health probe. Concrete
 * impls live in @mnmal-ai/substrate-core (`HttpBridgeClient`); application code
 * constructs and registers them.
 *
 * The registry (`BridgeRegistry`, declared in `./sweep.js`) maps a local
 * namespace alias (e.g. `'cal'`) to a `BridgeClient`. The alias is the key
 * callers use to address the bridge in frames.
 */

import type { Row } from './core.js';
import type { EdgeRef } from './edge.js';
import type { PackEnvelope, Schema } from './schema.js';

/**
 * Per-frame bucket sent to a bridge. Same shape as `QualifiedFrame` in the
 * engine; redeclared here so types has no dependency on core.
 */
export type BridgeFrame = Record<
  string,
  {
    params?: Record<string, unknown>;
    fields?: Record<string, unknown>;
    idempotencyKey?: string;
  }
>;

export interface BridgeClient {
  readonly name: string;
  readonly baseUrl: string;
  /** Fetches the remote's federated schema. Throws `BridgeUnreachableError` on network failure. */
  federatedSchema(): Promise<Record<string, Schema>>;
  /** Proxy a query frame to the remote. */
  query(frame: BridgeFrame): Promise<PackEnvelope>;
  /** Proxy a mutate frame to the remote. */
  mutate(frame: BridgeFrame): Promise<PackEnvelope>;
  /**
   * Read a single row by (type, id) from a remote namespace. Used by sweep's
   * resolveTarget to classify EXISTS/DELETED/MISSING for bridged edges.
   * Returns null if the row doesn't exist. Throws `BridgeUnreachableError`
   * when the remote can't be reached at all.
   */
  readRow(ref: EdgeRef): Promise<Row | null>;
  /**
   * Fast-path health signal. Returns the cached reachability verdict from the
   * last probe — the bridge runs periodic health checks and updates this.
   */
  isReachable(): boolean;
  /** Release any timers / pending work. Idempotent. */
  dispose(): void;
}

/**
 * Credential a bridge presents to its remote. Carries references only — a path
 * to key material and the registered principal — never the key itself, so the
 * shape is safe to hold in config and log-adjacent structures.
 */
export interface BridgeCredential {
  /** Path to an Ed25519 private key in PEM form. */
  keyPath: string;
  /** Registered kid at the remote — the principal this bridge authenticates as. */
  kid: string;
  /**
   * Expected URL origin of the remote this credential may be presented to,
   * as `scheme://host[:port]` (compare with `new URL(url).origin`, never by
   * raw string — trailing slashes and default ports would produce false
   * mismatches).
   *
   * REQUIRED, with no opt-out. Discovery supplies the bridge URL off the
   * wire, so without an origin binding an injected topology entry naming a
   * provisioned coordinator would redirect a signed bearer token to an
   * attacker-controlled host.
   */
  origin: string;
}

/**
 * Credential lookup, keyed by COORDINATOR name (not namespace) — one
 * coordinator may serve several namespaces under one credential, per §5.8's
 * "one bridge registration, one set of credentials".
 *
 * This is the federation allowlist. A miss means no bridge is formed at all,
 * which is what makes discovery non-authoritative: a topology entry naming an
 * unprovisioned peer cannot cause traffic to flow to it. The credential's
 * `origin` completes that property — a hit still forms no bridge unless the
 * advertised URL matches the origin the credential was provisioned for.
 */
export interface BridgeCredentialStore {
  get(bridgeName: string): BridgeCredential | undefined;
}
