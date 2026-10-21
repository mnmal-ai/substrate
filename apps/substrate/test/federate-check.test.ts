import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../src/cli/federate/check.js';
import { loadEnvFile } from '../src/cli/federate/env-file.js';
import { HttpJsonError, type HttpJsonFn, type HttpJsonResult } from '../src/cli/federate/http.js';
import { parseCheckArgs } from '../src/cli/federate/main.js';

const ORIGIN = 'https://b.internal:3100';

let dir: string;
let keyPath: string;

beforeEach(() => {
  dir = mkdtempSync(pathJoin(tmpdir(), 'federate-check-'));
  keyPath = pathJoin(dir, 'peer-b.key');
  writeFileSync(keyPath, 'unused — token minting is stubbed', { mode: 0o600 });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function envWith(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    SUBSTRATE_BRIDGES: JSON.stringify([{ ns: 'demo', name: 'peer-b', url: ORIGIN }]),
    SUBSTRATE_BRIDGE_CREDENTIALS: JSON.stringify({
      'peer-b': { keyPath, kid: 'k1', origin: ORIGIN }
    }),
    ...overrides
  };
}

/** Route stub responses by URL suffix. */
function peer(routes: Record<string, HttpJsonResult | Error>): HttpJsonFn {
  return async (url) => {
    for (const [suffix, response] of Object.entries(routes)) {
      if (url.endsWith(suffix)) {
        if (response instanceof Error) throw response;
        return response;
      }
    }
    throw new HttpJsonError(`unstubbed url ${url}`);
  };
}

const HEALTHY = {
  '/health': { status: 200, body: { status: 'ok' }, raw: '' },
  '/substrate/v1/whoami': {
    status: 200,
    body: {
      authEnabled: true,
      identity: { id: 'k1', tokenId: 'k1', grants: { demo: ['read'] } }
    },
    raw: ''
  },
  '/substrate/v1/schema/demo': { status: 200, body: { types: {} }, raw: '' }
} satisfies Record<string, HttpJsonResult>;

const deps = (routes: Record<string, HttpJsonResult | Error>) => ({
  httpJson: peer(routes),
  tokenFor: () => 'Bearer stub'
});

/** The step that failed, or undefined when everything passed. */
function failedStep(results: Awaited<ReturnType<typeof runCheck>>): string | undefined {
  return results[0]?.steps.find((s) => s.status === 'fail')?.name;
}

describe('runCheck', () => {
  it('passes every step against a healthy peer', async () => {
    const results = await runCheck('peer-b', envWith(), deps(HEALTHY));
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.steps.map((s) => s.name)).toEqual([
      'config',
      'key file',
      'reachable',
      'auth',
      'scope',
      'namespace'
    ]);
    expect(results[0]?.steps.every((s) => s.status === 'ok')).toBe(true);
  });

  it('fails at config when the bridge is not configured', async () => {
    const results = await runCheck('missing', envWith(), deps(HEALTHY));
    expect(failedStep(results)).toBe('config');
    expect(results[0]?.steps[0]?.detail).toMatch(/not configured/);
  });

  it('fails at config when the credential origin disagrees with the bridge url', async () => {
    const env = envWith({
      SUBSTRATE_BRIDGE_CREDENTIALS: JSON.stringify({
        'peer-b': { keyPath, kid: 'k1', origin: 'https://elsewhere:3100' }
      })
    });
    const results = await runCheck('peer-b', env, deps(HEALTHY));
    expect(failedStep(results)).toBe('config');
    expect(results[0]?.steps[0]?.detail).toMatch(/origin/);
  });

  it('fails at key file when the key is missing', async () => {
    rmSync(keyPath);
    const results = await runCheck('peer-b', envWith(), deps(HEALTHY));
    expect(failedStep(results)).toBe('key file');
  });

  it('fails at reachable when the peer refuses the connection', async () => {
    const results = await runCheck(
      'peer-b',
      envWith(),
      deps({ ...HEALTHY, '/health': new HttpJsonError('ECONNREFUSED') })
    );
    expect(failedStep(results)).toBe('reachable');
  });

  it('names an unknown kid distinctly from an outage', async () => {
    const results = await runCheck(
      'peer-b',
      envWith(),
      deps({ ...HEALTHY, '/substrate/v1/whoami': { status: 401, body: {}, raw: '' } })
    );
    expect(failedStep(results)).toBe('auth');
    expect(results[0]?.steps[3]?.detail).toMatch(/does not recognise kid 'k1'/);
  });

  it('reports a credential that arrived but grants an empty capability set', async () => {
    // The peer names the grant, and an empty set is reported rather than
    // inferred — step 3 passes with `grant: demo:(nothing)` and scope reports
    // `(nothing)` instead of failing the bridge.
    const results = await runCheck(
      'peer-b',
      envWith(),
      deps({
        ...HEALTHY,
        '/substrate/v1/whoami': {
          status: 200,
          body: {
            authEnabled: true,
            identity: { id: 'k1', tokenId: 'k1', grants: { demo: [] } }
          },
          raw: ''
        }
      })
    );
    expect(results[0]?.steps[3]?.detail).toContain('peer accepted');
    expect(results[0]?.steps[3]?.detail).toContain('grant: demo:(nothing)');
  });

  it('names a credential that never arrived, distinctly from auth being off', async () => {
    // Auth IS on at the peer and it still resolved nobody, so this command's
    // own credential wiring is at fault rather than the peer.
    const results = await runCheck(
      'peer-b',
      envWith(),
      deps({
        ...HEALTHY,
        '/substrate/v1/whoami': {
          status: 200,
          body: { authEnabled: true, identity: null },
          raw: ''
        }
      })
    );
    expect(failedStep(results)).toBe('auth');
    expect(results[0]?.steps[3]?.detail).toMatch(/without a credential/);
  });

  it('reports a peer whose auth is disabled', async () => {
    const results = await runCheck(
      'peer-b',
      envWith(),
      deps({
        ...HEALTHY,
        '/substrate/v1/whoami': {
          status: 200,
          body: { authEnabled: false, identity: null },
          raw: ''
        }
      })
    );
    expect(failedStep(results)).toBe('auth');
    expect(results[0]?.steps[3]?.detail).toMatch(/auth DISABLED/);
  });

  it('names the actual grant when the scope is wrong', async () => {
    const results = await runCheck(
      'peer-b',
      envWith(),
      deps({
        ...HEALTHY,
        '/substrate/v1/whoami': {
          status: 200,
          body: {
            authEnabled: true,
            identity: { id: 'k1', tokenId: 'k1', grants: { logs: ['read'] } }
          },
          raw: ''
        }
      })
    );
    expect(failedStep(results)).toBe('scope');
    // The whole point: say what they DO have, not just that it failed.
    expect(results[0]?.steps[4]?.detail).toMatch(/logs/);
  });

  it('accepts a wildcard namespace grant', async () => {
    const results = await runCheck(
      'peer-b',
      envWith(),
      deps({
        ...HEALTHY,
        '/substrate/v1/whoami': {
          status: 200,
          body: {
            authEnabled: true,
            identity: { id: 'k1', tokenId: 'k1', grants: { '*': ['read'] } }
          },
          raw: ''
        }
      })
    );
    expect(results[0]?.ok).toBe(true);
  });

  it('fails at namespace when the peer does not serve it', async () => {
    const results = await runCheck(
      'peer-b',
      envWith(),
      deps({ ...HEALTHY, '/substrate/v1/schema/demo': { status: 404, body: {}, raw: '' } })
    );
    expect(failedStep(results)).toBe('namespace');
  });

  it('marks steps after a failure as skipped, not passed', async () => {
    const results = await runCheck(
      'peer-b',
      envWith(),
      deps({ ...HEALTHY, '/health': new HttpJsonError('ECONNREFUSED') })
    );
    const after = results[0]?.steps.slice(3) ?? [];
    expect(after).toHaveLength(3);
    expect(after.every((s) => s.status === 'skipped')).toBe(true);
  });

  it('names an older peer lacking /substrate/v1/whoami distinctly from a credential problem', async () => {
    // A 404 here is a version mismatch, not a credential problem, and must not
    // read as "your kid is wrong". A peer serving only the old
    // `/substrate/v1/_system/whoami` (no alias) also 404s here, so the message names
    // that path too.
    const results = await runCheck(
      'peer-b',
      envWith(),
      deps({ ...HEALTHY, '/substrate/v1/whoami': { status: 404, body: {}, raw: '' } })
    );
    expect(failedStep(results)).toBe('auth');
    expect(results[0]?.steps[3]?.detail).toMatch(/predates it/);
    expect(results[0]?.steps[3]?.detail).toMatch(/_system\/whoami/);
  });

  it('passes scope on a 200 whoami even when the grant confers nothing', async () => {
    // An empty grant still covers the namespace — scope answers "does the
    // peer name this namespace", and `{ demo: [] }` does. The per-namespace
    // detail reports `(nothing)` for the operator to read; the check does not
    // re-gate client-side.
    const results = await runCheck(
      'peer-b',
      envWith(),
      deps({
        ...HEALTHY,
        '/substrate/v1/whoami': {
          status: 200,
          body: {
            authEnabled: true,
            identity: { id: 'k1', tokenId: 'k1', grants: { demo: [] } }
          },
          raw: ''
        }
      })
    );
    expect(results[0]?.ok).toBe(true);
  });

  /**
   * A read-only credential passes every step yet has its mutates refused, so
   * check must name the grant. Information, not a gate: an empty grant still
   * passes.
   */
  it('surfaces the granted capabilities, warning when the bridge is read-only', async () => {
    const results = await runCheck(
      'peer-b',
      envWith(),
      deps({
        ...HEALTHY,
        '/substrate/v1/whoami': {
          status: 200,
          body: {
            authEnabled: true,
            identity: { id: 'k1', tokenId: 'k1', grants: { demo: ['read'] } }
          },
          raw: ''
        }
      })
    );
    expect(results[0]?.ok).toBe(true);
    // Step 3 reports the grant; the read-only warning belongs to the
    // per-namespace SCOPE step (4), because a peer can grant `mutate` on one
    // bridged namespace and `read` on another.
    expect(results[0]?.steps[3]?.detail ?? '').toContain('demo:read');
    const scope = results[0]?.steps[4]?.detail ?? '';
    expect(scope).toContain('read');
    expect(scope).toMatch(/read-only/);
    expect(scope).toMatch(/refused/);
  });

  it('reads the grant, never a flat field (was: null capabilities)', async () => {
    // A non-uniform grant: the per-namespace grant is the whole input, and
    // the scope step must report the bridged namespace writable.
    const results = await runCheck(
      'peer-b',
      envWith(),
      deps({
        ...HEALTHY,
        '/substrate/v1/whoami': {
          status: 200,
          body: {
            authEnabled: true,
            identity: {
              id: 'k1',
              tokenId: 'k1',
              grants: { demo: ['read', 'mutate'], other: ['read'] }
            }
          },
          raw: ''
        }
      })
    );

    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.steps[3]?.detail ?? '').toContain('demo:read+mutate');
    // And the bridged namespace is reported as WRITABLE.
    const scope = results[0]?.steps[4]?.detail ?? '';
    expect(scope).toContain('mutate');
    expect(scope).not.toMatch(/read-only/);
  });

  it('fails the scope step on a namespace the grant does not cover', async () => {
    const results = await runCheck(
      'peer-b',
      envWith(),
      deps({
        ...HEALTHY,
        '/substrate/v1/whoami': {
          status: 200,
          body: {
            authEnabled: true,
            identity: { id: 'k1', tokenId: 'k1', grants: { other: ['read'] } }
          },
          raw: ''
        }
      })
    );

    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.steps[4]?.detail ?? '').toContain("needs 'demo'");
  });

  it('does not warn about writes when mutate is granted', async () => {
    const results = await runCheck(
      'peer-b',
      envWith(),
      deps({
        ...HEALTHY,
        '/substrate/v1/whoami': {
          status: 200,
          body: {
            authEnabled: true,
            identity: {
              id: 'k1',
              tokenId: 'k1',
              grants: { demo: ['read', 'mutate'] }
            }
          },
          raw: ''
        }
      })
    );
    expect(results[0]?.ok).toBe(true);
    const detail = results[0]?.steps[3]?.detail ?? '';
    expect(detail).toContain('mutate');
    expect(detail).not.toMatch(/read-only/);
  });

  it('reports an empty grant plainly when the peer confers nothing', async () => {
    const results = await runCheck(
      'peer-b',
      envWith(),
      deps({
        ...HEALTHY,
        '/substrate/v1/whoami': {
          status: 200,
          body: {
            authEnabled: true,
            identity: { id: 'k1', tokenId: 'k1', grants: { demo: [] } }
          },
          raw: ''
        }
      })
    );
    expect(results[0]?.ok).toBe(true);
    const detail = results[0]?.steps[3]?.detail ?? '';
    expect(detail).not.toMatch(/read-only/);
    expect(detail).not.toMatch(/capabilities \[/);
  });

  it('checks the namespace step per namespace, catching a peer granting but not serving one', async () => {
    // Regression: a coordinator serving two namespaces (the shape
    // `formatJoinOutput` produces) must be checked against each, not just the
    // first — a second namespace the peer does not serve must not pass.
    const env = envWith({
      SUBSTRATE_BRIDGES: JSON.stringify([
        { ns: 'demo', name: 'peer-b', url: ORIGIN },
        { ns: 'logs', name: 'peer-b', url: ORIGIN }
      ])
    });
    const results = await runCheck(
      'peer-b',
      env,
      deps({
        ...HEALTHY,
        '/substrate/v1/whoami': {
          status: 200,
          body: {
            authEnabled: true,
            identity: {
              id: 'k1',
              tokenId: 'k1',
              grants: { demo: ['read'], logs: ['read'] }
            }
          },
          raw: ''
        },
        '/substrate/v1/schema/logs': { status: 404, body: {}, raw: '' }
      })
    );
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.steps.map((s) => s.name)).toEqual([
      'config',
      'key file',
      'reachable',
      'auth',
      'scope:demo',
      'namespace:demo',
      'scope:logs',
      'namespace:logs'
    ]);
    const demoNamespace = results[0]?.steps.find((s) => s.name === 'namespace:demo');
    const logsNamespace = results[0]?.steps.find((s) => s.name === 'namespace:logs');
    expect(demoNamespace?.status).toBe('ok');
    expect(logsNamespace?.status).toBe('fail');
    expect(logsNamespace?.detail).toMatch(/does not serve/);
  });

  it('checks the scope step per namespace, catching a peer that grants only one of two', async () => {
    const env = envWith({
      SUBSTRATE_BRIDGES: JSON.stringify([
        { ns: 'demo', name: 'peer-b', url: ORIGIN },
        { ns: 'logs', name: 'peer-b', url: ORIGIN }
      ])
    });
    const results = await runCheck(
      'peer-b',
      env,
      deps({
        ...HEALTHY,
        '/substrate/v1/whoami': {
          status: 200,
          body: {
            authEnabled: true,
            identity: { id: 'k1', tokenId: 'k1', grants: { demo: ['read'] } }
          },
          raw: ''
        }
      })
    );
    expect(results[0]?.ok).toBe(false);
    const demoScope = results[0]?.steps.find((s) => s.name === 'scope:demo');
    const logsScope = results[0]?.steps.find((s) => s.name === 'scope:logs');
    // The namespace step for the ungranted namespace never ran — no schema
    // stub for it is registered above, so an unconditional call would throw
    // "unstubbed url" and fail the test, proving the loop skips it.
    const logsNamespace = results[0]?.steps.find((s) => s.name === 'namespace:logs');
    expect(demoScope?.status).toBe('ok');
    expect(logsScope?.status).toBe('fail');
    expect(logsScope?.detail).toMatch(/logs/);
    expect(logsNamespace?.status).toBe('skipped');
  });

  it('checks every configured bridge when no name is given', async () => {
    const env = envWith({
      SUBSTRATE_BRIDGES: JSON.stringify([
        { ns: 'demo', name: 'peer-b', url: ORIGIN },
        { ns: 'demo2', name: 'peer-c', url: 'https://c.internal:3100' }
      ]),
      SUBSTRATE_BRIDGE_CREDENTIALS: JSON.stringify({
        'peer-b': { keyPath, kid: 'k1', origin: ORIGIN },
        'peer-c': { keyPath, kid: 'k2', origin: 'https://c.internal:3100' }
      })
    });
    const results = await runCheck(
      undefined,
      env,
      deps({ ...HEALTHY, '/substrate/v1/schema/demo2': { status: 200, body: {}, raw: '' } })
    );
    expect(results.map((r) => r.bridge)).toEqual(['peer-b', 'peer-c']);
  });
});

