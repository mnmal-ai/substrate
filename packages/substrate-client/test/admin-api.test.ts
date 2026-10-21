import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { AuthError, NetworkError, SubstrateClient } from '../src/index.js';
import { mockHandlers } from './_setup.js';

const E = 'http://substrate.test';
const row = (kid: string) => ({
  id: `id-${kid}`,
  kid,
  name: kid,
  algorithm: 'EdDSA',
  namespaces: '*',
  capabilities: 'read',
  createdAt: '2026-10-05T00:00:00Z'
});

describe('client.admin.keys', () => {
  it('GETs /substrate/v1/_system/keys with the bearer and returns the rows', async () => {
    let auth: string | null = null;
    mockHandlers(
      http.get(`${E}/substrate/v1/_system/keys`, ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json({ filter: 'active', keys: [row('a')], hasMore: false });
      })
    );
    const keys = await new SubstrateClient({ endpoint: E, token: 't' }).admin.keys();
    expect(keys.map((k) => k.kid)).toEqual(['a']);
    expect(auth).toBe('Bearer t');
  });

  it('pages to completion through nextCursor', async () => {
    mockHandlers(
      http.get(`${E}/substrate/v1/_system/keys`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        return cursor === null
          ? HttpResponse.json({
              filter: 'active',
              keys: [row('a')],
              hasMore: true,
              nextCursor: 'c1'
            })
          : HttpResponse.json({ filter: 'active', keys: [row('b')], hasMore: false });
      })
    );
    const keys = await new SubstrateClient({ endpoint: E, token: 't' }).admin.keys();
    expect(keys.map((k) => k.kid)).toEqual(['a', 'b']);
  });

  it('a 403 is an AuthError', async () => {
    mockHandlers(
      http.get(`${E}/substrate/v1/_system/keys`, () => new HttpResponse(null, { status: 403 }))
    );
    await expect(
      new SubstrateClient({ endpoint: E, token: 't' }).admin.keys()
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('hasMore:true without nextCursor throws an error', async () => {
    mockHandlers(
      http.get(`${E}/substrate/v1/_system/keys`, () =>
        HttpResponse.json({ filter: 'active', keys: [row('a')], hasMore: true })
      )
    );
    await expect(new SubstrateClient({ endpoint: E, token: 't' }).admin.keys()).rejects.toThrow(
      'server reported hasMore with no nextCursor — refusing to report a partial key table as complete'
    );
  });
});

describe('client.admin.update / revoke', () => {
  it('update PATCHes the grant and sends only the flags it was given', async () => {
    let body: unknown;
    mockHandlers(
      http.patch(`${E}/substrate/v1/_system/keys`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          kid: 'a',
          revoked: false,
          namespaces: ['cortext:mutate+read'],
          capabilities: ['read']
        });
      })
    );
    const out = await new SubstrateClient({ endpoint: E, token: 't' }).admin.update({
      kid: 'a',
      namespaces: ['cortext:mutate+read'],
      capabilities: ['read'],
      widen: true
    });
    expect(body).toEqual({
      kid: 'a',
      namespaces: ['cortext:mutate+read'],
      capabilities: ['read'],
      widen: true
    });
    expect(out).toEqual({
      kid: 'a',
      revoked: false,
      namespaces: ['cortext:mutate+read'],
      capabilities: ['read']
    });
  });

  it("update's confirmable refusal surfaces as a 422 NetworkError with the server's code and message", async () => {
    mockHandlers(
      http.patch(`${E}/substrate/v1/_system/keys`, () =>
        HttpResponse.json(
          {
            code: 'requires_widen',
            message: 'update would GRANT authority a does not have (grants +plane:read).',
            namespacesGranted: ['plane'],
            capabilitiesGranted: []
          },
          { status: 422 }
        )
      )
    );
    const err = await new SubstrateClient({ endpoint: E, token: 't' }).admin
      .update({ kid: 'a', namespaces: ['plane'], capabilities: ['read'] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).toMatchObject({
      status: 422,
      code: 'requires_widen',
      serverMessage: expect.stringContaining('grants +plane:read')
    });
  });

  it('revoke PATCHes { kid, revoke: true } and returns revokedAt', async () => {
    let body: unknown;
    mockHandlers(
      http.patch(`${E}/substrate/v1/_system/keys`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({
          kid: 'a',
          revoked: true,
          revokedAt: '2026-10-06T00:00:00.000Z'
        });
      })
    );
    const out = await new SubstrateClient({ endpoint: E, token: 't' }).admin.revoke('a');
    expect(body).toEqual({ kid: 'a', revoke: true });
    expect(out.revokedAt).toBe('2026-10-06T00:00:00.000Z');
  });

  it('revoking the last admin key is a 409 with code last_active_admin', async () => {
    mockHandlers(
      http.patch(`${E}/substrate/v1/_system/keys`, () =>
        HttpResponse.json(
          {
            code: 'last_active_admin',
            message: 'refusing to revoke the last active admin Key (a).'
          },
          { status: 409 }
        )
      )
    );
    const err = await new SubstrateClient({ endpoint: E, token: 't' }).admin
      .revoke('a')
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'last_active_admin' });
  });
});

