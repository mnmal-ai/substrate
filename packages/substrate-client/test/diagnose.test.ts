import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { DIAGNOSE_CHECKS, diagnose } from '../src/index.js';
import { mockHandlers } from './_setup.js';

const B = 'http://substrate.test';
const whoamiOf = (identity: unknown) =>
  http.get(`${B}/substrate/v1/whoami`, ({ request }) =>
    HttpResponse.json(
      request.headers.get('authorization') === null
        ? { authEnabled: true, identity: null }
        : { authEnabled: true, identity }
    )
  );
const healthy = [
  http.get(`${B}/health`, () => HttpResponse.json({ version: '7.6.0' })),
  http.get(`${B}/substrate/v1/onboard`, () =>
    HttpResponse.json({ binary: { coordinators: [], virtualNamespaces: [] } })
  )
];
const status = (r: { checks: readonly { name: string; status: string }[] }, name: string) =>
  r.checks.find((c) => c.name === name)?.status;

describe('diagnose', () => {
  it('an agent identity with expectAdmin false: admin checks are skipped, never failed', async () => {
    mockHandlers(
      ...healthy,
      whoamiOf({ id: 'substrate-claude@Box', grants: { cortext: ['read', 'mutate'] } })
    );
    const r = await diagnose({
      baseUrl: B,
      credential: { authorization: () => 'Bearer agent', label: 'agent substrate-claude@Box' },
      expectAdmin: false
    });
    expect(r.identity).toBe('substrate-claude@Box');
    expect(status(r, 'identity')).toBe('ok');
    for (const n of ['admin-capability', 'admin-floor', 'key-directory'])
      expect(status(r, n)).toBe('skip');
    expect(r.exitCode).toBe(0);
  });

  it('a credential error is a NO on credential, and everything downstream is skip', async () => {
    mockHandlers(...healthy, whoamiOf(null));
    const r = await diagnose({ baseUrl: B, credential: { error: 'no agent identity configured' } });
    expect(status(r, 'credential')).toBe('no');
    expect(r.checks.find((c) => c.name === 'credential')?.detail).toBe(
      'no agent identity configured'
    );
    for (const n of ['identity', 'admin-capability', 'admin-floor', 'key-directory'])
      expect(status(r, n)).toBe('skip');
    expect(r.identity).toBeNull();
  });

  it('a credential error carrying its own fix uses it; without one, the admin fix stands', async () => {
    mockHandlers(...healthy, whoamiOf(null));
    const own = await diagnose({
      baseUrl: B,
      credential: { error: 'no agent identity configured', fix: 'set the agent key' }
    });
    expect(own.checks.find((c) => c.name === 'credential')?.fix).toBe('set the agent key');
    const dflt = await diagnose({ baseUrl: B, credential: { error: 'none' } });
    expect(dflt.checks.find((c) => c.name === 'credential')?.fix).toContain(
      'SUBSTRATE_ADMIN_TOKEN'
    );
  });

  it('an identity without admin, expected admin: NO on admin-capability', async () => {
    mockHandlers(...healthy, whoamiOf({ id: 'x', grants: { cortext: ['read'] } }));
    const r = await diagnose({
      baseUrl: B,
      credential: { authorization: () => 'Bearer x', label: 'x' }
    });
    expect(status(r, 'admin-capability')).toBe('no');
    expect(r.exitCode).toBe(1);
  });

  describe('paging fails closed on hasMore without nextCursor', () => {
    const ADMIN = {
      kid: 'admin@Box',
      namespaces: '_system:read+mutate+admin',
      capabilities: '',
      revokedAt: null
    };
    const SECOND = {
      kid: 'second@Box',
      namespaces: '_system:read+mutate+admin',
      capabilities: '',
      revokedAt: null
    };
    // One page per frame key; `hasMore: true` with no `nextCursor` is the defect shape.
    const queryOf = (pages: Record<string, { rows: unknown[]; hasMore?: boolean }>) =>
      http.post(`${B}/substrate/v1/query`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        const key = Object.keys(body)[0] as string;
        const page = pages[key] ?? { rows: [] };
        return HttpResponse.json({
          data: { [key]: page.rows },
          _pagination: {
            [key]: page.hasMore === undefined ? { hasMore: false } : { hasMore: page.hasMore }
          }
        });
      });
    const asAdmin = () =>
      diagnose({ baseUrl: B, credential: { authorization: () => 'Bearer admin', label: 'admin' } });
    const adminWhoami = whoamiOf({
      id: 'admin@Box',
      grants: { _system: ['read', 'mutate', 'admin'] }
    });

    it('key floor: NO, never a partial roster reported as complete', async () => {
      mockHandlers(
        ...healthy,
        adminWhoami,
        queryOf({ '_system/Key': { rows: [ADMIN, SECOND], hasMore: true } })
      );
      const r = await asAdmin();
      const floor = r.checks.find((c) => c.name === 'admin-floor');
      expect(floor?.status).toBe('no');
      expect(floor?.detail).toContain('nextCursor');
      expect(floor?.detail).not.toContain('2 admin keys');
      expect(status(r, 'key-directory')).toBe('skip');
    });

    it('directory: NO, never a partial directory reconciled as complete', async () => {
      mockHandlers(
        ...healthy,
        adminWhoami,
        queryOf({
          '_system/Key': { rows: [ADMIN, SECOND] },
          'cortext/AgentIdentity': { rows: [], hasMore: true }
        })
      );
      const r = await asAdmin();
      expect(status(r, 'admin-floor')).toBe('ok');
      const dir = r.checks.find((c) => c.name === 'key-directory');
      expect(dir?.status).toBe('no');
      expect(dir?.detail).toContain('nextCursor');
    });
  });

  describe('namespaces is never silently absent', () => {
    const agent = { authorization: () => 'Bearer agent', label: 'agent' } as const;
    const agentWhoami = whoamiOf({ id: 'a@Box', grants: { cortext: ['read'] } });
    const health = http.get(`${B}/health`, () => HttpResponse.json({ version: '7.6.0' }));
    const onboardAnswering = (res: Response) => http.get(`${B}/substrate/v1/onboard`, () => res);

    it('a credential error marks namespaces skip, not absent', async () => {
      mockHandlers(...healthy, whoamiOf(null));
      const r = await diagnose({ baseUrl: B, credential: { error: 'none' } });
      expect(status(r, 'namespaces')).toBe('skip');
    });

    it('an onboard 401 or 403 is skip — the identity check owns the verdict on the credential', async () => {
      for (const code of [401, 403]) {
        mockHandlers(
          health,
          agentWhoami,
          onboardAnswering(HttpResponse.json({ error: 'nope' }, { status: code }))
        );
        const r = await diagnose({ baseUrl: B, credential: agent, expectAdmin: false });
        const ns = r.checks.find((c) => c.name === 'namespaces');
        expect(ns?.status).toBe('skip');
        expect(ns?.detail).toContain(String(code));
      }
    });

    it('an onboard 500 is NO carrying the status', async () => {
      mockHandlers(health, agentWhoami, onboardAnswering(HttpResponse.json({}, { status: 500 })));
      const r = await diagnose({ baseUrl: B, credential: agent, expectAdmin: false });
      const ns = r.checks.find((c) => c.name === 'namespaces');
      expect(ns?.status).toBe('no');
      expect(ns?.httpStatus).toBe(500);
      expect(r.exitCode).toBe(1);
    });

    it('an onboard 200 without a binary block is NO', async () => {
      mockHandlers(health, agentWhoami, onboardAnswering(HttpResponse.json({})));
      const r = await diagnose({ baseUrl: B, credential: agent, expectAdmin: false });
      expect(status(r, 'namespaces')).toBe('no');
    });

    it('an unreachable onboard is NO', async () => {
      mockHandlers(health, agentWhoami, onboardAnswering(HttpResponse.error()));
      const r = await diagnose({ baseUrl: B, credential: agent, expectAdmin: false });
      expect(status(r, 'namespaces')).toBe('no');
    });
  });

  describe('verdicts decided by an HTTP response carry its status', () => {
    it('a rejected credential: identity NO with httpStatus 401', async () => {
      mockHandlers(
        ...healthy,
        http.get(`${B}/substrate/v1/whoami`, ({ request }) =>
          request.headers.get('authorization') === null
            ? HttpResponse.json({ authEnabled: true, identity: null })
            : HttpResponse.json({ error: 'bad signature' }, { status: 401 })
        )
      );
      const r = await diagnose({
        baseUrl: B,
        credential: { authorization: () => 'Bearer bad', label: 'bad' }
      });
      const identity = r.checks.find((c) => c.name === 'identity');
      expect(identity?.status).toBe('no');
      expect(identity?.httpStatus).toBe(401);
    });

    it('an absent identity on a 200: identity NO with httpStatus 200', async () => {
      mockHandlers(
        ...healthy,
        http.get(`${B}/substrate/v1/whoami`, () =>
          HttpResponse.json({ authEnabled: true, identity: null })
        )
      );
      const r = await diagnose({
        baseUrl: B,
        credential: { authorization: () => 'Bearer x', label: 'x' }
      });
      expect(r.checks.find((c) => c.name === 'identity')?.httpStatus).toBe(200);
    });

    it('an unhealthy server: reachable NO with its status', async () => {
      mockHandlers(http.get(`${B}/health`, () => HttpResponse.json({}, { status: 503 })));
      const r = await diagnose({ baseUrl: B, credential: { error: 'none' } });
      expect(r.checks.find((c) => c.name === 'reachable')?.httpStatus).toBe(503);
    });
  });

  describe('facts', () => {
    const ADMIN_ROW = {
      kid: 'admin@Box',
      namespaces: '_system:read+mutate+admin',
      capabilities: '',
      revokedAt: null
    };
    const AGENT_ROW = {
      kid: 'agent@Box',
      namespaces: 'cortext,recall',
      capabilities: 'read,mutate',
      revokedAt: null
    };
    const RETIRED_ROW = { ...AGENT_ROW, kid: 'old@Box' };
    const rowsFor = (frames: Record<string, unknown[] | 'absent'>) =>
      http.post(`${B}/substrate/v1/query`, async ({ request }) => {
        const key = Object.keys((await request.json()) as Record<string, unknown>)[0] as string;
        const rows = frames[key] ?? [];
        if (rows === 'absent') {
          return HttpResponse.json({ data: {}, errors: [{ code: 'unauthorized_namespace' }] });
        }
        return HttpResponse.json({
          data: { [key]: rows },
          _pagination: { [key]: { hasMore: false } }
        });
      });
    const adminWhoami = whoamiOf({
      id: 'admin@Box',
      grants: { _system: ['read', 'mutate', 'admin'] }
    });
    const asAdmin = () =>
      diagnose({ baseUrl: B, credential: { authorization: () => 'Bearer a', label: 'a' } });

    it('a full run reports every fact; agentKids excludes admin keys', async () => {
      mockHandlers(
        ...healthy,
        adminWhoami,
        rowsFor({
          '_system/Key': [ADMIN_ROW, AGENT_ROW, RETIRED_ROW],
          'cortext/AgentIdentity': [
            { kid: 'agent@Box', active: true },
            { kid: 'old@Box', active: false }
          ]
        })
      );
      const r = await asAdmin();
      expect(r.facts).toEqual({
        adminKids: ['admin@Box'],
        liveKeyCount: 3,
        retiredWithLiveKey: ['old@Box'],
        liveKeyWithoutRow: [],
        agentKids: ['agent@Box']
      });
    });

    it('a credential failure leaves facts empty — absent, not zero', async () => {
      mockHandlers(...healthy, whoamiOf(null));
      const r = await diagnose({ baseUrl: B, credential: { error: 'none' } });
      expect(r.facts).toEqual({});
    });

    it('an unreadable directory: key facts present, directory facts absent', async () => {
      mockHandlers(
        ...healthy,
        adminWhoami,
        rowsFor({ '_system/Key': [ADMIN_ROW], 'cortext/AgentIdentity': 'absent' })
      );
      const r = await asAdmin();
      expect(r.facts.adminKids).toEqual(['admin@Box']);
      expect(r.facts.liveKeyCount).toBe(1);
      expect('agentKids' in r.facts).toBe(false);
      expect('retiredWithLiveKey' in r.facts).toBe(false);
    });
  });

  it('DIAGNOSE_CHECKS lists every check diagnose can emit, in dependency order', () => {
    expect(DIAGNOSE_CHECKS).toEqual([
      'reachable',
      'auth-enabled',
      'credential',
      'identity',
      'admin-capability',
      'admin-floor',
      'namespaces',
      'key-directory'
    ]);
  });
});
