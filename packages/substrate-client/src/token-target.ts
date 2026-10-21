/**
 * Where a freshly minted credential may be sent: an https origin, or plain
 * http only to a loopback host, where nothing on the network can read it.
 */

const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/;

/**
 * @returns the origin of `baseUrl`, which a token for it names as its `aud`.
 * @throws Error when `baseUrl` is not a URL, or is plain http to a non-loopback host.
 */
export function tokenAudience(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`'${baseUrl}' is not a URL`);
  }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.test(url.hostname))) {
    return url.origin;
  }
  throw new Error(
    `refusing to send a credential to ${url.origin}: use https, or plain http only to a loopback host`
  );
}

/** `fetchImpl` with redirects refused: a redirect would carry the credential to wherever it points. */
export function noRedirectFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, redirect: 'error' });
}