describe('client.admin.register / invite', () => {
  const PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----\n';

  it('register POSTs the key, maps `directory: false` to directory.create=false, and returns the fingerprint', async () => {
    let body: unknown;
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/keys`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          {
            kid: 'c@h',
            name: 'c@h',
            fingerprint: 'sha256:abcd1234',
            algorithm: 'EdDSA',
            namespaces: ['cortext'],
            capabilities: ['read'],
            replacedRevoked: false,
            directory: { created: false, reason: 'opted_out' }
          },
          { status: 201 }
        );
      })
    );
    const out = await new SubstrateClient({ endpoint: E, token: 't' }).admin.register({
      kid: 'c@h',
      publicKey: PEM,
      algorithm: 'EdDSA',
      namespaces: ['cortext'],
      capabilities: ['read'],
      directory: false
    });
    expect(body).toEqual({
      kid: 'c@h',
      publicKey: PEM,
      algorithm: 'EdDSA',
      namespaces: ['cortext'],
      capabilities: ['read'],
      directory: { create: false }
    });
    expect(out.fingerprint).toBe('sha256:abcd1234');
    expect(out.directory).toEqual({ created: false, reason: 'opted_out' });
  });

  it('register returns the directory outcome the route reports, typed both ways', async () => {
    const body = (directory: unknown) => ({
      kid: 'c@h',
      name: 'c@h',
      fingerprint: 'sha256:abcd1234',
      algorithm: 'EdDSA',
      namespaces: ['cortext'],
      capabilities: ['read'],
      replacedRevoked: false,
      directory
    });
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/keys`, () =>
        HttpResponse.json(body({ created: true, frame: 'cortext/AgentIdentity' }), { status: 201 })
      )
    );
    const input = {
      kid: 'c@h',
      publicKey: PEM,
      algorithm: 'EdDSA' as const,
      namespaces: ['cortext'],
      capabilities: ['read']
    };
    const made = await new SubstrateClient({ endpoint: E, token: 't' }).admin.register(input);
    expect(made.directory).toEqual({ created: true, frame: 'cortext/AgentIdentity' });
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/keys`, () =>
        HttpResponse.json(body({ created: false, reason: 'opted_out' }), { status: 201 })
      )
    );
    const none = await new SubstrateClient({ endpoint: E, token: 't' }).admin.register(input);
    expect(none.directory).toEqual({ created: false, reason: 'opted_out' });
  });

  it('register of a live kid surfaces 409 kid_already_live', async () => {
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/keys`, () =>
        HttpResponse.json(
          { code: 'kid_already_live', message: "kid 'c@h' is already registered and live" },
          { status: 409 }
        )
      )
    );
    const err = await new SubstrateClient({ endpoint: E, token: 't' }).admin
      .register({
        kid: 'c@h',
        publicKey: PEM,
        algorithm: 'EdDSA',
        namespaces: ['cortext'],
        capabilities: ['read']
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'kid_already_live' });
  });

  it('invite POSTs the grant and ttlMs, and returns the code', async () => {
    let body: unknown;
    mockHandlers(
      http.post(`${E}/substrate/v1/_system/invites`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          {
            code: 'inv_secret',
            expiresAt: '2026-10-07T00:00:00.000Z',
            namespaces: ['cortext:mutate+read'],
            capabilities: ['read']
          },
          { status: 201 }
        );
      })
    );
    const out = await new SubstrateClient({ endpoint: E, token: 't' }).admin.invite({
      namespaces: ['cortext:mutate+read'],
      capabilities: ['read'],
      ttlMs: 3_600_000
    });
    expect(body).toEqual({
      namespaces: ['cortext:mutate+read'],
      capabilities: ['read'],
      ttlMs: 3_600_000
    });
    expect(out.code).toBe('inv_secret');
  });
});

describe('refusal bodies', () => {
  const client = () => new SubstrateClient({ endpoint: E, token: 't' });

  it('a NetworkError keeps the whole refusal body', async () => {
    mockHandlers(
      http.patch(`${E}/substrate/v1/_system/keys`, () =>
        HttpResponse.json(
          { code: 'unknown_namespaces', message: 'm', unknownNamespaces: ['cortex'] },
          { status: 422 }
        )
      )
    );
    const err = await client()
      .admin.update({ kid: 'k', namespaces: ['cortex'], capabilities: ['read'] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).code).toBe('unknown_namespaces');
    expect((err as NetworkError).body).toMatchObject({ unknownNamespaces: ['cortex'] });
  });

  it("reads the recall plugin's nested { error: { code, message } } shape", async () => {
    mockHandlers(
      http.patch(`${E}/substrate/v1/_system/keys`, () =>
        HttpResponse.json(
          { error: { code: 'unavailable', message: 'embedder down' } },
          { status: 503 }
        )
      )
    );
    const err = (await client()
      .admin.revoke('k')
      .catch((e: unknown) => e)) as NetworkError;
    expect(err.code).toBe('unavailable');
    expect(err.serverMessage).toBe('embedder down');
  });

  it('a coded 403 is an AuthError carrying its body', async () => {
    mockHandlers(
      http.patch(`${E}/substrate/v1/_system/keys`, () =>
        HttpResponse.json(
          { code: 'destructive_ops_disabled', message: 'SUBSTRATE_HARD_DELETE=refuse' },
          { status: 403 }
        )
      )
    );
    const err = (await client()
      .admin.revoke('k')
      .catch((e: unknown) => e)) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe('destructive_ops_disabled');
    expect(err.body).toMatchObject({ message: 'SUBSTRATE_HARD_DELETE=refuse' });
  });

  it('a non-JSON body leaves body absent and keeps the status', async () => {
    mockHandlers(
      http.patch(
        `${E}/substrate/v1/_system/keys`,
        () => new HttpResponse('<html>bad gateway</html>', { status: 502 })
      )
    );
    const err = (await client()
      .admin.revoke('k')
      .catch((e: unknown) => e)) as NetworkError;
    expect(err.status).toBe(502);
    expect(err.body).toBeUndefined();
  });
});
