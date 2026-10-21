/**
 * Optional agent-identity JWT provider for the MCP client. When
 * SUBSTRATE_AGENT_KEY_PATH (path to an Ed25519 private PEM) + SUBSTRATE_AGENT_KEY_ID are
 * set, returns a cached short-TTL EdDSA JWT (refreshed before expiry) that the
 * stack verifies in attribute mode → createdBy:{kind:'agent', id:<kid>}.
 * Returns null when neither is set (the MCP client then sends no Authorization);
 * setting only one throws.
 *
 * Fail-loud by design: a SET-but-missing/malformed SUBSTRATE_AGENT_KEY_PATH
 * throws at provider construction, crashing MCP startup — misconfiguration
 * must not silently degrade to anonymous writes.
 */

import { DEFAULT_CAPABILITIES, makeAuthorizationProvider } from '@mnmal-ai/substrate-policy';

/**
 * The capabilities THIS CLIENT asks for, from `SUBSTRATE_AGENT_CAPABILITIES` (csv),
 * defaulting to `substrate-policy`'s own default rather than a second copy of it.
 *
 * Not simply `ADMIN_CAPABILITIES`: for a DATASET-registry key the row
 * intersects the claim, but a FILE-registry key takes the claim VERBATIM, so
 * a wider default would promote every MCP agent on such a deployment to
 * admin. Widen it only where an operator says so.
 */
export function resolveAgentCapabilities(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const raw = env.SUBSTRATE_AGENT_CAPABILITIES;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_CAPABILITIES;
  const parsed = raw
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  // An env var set to punctuation is a misconfiguration, not a request for an
  // empty grant — and an empty claim intersects to nothing, which would read as
  // a broken credential rather than a typo.
  return parsed.length > 0 ? parsed : DEFAULT_CAPABILITIES;
}

/**
 * Returns a provider that yields `Bearer <jwt>` (the full Authorization header
 * value) when SUBSTRATE_AGENT_KEY_PATH + SUBSTRATE_AGENT_KEY_ID are set, or null when
 * unconfigured so callers can skip the header entirely.
 */
export function makeAgentJwtProvider(
  env: NodeJS.ProcessEnv,
  audience?: string
): () => string | null {
  const keyPath = env.SUBSTRATE_AGENT_KEY_PATH;
  const kid = env.SUBSTRATE_AGENT_KEY_ID;
  const hasPath = keyPath !== undefined && keyPath !== '';
  const hasKid = kid !== undefined && kid !== '';
  if (!hasPath && !hasKid) return () => null;
  // Half a credential signs nothing; refuse rather than write anonymously.
  if (!hasPath || !hasKid) {
    throw new Error(
      `SUBSTRATE_AGENT_KEY_PATH and SUBSTRATE_AGENT_KEY_ID must be set together; only ${hasPath ? 'SUBSTRATE_AGENT_KEY_PATH' : 'SUBSTRATE_AGENT_KEY_ID'} is set`
    );
  }
  // A SET-but-broken key must crash MCP startup rather than silently degrade to
  // anonymous writes. The provider reads and parses the key at construction,
  // so this line is the guard.
  const provider = makeAuthorizationProvider(
    { keyPath: keyPath as string, kid: kid as string },
    {
      capabilities: resolveAgentCapabilities(env),
      ...(audience !== undefined ? { audience } : {})
    }
  );
  return () => provider();
}
