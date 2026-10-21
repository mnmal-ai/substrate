/**
 * `substrate federate join` — redeem an enrollment token on the caller.
 *
 * The ordering below IS the safety property:
 *
 *   check key-out clobber → generate keypair in memory → redeem → write key
 *
 * Checking the output path after redemption would burn a single-use invite
 * with nowhere to put the resulting key. And a generated-but-unregistered key
 * is strictly worse than no key: the tooling then signs with something the
 * peer rejects, so every read fails auth rather than degrading cleanly. Any
 * failure here leaves the filesystem untouched.
 */

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, hostname as osHostname } from 'node:os';
import { dirname, join as pathJoin } from 'node:path';
import { AdminCliError } from '../../admin/errors.js';
import { type HttpJsonFn, httpJson } from './http.js';
import { decodeJoinToken } from './token.js';

export interface JoinArgs {
  token: string;
  name: string | undefined;
  keyOut: string | undefined;
}

export interface JoinResult {
  origin: string;
  name: string;
  /** Server-generated at the callee — `registerRoute` does not accept a caller-chosen kid. */
  kid: string;
  namespaces: Array<string>;
  capabilities: Array<string>;
  keyPath: string;
}

export interface JoinDeps {
  httpJson?: HttpJsonFn;
  hostname?: () => string;
  homeDir?: () => string;
}

function asStringArray(value: unknown): Array<string> {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** Map the callee's response into a specific operator-facing message. */
function registerFailure(status: number, body: unknown, origin: string): AdminCliError {
  const code =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>).code : undefined;
  if (code === 'invite_not_found') {
    return new AdminCliError(
      `token not recognised at ${origin} — it was already swept, or it was minted against a different instance`,
      3
    );
  }
  if (code === 'invite_already_consumed') {
    return new AdminCliError(
      'this token has already been redeemed — tokens are single use. Mint a fresh one on the callee with `substrate federate enroll`.',
      4
    );
  }
  if (code === 'invite_expired') {
    return new AdminCliError(
      'this token has expired. Mint a fresh one on the callee with `substrate federate enroll`.',
      5
    );
  }
  if (code === 'rate_limited') {
    const retryMs =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).retryAfterMs
        : undefined;
    const seconds = typeof retryMs === 'number' ? Math.max(1, Math.ceil(retryMs / 1000)) : 60;
    return new AdminCliError(`${origin} is rate-limiting registrations — retry in ${seconds}s`, 6);
  }
  const message =
    typeof body === 'object' && body !== null
      ? String((body as Record<string, unknown>).message ?? '')
      : '';
  return new AdminCliError(
    `${origin} refused the registration (HTTP ${status})${message.length > 0 ? `: ${message}` : ''}`,
    3
  );
}

export async function runJoin(args: JoinArgs, deps: JoinDeps = {}): Promise<JoinResult> {
  const call = deps.httpJson ?? httpJson;
  const host = (deps.hostname ?? osHostname)();
  const home = (deps.homeDir ?? homedir)();

  const payload = decodeJoinToken(args.token);
  const name = args.name ?? new URL(payload.origin).hostname;
  const keyPath = args.keyOut ?? pathJoin(home, '.config/substrate/keys', `${name}.key`);

  // FIRST — before generating anything or contacting the peer.
  if (existsSync(keyPath)) {
    throw new AdminCliError(
      `key path '${keyPath}' already exists — move it aside and retry, or pass --key-out. ` +
        'Nothing has been redeemed; your token is still valid.',
      2
    );
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { format: 'pem', type: 'spki' },
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' }
  });

  let res: Awaited<ReturnType<HttpJsonFn>>;
  try {
    res = await call(`${payload.origin}/substrate/v1/_system/register`, {
      method: 'POST',
      body: {
        code: payload.code,
        publicKey: publicKey.toString(),
        keyName: `bridge from ${host}`,
        algorithm: 'EdDSA'
      }
    });
  } catch (err) {
    throw new AdminCliError(
      `cannot reach ${payload.origin}: ${err instanceof Error ? err.message : String(err)}. ` +
        'That origin came from the token itself, so check it is the URL this machine can reach — ' +
        'a wrong origin at mint time looks identical to a peer being down.',
      3
    );
  }

  if (res.status !== 201) {
    throw registerFailure(res.status, res.body, payload.origin);
  }

  const body = (res.body ?? {}) as Record<string, unknown>;
  const kid = typeof body.kid === 'string' ? body.kid : '';
  if (kid.length === 0) {
    throw new AdminCliError(
      `${payload.origin} accepted the registration but returned no kid — nothing was written locally`,
      3
    );
  }

  // Committed at the peer — now, and only now, persist the private key.
  // `existsSync(keyPath)` above proved the leaf was free, not that the parent
  // is creatable/writable — an EACCES here (e.g. `--key-out /etc/substrate/...`
  // as a non-root user) would otherwise escape as a raw fs error with a
  // generic exit 1, giving no hint that the invite is already spent.
  try {
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    writeFileSync(keyPath, privateKey.toString(), { mode: 0o600 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AdminCliError(
      `redeemed at ${payload.origin} (kid ${kid}) but failed to write the private key to ` +
        `'${keyPath}': ${msg}. The invite token IS consumed — it cannot be redeemed again. ` +
        'Mint a fresh one on the callee with `substrate federate enroll`, then retry `join` with a ' +
        'path this process can actually create and write.',
      8
    );
  }

  return {
    origin: payload.origin,
    name,
    kid,
    namespaces: asStringArray(body.namespaces),
    capabilities: asStringArray(body.capabilities),
    keyPath
  };
}

export function formatJoinOutput(result: JoinResult): string {
  const bridges = result.namespaces.map((ns) => ({
    ns,
    name: result.name,
    url: result.origin
  }));
  const creds = {
    [result.name]: {
      keyPath: result.keyPath,
      kid: result.kid,
      origin: result.origin
    }
  };
  return [
    '',
    `  redeemed at ${result.origin}`,
    `  kid:        ${result.kid}`,
    `  namespaces: ${result.namespaces.join(', ')}    capabilities: ${result.capabilities.join(', ')}`,
    `  key:        ${result.keyPath} (0600)`,
    '',
    'Add to your .env, then restart:',
    '',
    `SUBSTRATE_BRIDGES='${JSON.stringify(bridges)}'`,
    `SUBSTRATE_BRIDGE_CREDENTIALS='${JSON.stringify(creds)}'`,
    '',
    `Then verify with:  substrate federate check ${result.name}`,
    ''
  ].join('\n');
}
