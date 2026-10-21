import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSubstrateForTest } from './server.js';

afterEach(() => vi.restoreAllMocks());

describe('MCP server Authorization header wiring', () => {
  it('attaches Authorization when an auth header provider is set', async () => {
    const calls: Array<Record<string, string>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init.headers as Record<string, string>);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );
    await getSubstrateForTest(
      'https://x',
      '/substrate/v1/federated-schema',
      () => 'Bearer TESTTOKEN'
    );
    expect(calls[0]?.authorization).toBe('Bearer TESTTOKEN');
  });

  it('omits Authorization when provider returns null', async () => {
    const calls: Array<Record<string, string>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init.headers as Record<string, string>);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );
    await getSubstrateForTest('http://x', '/substrate/v1/federated-schema', () => null);
    expect(calls[0]?.authorization).toBeUndefined();
  });
});
