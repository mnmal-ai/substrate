import { DEFAULT_CAPABILITIES, makeTokenProvider } from '@mnmal-ai/substrate-policy';
import { trimTrailingSlashes } from '@mnmal-ai/substrate-types';
import { SubstrateClient, type SubstrateClientOptions } from './client.js';
import { noRedirectFetch, tokenAudience } from './token-target.js';

/**
 * The capabilities a client asks for, from `SUBSTRATE_AGENT_CAPABILITIES` (csv),
 * defaulting to `substrate-policy`'s default.
 *
 * Not `ADMIN_CAPABILITIES`: a dataset-registry key intersects the claim, but a
 * file-registry key takes it verbatim, so a wider default would promote every
 * agent on such a deployment to admin.
 */
export function resolveAgentCapabilities(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const raw = env.SUBSTRATE_AGENT_CAPABILITIES;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_CAPABILITIES;
  const parsed = raw
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  // Punctuation only is a typo, not a request for an empty grant.
  return parsed.length > 0 ? parsed : DEFAULT_CAPABILITIES;
}

export interface ClientFromEnvOptions
  extends Omit<SubstrateClientOptions, 'endpoint' | 'token' | 'getToken'> {
  env?: NodeJS.ProcessEnv;
  /** Allow an unsigned client when no signing key is configured. Default false. */
  allowAnonymous?: boolean;
}

export interface ClientFromEnv {
  client: SubstrateClient;
  endpoint: string;
  /** The signing kid, or null for an anonymous client. */
  kid: string | null;
}

/**
 * Builds a client from `SUBSTRATE_URL` and `SUBSTRATE_AGENT_KEY_ID` +
 * `SUBSTRATE_AGENT_KEY_PATH`, signing every request as that kid.
 *
 * Redirects are refused and the token's audience is the endpoint's origin.
 *
 * @throws Error when `SUBSTRATE_URL` is unset or unsafe for a credential, when
 *   only one of the key pair is set, when the key cannot be read, or when no
 *   key is set and `allowAnonymous` is not.
 */
export function createClientFromEnv(opts: ClientFromEnvOptions = {}): ClientFromEnv {
  const { env = process.env, allowAnonymous = false, fetch: fetchImpl, ...rest } = opts;
  const endpoint = trimTrailingSlashes(env.SUBSTRATE_URL ?? '');
  if (endpoint === '') throw new Error('SUBSTRATE_URL is required');
  const keyPath = env.SUBSTRATE_AGENT_KEY_PATH ?? '';
  const kid = env.SUBSTRATE_AGENT_KEY_ID ?? '';
  if ((keyPath === '') !== (kid === '')) {
    throw new Error(
      `SUBSTRATE_AGENT_KEY_PATH and SUBSTRATE_AGENT_KEY_ID must be set together; only ${keyPath !== '' ? 'SUBSTRATE_AGENT_KEY_PATH' : 'SUBSTRATE_AGENT_KEY_ID'} is set`
    );
  }
  const base = { ...rest, endpoint, fetch: noRedirectFetch(fetchImpl) };
  if (kid === '') {
    // Reads-open stacks answer anonymous reads, so an unsigned client looks configured.
    if (!allowAnonymous) {
      throw new Error(
        'no signing key: set SUBSTRATE_AGENT_KEY_ID and SUBSTRATE_AGENT_KEY_PATH, or pass allowAnonymous'
      );
    }
    return { client: new SubstrateClient(base), endpoint, kid: null };
  }
  const getToken = makeTokenProvider(
    { keyPath, kid },
    { capabilities: resolveAgentCapabilities(env), audience: tokenAudience(endpoint) }
  );
  return { client: new SubstrateClient({ ...base, getToken }), endpoint, kid };
}
