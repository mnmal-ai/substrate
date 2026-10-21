import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { AuthError, NetworkError, SubstrateClient } from '../src/index.js';
import { mockHandlers } from './_setup.js';

const E = 'http://substrate.test';
const client = () => new SubstrateClient({ endpoint: E, token: 't' });

describe('transport error mapping', () => {
  it("a refusal body's `message` reaches NetworkError.serverMessage, with its code", async () => {
    mockHandlers(
      http.get(`${E}/substrate/v1/_system/keys`, () =>
        HttpResponse.json(
          { code: 'last_active_admin', message: 'refusing to revoke' },
          { status: 409 }
        )
      )
    );
    const err = await client()
      .admin.keys()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).toMatchObject({
      status: 409,
      code: 'last_active_admin',
      serverMessage: 'refusing to revoke'
    });
  });

  it('`error` still wins over `message` when a body carries both', async () => {
    mockHandlers(
      http.get(`${E}/substrate/v1/_system/keys`, () =>
        HttpResponse.json(
          { code: 'x', error: 'from error', message: 'from message' },
          { status: 500 }
        )
      )
    );
    const err = await client()
      .admin.keys()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ serverMessage: 'from error' });
  });

  it("a 403 keeps its body's code on AuthError: the gate's `forbidden` and a route's refusal differ", async () => {
    mockHandlers(
      http.get(`${E}/substrate/v1/_system/keys`, () =>
        HttpResponse.json(
          { code: 'directory_denied', message: 'cannot write the directory row' },
          { status: 403 }
        )
      )
    );
    const err = await client()
      .admin.keys()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toMatchObject({
      status: 403,
      code: 'directory_denied',
      serverMessage: 'cannot write the directory row'
    });
  });

  it('a 401 with no JSON body is still an AuthError, with no code', async () => {
    mockHandlers(
      http.get(`${E}/substrate/v1/_system/keys`, () => new HttpResponse('nope', { status: 401 }))
    );
    const err = (await client()
      .admin.keys()
      .catch((e: unknown) => e)) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.status).toBe(401);
    expect(err.code).toBeUndefined();
  });
  it('a non-string `error` does not block `message`: { error: { code }, message } keeps both', async () => {
    mockHandlers(
      http.get(`${E}/substrate/v1/_system/keys`, () =>
        HttpResponse.json({ error: { code: 'x' }, message: 'm' }, { status: 409 })
      )
    );
    const err = await client()
      .admin.keys()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).toMatchObject({ code: 'x', serverMessage: 'm' });
  });

  it.each([401, 403])(
    'a nested-shape %i is a coded AuthError carrying its body',
    async (status) => {
      const body = { error: { code: 'forbidden', message: 'admin required' } };
      mockHandlers(
        http.get(`${E}/substrate/v1/_system/keys`, () => HttpResponse.json(body, { status }))
      );
      const err = (await client()
        .admin.keys()
        .catch((e: unknown) => e)) as AuthError;
      expect(err).toBeInstanceOf(AuthError);
      expect(err).toMatchObject({ status, code: 'forbidden', serverMessage: 'admin required' });
      expect(err.body).toEqual(body);
    }
  );
});
