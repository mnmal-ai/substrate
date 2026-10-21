// @vitest-environment jsdom
/**
 * Regression: the transport must call `fetch` with `this === globalThis`.
 *
 * Browser-native `fetch` throws "Illegal invocation" when called as a method
 * of another object (e.g. stored as a class field). Runs under jsdom, where
 * `fetch` enforces receiver identity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../src/transport/http.js';

const ENDPOINT = 'http://substrate.test';

describe('HttpTransport — jsdom fetch receiver', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let capturedThis: unknown;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Spy that captures `this` at call time.
    capturedThis = undefined;
    fetchSpy = vi.fn(function (this: unknown, ..._args: unknown[]) {
      capturedThis = this;
      return Promise.resolve(
        new Response(
          JSON.stringify({ claude: { schemaVersion: 'v1', types: {}, mutations: {} } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        )
      );
    });
    // Install spy as globalThis.fetch so the transport picks it up.
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchSpy,
      writable: true,
      configurable: true
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      writable: true,
      configurable: true
    });
    vi.restoreAllMocks();
  });

  it('calls globalThis.fetch with this === globalThis when no fetch opt supplied', async () => {
    const t = new HttpTransport({ endpoint: ENDPOINT });
    await t.federatedSchema();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      `${ENDPOINT}/substrate/v1/federated-schema`,
      expect.objectContaining({ method: 'GET' })
    );
    // Core assertion: receiver must be globalThis, not the transport instance.
    expect(capturedThis).toBe(globalThis);
  });

  it('does not throw "Illegal invocation" when fetch is taken from globalThis', async () => {
    const t = new HttpTransport({ endpoint: ENDPOINT });
    await expect(t.federatedSchema()).resolves.not.toThrow();
  });

  it('calls a caller-supplied fetch without rebinding', async () => {
    let suppliedCapturedThis: unknown;
    const suppliedFetch = vi.fn(function (this: unknown, ..._args: unknown[]) {
      suppliedCapturedThis = this;
      return Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    });

    const t = new HttpTransport({
      endpoint: ENDPOINT,
      fetch: suppliedFetch as unknown as typeof fetch
    });
    await t.federatedSchema();

    expect(suppliedFetch).toHaveBeenCalledOnce();
    // Caller-supplied fetch is also bound to globalThis.
    expect(suppliedCapturedThis).toBe(globalThis);
  });
});
