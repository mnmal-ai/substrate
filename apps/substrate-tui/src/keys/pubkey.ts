/** A public key's algorithm and fingerprint, read locally before register sends it. */

import { createHash, createPublicKey } from 'node:crypto';
import { homedir } from 'node:os';
import type { AdminKeyAlgorithm } from '@mnmal-ai/substrate/client';

export type PublicKeyRead =
  | { readonly ok: true; readonly algorithm: AdminKeyAlgorithm; readonly fingerprint: string }
  | { readonly ok: false; readonly reason: string };

/** PEM armour of a private key, any algorithm prefix (none, RSA, EC, ENCRYPTED, OPENSSH…). */
const PRIVATE_KEY_ARMOUR = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

export function readPublicKey(pem: string): PublicKeyRead {
  if (PRIVATE_KEY_ARMOUR.test(pem)) {
    return {
      ok: false,
      reason: 'that file is a PRIVATE key — register takes the public half (.pub)'
    };
  }
  let algorithm: AdminKeyAlgorithm;
  try {
    const key = createPublicKey(pem);
    const type = key.asymmetricKeyType;
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (type === 'ed25519') algorithm = 'EdDSA';
    else if (type === 'rsa') algorithm = 'RS256';
    else if (type === 'ec' && curve === 'prime256v1') algorithm = 'ES256';
    else {
      const detail = curve !== undefined ? ` (${curve})` : '';
      return {
        ok: false,
        reason: `a ${type ?? 'unknown'}${detail} key — the server takes Ed25519, RSA or P-256`
      };
    }
  } catch {
    return { ok: false, reason: 'not a readable public-key PEM' };
  }
  const digest = createHash('sha256').update(pem).digest('base64url');
  return { ok: true, algorithm, fingerprint: `sha256:${digest.slice(0, 8)}` };
}

/** Expands `~` and `~/…` to the home directory. `~user/…` names someone else's home, which this
 *  does not resolve: it is refused rather than rewritten as the current user's. */
export function expandHome(
  text: string,
  home: string = homedir()
): { readonly path: string } | { readonly error: string } {
  if (text === '~' || text.startsWith('~/')) return { path: home + text.slice(1) };
  if (text.startsWith('~')) {
    return { error: 'only ~ and ~/… are expanded — give the full path instead of ~user' };
  }
  return { path: text };
}
