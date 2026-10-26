/**
 * `substrate-admin doctor`.
 *
 * The report's value is entirely in the NOs, so almost every test here drives a
 * FAILING deployment and asserts that the failure is named at the layer that
 * caused it.
 */

import { describe, expect, it } from 'vitest';
import {
  type AdminCliEnv,
  type AdminTarget,
  type DoctorReport,
  doctorCommand,
  formatDoctorReport,
  reconcileIdentities,
  runDoctor
} from '../src/admin/index.js';

const ROUTE: AdminTarget = { kind: 'route', baseUrl: 'https://h.test', source: 'flag' };
const ENV: AdminCliEnv = { SUBSTRATE_ADMIN_TOKEN: 'Bearer t' };

interface StubOpts {
  health?: { status: number; body?: Record<string, unknown> } | 'unreachable';
  authEnabled?: boolean;
  whoami?: { status: number; body: Record<string, unknown> };
  /** Pages of Key rows; each entry is one response page. */
  keyPages?: Array<Array<Record<string, unknown>>>;
  /** Return a rejected-frame envelope instead of rows. */
  keyFrameAbsent?: boolean;
  /** Pages of AgentIdentity rows. Default: empty directory (no rows). */
  identityPages?: Array<Array<Record<string, unknown>>>;
  /** Return a rejected-frame envelope for the directory instead of rows. */
  identityFrameAbsent?: boolean;
}

