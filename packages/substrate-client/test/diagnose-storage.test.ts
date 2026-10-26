import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { diagnose } from '../src/index.js';
import { mockHandlers } from './_setup.js';

const B = 'http://substrate.test';
const ADMIN = { id: 'admin@Box', grants: { _system: ['read', 'mutate', 'admin'] } };
const base = [
  http.get(`${B}/health`, () => HttpResponse.json({ version: '7.6.0' })),
  http.get(`${B}/substrate/v1/onboard`, () =>
    HttpResponse.json({ binary: { coordinators: [], virtualNamespaces: [] } })
  ),
  http.get(`${B}/substrate/v1/whoami`, ({ request }) =>
    HttpResponse.json({
      authEnabled: true,
      identity: request.headers.get('authorization') === null ? null : ADMIN
    })
  ),
  http.post(`${B}/substrate/v1/query`, async ({ request }) => {
    const key = Object.keys((await request.json()) as object)[0] as string;
    return HttpResponse.json({
      data: {
        [key]:
          key === '_system/Key'
            ? [{ kid: 'admin@Box', namespaces: '_system:read+mutate+admin', capabilities: '' }]
            : []
      },
      _pagination: { [key]: { hasMore: false } }
    });
  })
];
const run = (expectAdmin = true) =>
  diagnose({
    baseUrl: B,
    credential: { authorization: () => 'Bearer a', label: 'a' },
    expectAdmin
  });
const storage = (r: Awaited<ReturnType<typeof run>>) => r.checks.find((c) => c.name === 'storage');
const config = (body: Record<string, unknown>) =>
  http.get(`${B}/substrate/v1/config`, () => HttpResponse.json(body));

describe('diagnose storage check', () => {
  it('is ok when the server reports no warnings', async () => {
    mockHandlers(...base, config({ knobs: {}, storage: { layout: 'partitioned', warnings: [] } }));
    expect(storage(await run())?.status).toBe('ok');
  });

  it('is no, listing each warning, for rows parked in DEFAULT', async () => {
    mockHandlers(
      ...base,
      config({
        knobs: {},
        storage: {
          layout: 'partitioned',
          warnings: ['rows__default holds 2 rows of a/B', '501 partitions exceed the budget of 500']
        }
      })
    );
    const c = storage(await run());
    expect(c?.status).toBe('no');
    expect(c?.detail).toContain('rows__default holds 2 rows of a/B');
    expect(c?.detail).toContain('501 partitions exceed the budget of 500');
  });

  it('is ok, showing each info line, when there are only open recommendations', async () => {
    mockHandlers(
      ...base,
      config({
        knobs: {},
        storage: {
          layout: 'partitioned',
          warnings: [],
          info: ['2 open index recommendations: query _system/IndexRecommendation']
        }
      })
    );
    const c = storage(await run());
    expect(c?.status).toBe('ok');
    expect(c?.detail).toContain('2 open index recommendations');
  });

  it('is skip when the caller is not expected to be admin', async () => {
    mockHandlers(...base, config({ knobs: {}, storage: { layout: 'legacy', warnings: [] } }));
    expect(storage(await run(false))?.status).toBe('skip');
  });

  it('is skip when the config route refuses the caller', async () => {
    mockHandlers(
      ...base,
      http.get(`${B}/substrate/v1/config`, () => new HttpResponse(null, { status: 403 }))
    );
    expect(storage(await run())?.status).toBe('skip');
  });
});
