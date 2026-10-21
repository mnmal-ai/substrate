/**
 * The CLI commands that send a credential refuse plain http to a non-loopback
 * host and never follow a redirect with it.
 */

import { noRedirectFetch } from '@mnmal-ai/substrate-client';
import { describe, expect, it } from 'vitest';
import { runBackfillField } from '../src/cli/backfill-field/main.js';
import { httpJson } from '../src/cli/federate/http.js';
import { runNormaliseVocab } from '../src/cli/normalise-vocab/main.js';

describe('CLI credential targets', () => {
  it('normalise-vocab and backfill-field refuse plain http with a token, and send nothing', async () => {
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls++;
      return new Response('{}');
    };
    const out: string[] = [];
    const write = (s: string): void => {
      out.push(s);
    };
    const argv = ['app', 'T', 'f'];
    expect(
      await runNormaliseVocab(argv, { baseUrl: 'http://h', token: 'tok', fetchImpl, write })
    ).toBe(2);
    expect(
      await runBackfillField([...argv, '--values', 'v.json'], {
        baseUrl: 'http://h',
        token: 'tok',
        fetchImpl,
        readFile: () => '{"a":1}',
        write
      })
    ).toBe(2);
    expect(calls).toBe(0);
    expect(out.join('')).toMatch(/refusing to send a credential/);
  });

  it('federate refuses a credentialed request to plain http', async () => {
    await expect(
      httpJson('http://peer.example/x', { headers: { authorization: 'Bearer t' } })
    ).rejects.toThrow(/refusing to send a credential/);
  });

  it('noRedirectFetch asks fetch to refuse redirects', async () => {
    let seen: RequestInit | undefined;
    await noRedirectFetch(async (_u, init) => {
      seen = init;
      return new Response('');
    })('https://h', { method: 'POST' });
    expect(seen?.redirect).toBe('error');
    expect(seen?.method).toBe('POST');
  });
});