function stubFetch(opts: StubOpts): typeof fetch {
  let keyPage = 0;
  let identityPage = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
      ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => body
      }) as unknown as Response;

    if (url.endsWith('/health')) {
      if (opts.health === 'unreachable') throw new Error('ECONNREFUSED');
      return json(opts.health?.status ?? 200, opts.health?.body ?? { version: '5.27.0' });
    }
    if (url.endsWith('/substrate/v1/onboard')) {
      // Like the real server: onboard needs a key once auth is on.
      const signed = new Headers(init?.headers).has('authorization');
      if ((opts.authEnabled ?? true) && !signed) return json(401, { code: 'unauthorized' });
      return json(200, {
        binary: {
          authEnabled: opts.authEnabled ?? true,
          coordinators: [{ name: 'cortext', namespaces: ['cortext'] }],
          virtualNamespaces: ['recall']
        }
      });
    }
    if (url.endsWith('/substrate/v1/whoami')) {
      // An unsigned whoami is the posture probe: it answers every caller.
      if (!new Headers(init?.headers).has('authorization')) {
        return json(200, { authEnabled: opts.authEnabled ?? true, identity: null });
      }
      const w = opts.whoami ?? {
        status: 200,
        body: {
          authEnabled: true,
          identity: { id: 'op@h', grants: { _system: ['read', 'admin'] } }
        }
      };
      return json(w.status, w.body);
    }
    if (url.endsWith('/substrate/v1/config')) {
      return json(200, { knobs: {}, storage: { layout: 'partitioned', warnings: [] } });
    }
    if (url.endsWith('/substrate/v1/query')) {
      expect(init?.method).toBe('POST');
      const frameKey = Object.keys(JSON.parse(String(init?.body)) as Record<string, unknown>)[0];
      if (frameKey === 'cortext/AgentIdentity') {
        if (opts.identityFrameAbsent === true) {
          return json(200, {
            data: {},
            errors: [{ code: 'policy_denied', message: 'requireCapability(read) on cortext' }]
          });
        }
        const pages = opts.identityPages ?? [[]];
        const rows = pages[identityPage] ?? [];
        const hasMore = identityPage < pages.length - 1;
        identityPage += 1;
        return json(200, {
          data: { 'cortext/AgentIdentity': rows },
          _pagination: {
            'cortext/AgentIdentity': { hasMore, nextCursor: hasMore ? 'c' : undefined }
          }
        });
      }
      if (opts.keyFrameAbsent === true) {
        return json(200, {
          data: {},
          errors: [{ code: 'policy_denied', message: 'requireCapability(admin)' }]
        });
      }
      const pages = opts.keyPages ?? [[]];
      const rows = pages[keyPage] ?? [];
      const hasMore = keyPage < pages.length - 1;
      keyPage += 1;
      return json(200, {
        data: { '_system/Key': rows },
        _pagination: { '_system/Key': { hasMore, nextCursor: hasMore ? 'c' : undefined } }
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

/** A flat admin key, the shape that predates per-namespace grants. */
const FLAT_ADMIN = {
  kid: 'genesis@h',
  namespaces: '*',
  capabilities: 'read,mutate,admin',
  revokedAt: null
};

function check(report: DoctorReport, name: string) {
  const found = report.checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no check named ${name}`);
  return found;
}

describe('doctor: a skip is not a pass', () => {
  it('refuses a direct target and skips every check it cannot answer', async () => {
    const report = await runDoctor(ENV, { kind: 'direct', source: 'flag' }, stubFetch({}));

    expect(check(report, 'target').status).toBe('no');
    // A direct target reads pg, so a printed admin row is no evidence that
    // admin auth works. Nothing below a direct target is measurable.
    expect(check(report, 'target').detail).toContain('never authenticates');
    for (const name of ['reachable', 'auth-enabled', 'credential', 'identity', 'admin-floor']) {
      expect(check(report, name).status).toBe('skip');
    }
    expect(report.exitCode).toBe(1);
  });

  it('renders the not-asked count separately from the passes', async () => {
    const report = await runDoctor(ENV, ROUTE, stubFetch({ health: 'unreachable' }));
    const text = formatDoctorReport(report);

    expect(text).toContain('NOT ASKED (a skipped check is not a passing one)');
    // The count that stops a reader summing skips into a verdict.
    expect(text).not.toMatch(/^\d+ ok, \d+ failed\.$/m);
  });
});

describe('doctor: each failure is named at the layer that caused it', () => {
  it('says the server is unreachable rather than blaming the credential', async () => {
    const report = await runDoctor(ENV, ROUTE, stubFetch({ health: 'unreachable' }));

    expect(check(report, 'reachable').status).toBe('no');
    expect(check(report, 'reachable').detail).toContain('ECONNREFUSED');
    expect(check(report, 'credential').status).toBe('skip');
  });

  it('names auth being DISABLED — dead end 6, and the cause of the forty minutes', async () => {
    const report = await runDoctor(ENV, ROUTE, stubFetch({ authEnabled: false }));
    const line = check(report, 'auth-enabled');

    expect(line.status).toBe('no');
    expect(line.detail).toContain('verifies nothing');
    // The remedy has to name the restart: a running server does not pick up
    // the setting.
    expect(line.fix).toContain('restart');
  });

  it('distinguishes a REJECTED credential from one that never arrived', async () => {
    const rejected = await runDoctor(
      ENV,
      ROUTE,
      stubFetch({ whoami: { status: 401, body: { code: 'unauthorized' } } })
    );
    expect(check(rejected, 'identity').detail).toContain('REJECTED');

    const absent = await runDoctor(
      ENV,
      ROUTE,
      stubFetch({ whoami: { status: 200, body: { authEnabled: true, identity: null } } })
    );
    expect(check(absent, 'identity').detail).toContain('never arrived');

    // Two states that look identical from a `policy_denied` message and need
    // opposite fixes — a wrong key versus a header that is not being sent.
    expect(check(rejected, 'identity').fix).not.toBe(check(absent, 'identity').fix);
  });

  it('separates "authenticates" from "may administer"', async () => {
    const report = await runDoctor(
      ENV,
      ROUTE,
      stubFetch({
        whoami: {
          status: 200,
          body: { authEnabled: true, identity: { id: 'agent@h', grants: { '*': ['read'] } } }
        }
      })
    );

    expect(check(report, 'identity').status).toBe('ok');
    expect(check(report, 'admin-capability').status).toBe('no');
    expect(check(report, 'admin-capability').fix).toContain('substrate-admin update agent@h');
  });
});

describe('doctor: the admin floor', () => {
  it('warns when the deployment is down to its last admin', async () => {
    const report = await runDoctor(ENV, ROUTE, stubFetch({ keyPages: [[FLAT_ADMIN]] }));
    const line = check(report, 'admin-floor');

    expect(line.status).toBe('ok');
    expect(line.detail).toContain('it is the last one');
    expect(report.exitCode).toBe(0);
  });

  it('reports succession as possible once a second admin exists', async () => {
    const report = await runDoctor(
      ENV,
      ROUTE,
      stubFetch({
        keyPages: [
          [
            FLAT_ADMIN,
            // The per-namespace form: no `admin` in `capabilities` at all, and
            // an admin nonetheless. Missing it would let the deployment's only
            // real admin be counted out.
            {
              kid: 'operator@h',
              namespaces: '_system:read+mutate+admin',
              capabilities: 'read',
              revokedAt: null
            },
            { kid: 'agent@h', namespaces: 'cortext', capabilities: 'read,mutate', revokedAt: null }
          ]
        ]
      })
    );
    const line = check(report, 'admin-floor');

    expect(line.status).toBe('ok');
    expect(line.detail).toContain('2 admin keys of 3 live');
    expect(line.detail).toContain('operator@h');
    expect(line.detail).toContain('Succession is possible');
  });

  it('pages — a count read off one page is well-formed and wrong', async () => {
    const report = await runDoctor(
      ENV,
      ROUTE,
      stubFetch({
        keyPages: [
          [FLAT_ADMIN],
          [{ kid: 'second@h', namespaces: '*:admin', capabilities: '', revokedAt: null }]
        ]
      })
    );

    expect(check(report, 'admin-floor').detail).toContain('2 admin keys of 2 live');
  });

  it('reads a REJECTED frame as a failure, never as an empty store', async () => {
    const report = await runDoctor(ENV, ROUTE, stubFetch({ keyFrameAbsent: true }));
    const line = check(report, 'admin-floor');

    // `data[key] ?? []` would render this as zero admin keys — which reads as a
    // lockout that is not there, and is the worst thing this check could say.
    expect(line.status).toBe('no');
    expect(line.detail).toContain('frame absent');
    expect(line.detail).not.toContain('NONE of them classifies');
  });
});

describe('doctor: key-directory reconciliation', () => {
  const AGENT_KEY = {
    kid: 'agent@h',
    namespaces: 'cortext',
    capabilities: 'read,mutate',
    revokedAt: null
  };
  const ACTIVE_ROW = { kid: 'agent@h', host: 'h', active: true };

  it('agrees when every live key has an active row (admin roots need none)', async () => {
    const report = await runDoctor(
      ENV,
      ROUTE,
      stubFetch({
        keyPages: [[FLAT_ADMIN, AGENT_KEY]],
        identityPages: [[ACTIVE_ROW]]
      })
    );
    const line = check(report, 'key-directory');

    // FLAT_ADMIN carries no directory row and must not trip direction 2: the
    // bootstrap root of trust is exempt by CAPABILITY, not by name.
    expect(line.status).toBe('ok');
    expect(line.detail).toContain('agree');
    expect(report.exitCode).toBe(0);
  });

  it('names a decommissioned agent holding a live credential', async () => {
    const report = await runDoctor(
      ENV,
      ROUTE,
      stubFetch({
        keyPages: [[FLAT_ADMIN, AGENT_KEY]],
        identityPages: [[{ kid: 'agent@h', host: 'h', active: false }]]
      })
    );
    const line = check(report, 'key-directory');

    // The dangerous direction: the directory says retired, the table still
    // verifies — and the table is what the server checks.
    expect(line.status).toBe('no');
    expect(line.detail).toContain('agent@h');
    expect(line.detail).toContain('LIVE');
    expect(line.fix).toContain('substrate-admin revoke agent@h');
    expect(report.exitCode).toBe(1);
  });

  it('names a live credential nothing references', async () => {
    const report = await runDoctor(
      ENV,
      ROUTE,
      stubFetch({
        keyPages: [[FLAT_ADMIN, AGENT_KEY]],
        identityPages: [[{ kid: 'someone-else@h', host: 'h', active: true }]]
      })
    );
    const line = check(report, 'key-directory');

    expect(line.status).toBe('no');
    expect(line.detail).toContain('agent@h');
    expect(line.detail).toContain('no directory row');
  });

  it('exempts by admin capability, not by kid — a per-namespace root needs no row either', async () => {
    const report = await runDoctor(
      ENV,
      ROUTE,
      stubFetch({
        keyPages: [
          [{ kid: 'root2@h', namespaces: '*:read+mutate+admin', capabilities: '', revokedAt: null }]
        ],
        identityPages: [[ACTIVE_ROW]]
      })
    );

    // No literal-kid allowlist could have passed this without an edit: the
    // exemption fired on conferral, which is the property that survives a
    // re-bootstrap. (The floor check names it admin for the same reason.)
    expect(check(report, 'key-directory').status).toBe('ok');
  });

  it('skips — never passes, never fails — when the directory is unreadable', async () => {
    const report = await runDoctor(
      ENV,
      ROUTE,
      stubFetch({ keyPages: [[FLAT_ADMIN]], identityFrameAbsent: true })
    );
    const line = check(report, 'key-directory');

    // An _system-scoped admin cannot read cortext, so there is no directory to
    // reconcile. An empty list would read as "every key is orphaned"; a pass
    // would read as "checked". Only skip is honest, and it must say how to
    // get the check (a cortext read grant), not just that it is missing.
    expect(line.status).toBe('skip');
    expect(line.detail).toContain('cortext');
    expect(report.exitCode).toBe(0);
  });

  it('reconcileIdentities: absent active reads as active; kid-less rows are ignored', () => {
    // Rows predating the active field must not read as decommissioned.
    expect(
      reconcileIdentities(
        [{ kid: 'a@h', revokedAt: null } as never],
        [{ kid: 'a@h', host: 'h' } as never],
        'admin'
      )
    ).toEqual({ retiredWithLiveKey: [], liveKeyWithoutRow: [], agentKids: ['a@h'] });
    // Unmatchable rows are ignored rather than reported — doctor is not a
    // corruption scanner.
    expect(
      reconcileIdentities(
        [{ namespaces: '*', revokedAt: null } as never],
        [{ host: 'h', active: false } as never],
        'admin'
      )
    ).toEqual({ retiredWithLiveKey: [], liveKeyWithoutRow: [], agentKids: [] });
  });
});

describe('doctor: a healthy deployment', () => {
  it('passes every check and exits 0', async () => {
    const report = await runDoctor(
      ENV,
      ROUTE,
      stubFetch({
        keyPages: [
          [
            FLAT_ADMIN,
            { kid: 'op@h', namespaces: '_system:admin', capabilities: '', revokedAt: null }
          ]
        ]
      })
    );

    expect(report.checks.filter((c) => c.status !== 'ok')).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(check(report, 'namespaces').detail).toContain('_system');
    expect(check(report, 'namespaces').detail).toContain('recall');
  });

  it('names the credential source without reading key material out', async () => {
    const report = await runDoctor(
      {
        SUBSTRATE_ADMIN_KEY_PATH: '/keys/op.key',
        SUBSTRATE_ADMIN_KEY_ID: 'op@h',
        SUBSTRATE_ADMIN_TOKEN: 'Bearer t'
      },
      ROUTE,
      stubFetch({ keyPages: [[FLAT_ADMIN]] })
    );

    expect(check(report, 'credential').detail).toContain('SUBSTRATE_ADMIN_TOKEN');
    expect(check(report, 'credential').detail).not.toContain('Bearer t');
  });
});

describe('doctor rejects what it does not understand', () => {
  // `doctor` takes no required arguments, so an unrejected mistyped flag would
  // not fail — it would RUN, against whatever SUBSTRATE_URL names rather than the
  // target the operator typed.
  const ENV_WITH_URL: AdminCliEnv = {
    SUBSTRATE_ADMIN_TOKEN: 'Bearer t',
    SUBSTRATE_URL: 'https://ambient.test'
  };
  const explode: typeof fetch = (() => {
    throw new Error('doctor must not reach the network on a rejected argv');
  }) as unknown as typeof fetch;

  it('refuses a mistyped --url instead of silently using the ambient one', async () => {
    await expect(doctorCommand(['--urlx', 'https://typo'], ENV_WITH_URL, explode)).rejects.toThrow(
      /unknown flag --urlx/
    );
  });

  it('refuses a stray positional', async () => {
    await expect(doctorCommand(['nonsense'], ENV_WITH_URL, explode)).rejects.toThrow(
      /unexpected argument 'nonsense'/
    );
  });

  it('names what it DOES accept, so the refusal is actionable', async () => {
    await expect(doctorCommand(['--help'], ENV_WITH_URL, explode)).rejects.toThrow(
      /--url <base> or --direct/
    );
  });

  it('still accepts the two flags it documents', async () => {
    // The guard must not have narrowed the command to uselessness.
    const report = await doctorCommand(['--direct'], ENV_WITH_URL, explode);
    expect(report.checks[0]?.name).toBe('target');
    expect(report.checks[0]?.status).toBe('no'); // --direct is refused BY doctor, not by argv parsing
  });
});
