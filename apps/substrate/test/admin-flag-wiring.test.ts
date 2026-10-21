/**
 * A flag the operator typed must reach the thing that reads it.
 *
 * Two cases where a flag can be parsed correctly and still not be honoured,
 * giving the operator neither an error nor an effect:
 *
 *   - a repeated `--url` must be refused, not resolved to its first occurrence;
 *   - `--allow-unknown-ns` must travel in the route payload, because the route
 *     (`key-patch.ts`) reads it to decide whether to refuse a grant naming an
 *     unhosted namespace.
 *
 * Both are on the default (route) path. The assertions check DELIVERY, not
 * parsing; parsing is pinned in `substrate-admin-cli.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { doctorCommand } from '../src/admin/commands/doctor.js';
import type { AdminCliEnv } from '../src/admin/env.js';
import { main } from '../src/admin/main.js';

/** Throws if anything reaches the network — a refusal must not get that far. */
const explode: typeof fetch = (() => {
  throw new Error('must not reach the network on a refused argv');
}) as unknown as typeof fetch;

const ENV: AdminCliEnv = { SUBSTRATE_ADMIN_TOKEN: 'tok', SUBSTRATE_URL: 'https://ambient.test' };

async function run(argv: string[], env: AdminCliEnv = ENV): Promise<{ code: number; err: string }> {
  const err: string[] = [];
  const code = await main(
    argv,
    env,
    () => {},
    (s) => err.push(s)
  );
  return { code, err: err.join('') };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a repeated --url is refused rather than silently resolved to the first', () => {
  it('doctor refuses it, and does not reach the network to find out', async () => {
    // `explode` is the other half of the assertion: reaching the network here
    // would mean the refusal came too late to matter.
    await expect(
      doctorCommand(['--url', 'https://a', '--url', 'https://b'], ENV, explode)
    ).rejects.toThrow(/--url specified more than once/);
  });

  it('doctor still accepts a single --url — the guard must not narrow it to uselessness', async () => {
    const seen: string[] = [];
    const capture: typeof fetch = (async (url: string) => {
      seen.push(String(url));
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;

    await doctorCommand(['--url', 'https://only.test'], ENV, capture);

    // It went where the operator said, not to the ambient SUBSTRATE_URL.
    expect(seen.join(' ')).toContain('https://only.test');
    expect(seen.join(' ')).not.toContain('ambient.test');
  });

  it('revoke refuses it — the destructive verb, where the value is WHICH server', async () => {
    const { code, err } = await run([
      'revoke',
      'some-kid',
      '--url',
      'https://a',
      '--url',
      'https://b'
    ]);

    expect(code).toBe(1);
    expect(err).toContain('revoke: --url specified more than once');
  });

  it('revoke still honours a single --url, and names the target it resolved', async () => {
    // The banner is how an operator sees where a mutating command is going.
    // Asserting it here means the single-flag path is exercised end to end
    // rather than merely not throwing.
    vi.stubGlobal('fetch', (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ kid: 'some-kid', revokedAt: '2026-01-01T00:00:00Z' })
    })) as unknown as typeof fetch);

    const { err } = await run(['revoke', 'some-kid', '--url', 'https://only.test']);

    expect(err).toContain('https://only.test');
    expect(err).not.toContain('ambient.test');
  });
});

describe('--allow-unknown-ns reaches the route that reads it', () => {
  /** Captures the PATCH body `main` builds. */
  function captureBody(): { bodies: Array<Record<string, unknown>> } {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return { ok: true, status: 200, json: async () => ({ kid: 'k@h' }) } as unknown as Response;
    }) as unknown as typeof fetch);
    return { bodies };
  }

  it('sends it when the operator types it', async () => {
    // If this key is absent the route applies its default and refuses the
    // very grant the operator was confirming.
    const { bodies } = captureBody();

    await run([
      'update',
      'k@h',
      '--ns',
      'not-yet-installed',
      '--allow-unknown-ns',
      '--url',
      'https://peer'
    ]);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.allowUnknownNs).toBe(true);
  });

  it('does not send it when the operator does not', async () => {
    // The other direction matters as much: the flag is a confirmation, so it
    // must not arrive true by accident on a command that never asked for it.
    const { bodies } = captureBody();

    await run(['update', 'k@h', '--ns', 'cortext', '--url', 'https://peer']);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.allowUnknownNs).toBe(false);
  });

  it('still carries the flags it already carried', async () => {
    // Guard against the payload edit dropping a sibling — `widen` and
    // `allowAdmin` travel the same literal, and a missing `widen` would turn a
    // refused narrowing into a silent one.
    const { bodies } = captureBody();

    await run(['update', 'k@h', '--ns', 'cortext', '--widen', '--url', 'https://peer']);

    expect(bodies[0]?.kid).toBe('k@h');
    expect(bodies[0]?.widen).toBe(true);
    expect(bodies[0]?.namespaces).toEqual(['cortext']);
  });
});