describe('loadEnvFile', () => {
  it('reads plain, single-quoted and double-quoted values', () => {
    const path = pathJoin(dir, '.env.binary');
    writeFileSync(
      path,
      [
        '# a comment',
        '',
        'PLAIN=value',
        "SINGLE='quoted value'",
        'DOUBLE="quoted value"',
        'WITH_EQUALS=postgres://u:p@h/db?x=1',
        '  SPACED = padded '
      ].join('\n')
    );
    expect(loadEnvFile(path)).toEqual({
      PLAIN: 'value',
      SINGLE: 'quoted value',
      DOUBLE: 'quoted value',
      WITH_EQUALS: 'postgres://u:p@h/db?x=1',
      SPACED: 'padded'
    });
  });

  it('throws a clear error when the file is missing', () => {
    expect(() => loadEnvFile(pathJoin(dir, 'nope'))).toThrow(/cannot read/);
  });
});

describe('parseCheckArgs', () => {
  it('takes no arguments at all', () => {
    expect(parseCheckArgs(['check'])).toEqual({ name: undefined, envFile: undefined });
  });

  it('reads a positional name and --env-file', () => {
    const args = parseCheckArgs(['check', 'peer-b', '--env-file', '/e']);
    expect(args).toMatchObject({ name: 'peer-b', envFile: '/e' });
  });

  it('rejects --env-file given twice', () => {
    expect(() => parseCheckArgs(['check', '--env-file', '/e', '--env-file', '/e2'])).toThrow(
      /more than once/
    );
  });

  it('rejects --env-file with no value following it', () => {
    expect(() => parseCheckArgs(['check', '--env-file'])).toThrow(/requires a value/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseCheckArgs(['check', '--wat'])).toThrow(/unknown flag/);
  });

  it('rejects a second positional', () => {
    expect(() => parseCheckArgs(['check', 'peer-b', 'extra'])).toThrow(/unexpected positional/);
  });
});
