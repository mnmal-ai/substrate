import type { AdminEnv } from '@mnmal-ai/substrate/client';
import {
  type AdminKeyRow,
  type NlApi,
  noRedirectFetch,
  SubstrateClient,
  tokenAudience
} from '@mnmal-ai/substrate/client';
import type { RuntimeErrors, RuntimeMetrics, Schema } from '@mnmal-ai/substrate/sdk';
import { type AdminSession, adminIdleMs, createAdminSession } from './admin/session.js';
import type { TuiConfig } from './config.js';

export interface TuiDeps {
  endpoint: string;
  project: string;
  /** Initial namespace. */
  namespace: string;
  nl: NlApi;
  federatedSchema(): Promise<Record<string, Schema>>;
  /** GET a public-or-authed substrate path with the client's identity; resolves the parsed JSON or throws. */
  getJson(path: string, signal?: AbortSignal): Promise<unknown>;
  /** GET /substrate/v1/metrics. A failure carries the HTTP `status` when there was one. */
  metrics(signal?: AbortSignal): Promise<RuntimeMetrics>;
  /** GET /substrate/v1/errors (admin). A failure carries the HTTP `status` when there was one. */
  errors(signal?: AbortSignal): Promise<RuntimeErrors>;
  readonly admin: AdminSession;
  readonly adminEnv: AdminEnv;
  /** The agent identity's Authorization value, or null when anonymous. */
  readonly agentAuthorization: (() => string) | null;
  /** GET /substrate/v1/_system/keys as the AGENT identity (403 unless its grant confers admin). */
  keys(signal?: AbortSignal): Promise<AdminKeyRow[]>;
}

/** An HTTP failure from `getJson`: `status` is what `NetworkError` and `AuthError` also carry. */
export class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number, path: string) {
    super(`${status} from ${path}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

const sig = (signal: AbortSignal | undefined) => (signal !== undefined ? { signal } : {});

export function makeDeps(
  config: TuiConfig,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env
): TuiDeps {
  const token = config.token;
  const adminNamed = [
    'SUBSTRATE_ADMIN_TOKEN',
    'SUBSTRATE_ADMIN_KEY_PATH',
    'SUBSTRATE_ADMIN_KEY_ID'
  ];
  if (token !== null || adminNamed.some((k) => (env[k] ?? '') !== ''))
    tokenAudience(config.endpoint);
  fetchImpl = noRedirectFetch(fetchImpl);
  // The admin key can also come from its default path at unlock, so its requests check the target themselves.
  const adminFetch: typeof fetch = (input, init) => {
    tokenAudience(config.endpoint);
    return fetchImpl(input, init);
  };
  const client = new SubstrateClient({
    endpoint: config.endpoint,
    ...(config.token !== null ? { getToken: config.token } : {}),
    fetch: fetchImpl,
    // The default sink is console.warn, which would scribble over the Ink screen.
    onDiagnostics: () => {}
  });
  const admin = createAdminSession({
    endpoint: config.endpoint,
    idleMs: adminIdleMs(env),
    fetch: adminFetch
  });
  return {
    endpoint: config.endpoint,
    project: config.project,
    namespace: config.namespace,
    nl: client.nl,
    federatedSchema: () => client.federatedSchema(),
    metrics: (signal) => client.metrics(sig(signal)),
    // While unlocked, /dash reads the error log as the admin identity, without resetting the idle clock; locked, as the configured identity.
    errors: (signal) =>
      admin.unlocked()
        ? admin.run(({ client: c }) => c.errors(sig(signal)), { touch: false })
        : client.errors(sig(signal)),
    admin,
    adminEnv: {
      ...(env.SUBSTRATE_ADMIN_TOKEN !== undefined
        ? { SUBSTRATE_ADMIN_TOKEN: env.SUBSTRATE_ADMIN_TOKEN }
        : {}),
      ...(env.SUBSTRATE_ADMIN_KEY_PATH !== undefined
        ? { SUBSTRATE_ADMIN_KEY_PATH: env.SUBSTRATE_ADMIN_KEY_PATH }
        : {}),
      ...(env.SUBSTRATE_ADMIN_KEY_ID !== undefined
        ? { SUBSTRATE_ADMIN_KEY_ID: env.SUBSTRATE_ADMIN_KEY_ID }
        : {}),
      ...(env.SUBSTRATE_ADMIN_CAPABILITY !== undefined
        ? { SUBSTRATE_ADMIN_CAPABILITY: env.SUBSTRATE_ADMIN_CAPABILITY }
        : {}),
      ...(env.HOME !== undefined ? { HOME: env.HOME } : {})
    },
    agentAuthorization: token !== null ? () => `Bearer ${token()}` : null,
    keys: (signal) => client.admin.keys(sig(signal)),
    async getJson(path, signal) {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (config.token !== null) headers.authorization = `Bearer ${config.token()}`;
      const res = await fetchImpl(`${config.endpoint}${path}`, {
        headers,
        ...sig(signal)
      });
      if (!res.ok) throw new HttpStatusError(res.status, path);
      return res.json();
    }
  };
}
