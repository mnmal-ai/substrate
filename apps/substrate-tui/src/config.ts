import { basename } from 'node:path';
import { DEFAULT_CAPABILITIES, makeTokenProvider, tokenAudience } from '@mnmal-ai/substrate/client';
import { trimTrailingSlashes } from '@mnmal-ai/substrate/sdk';

export interface TuiConfig {
  endpoint: string;
  namespace: string;
  project: string;
  /** Bare-JWT provider, or null when no agent identity is configured (anonymous). */
  token: (() => string) | null;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function readConfig(env: NodeJS.ProcessEnv, cwd: string): TuiConfig | { error: string } {
  const endpoint = trimTrailingSlashes(env.SUBSTRATE_URL ?? '');
  if (endpoint === '')
    return { error: 'SUBSTRATE_URL is required (e.g. https://substrate.example.com:3100)' };
  const namespace = env.SUBSTRATE_NAMESPACE ?? '';
  if (namespace === '')
    return { error: 'SUBSTRATE_NAMESPACE is required (the namespace to watch)' };
  const keyPath = env.SUBSTRATE_AGENT_KEY_PATH;
  const kid = env.SUBSTRATE_AGENT_KEY_ID;
  let token: (() => string) | null = null;
  if (keyPath !== undefined && keyPath !== '' && kid !== undefined && kid !== '') {
    const raw = env.SUBSTRATE_AGENT_CAPABILITIES?.split(',')
      .map((c) => c.trim())
      .filter((c) => c !== '');
    try {
      token = makeTokenProvider(
        { keyPath, kid },
        {
          capabilities: raw !== undefined && raw.length > 0 ? raw : DEFAULT_CAPABILITIES,
          audience: tokenAudience(endpoint)
        }
      );
    } catch (err) {
      return { error: `agent identity: ${message(err)}` };
    }
  }
  return { endpoint, namespace, project: basename(cwd), token };
}
