import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { NetworkError } from '../src/errors.js';
import { HttpTransport } from '../src/transport/http.js';
import { mockHandlers } from './_setup.js';

const ENDPOINT = 'http://substrate.test';

describe('HttpTransport', () => {
  it('POSTs query with JSON body + Accept json', async () => {
    let seenAccept: string | null = null;
    let seenBody: unknown = null;
    mockHandlers(
      http.post(`${ENDPOINT}/substrate/v1/query`, async ({ request }) => {
        seenAccept = request.headers.get('accept');
        seenBody = await request.json();
        return HttpResponse.json({ schemaVersion: 'v1', data: {}, shapes: {} });
      })
    );

    const t = new HttpTransport({ endpoint: ENDPOINT });
    const env = await t.query(
      { 'claude/Todo': { params: {}, fields: { id: true } } },
      { wire: 'json' }
    );

    expect(seenAccept).toBe('application/json');
    expect(seenBody).toEqual({ 'claude/Todo': { params: {}, fields: { id: true } } });
    expect(env).toEqual({ schemaVersion: 'v1', data: {}, shapes: {} });
  });

  it('sends Accept: application/vnd.substrate.pack when wire=pack + returns __packBytes marker', async () => {
    let seenAccept: string | null = null;
    const packedBytes = new Uint8Array([0x68, 0x70, 0x01]);
    mockHandlers(
      http.post(`${ENDPOINT}/substrate/v1/query`, ({ request }) => {
        seenAccept = request.headers.get('accept');
        return HttpResponse.arrayBuffer(packedBytes.buffer, {
          headers: { 'content-type': 'application/vnd.substrate.pack' }
        });
      })
    );

    const t = new HttpTransport({ endpoint: ENDPOINT });
    const result = await t.query(
      { 'claude/Todo': { params: {}, fields: { id: true } } },
      { wire: 'pack' }
    );
    expect(seenAccept).toBe('application/vnd.substrate.pack');
    const marker = result as unknown as { __packBytes: Uint8Array };
    expect(marker.__packBytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(marker.__packBytes)).toEqual([0x68, 0x70, 0x01]);
  });

  it('injects Bearer token from static opts', async () => {
    let seenAuth: string | null = null;
    mockHandlers(
      http.post(`${ENDPOINT}/substrate/v1/query`, ({ request }) => {
        seenAuth = request.headers.get('authorization');
        return HttpResponse.json({ schemaVersion: 'v', data: {}, shapes: {} });
      })
    );

    const t = new HttpTransport({ endpoint: ENDPOINT, token: 'tok-abc' });
    await t.query({}, {});
    expect(seenAuth).toBe('Bearer tok-abc');
  });

  it('calls getToken on each request when provided', async () => {
    let calls = 0;
    const getToken = async () => `tok-${++calls}`;
    const authHeaders: string[] = [];
    mockHandlers(
      http.post(`${ENDPOINT}/substrate/v1/query`, ({ request }) => {
        authHeaders.push(request.headers.get('authorization') ?? '');
        return HttpResponse.json({ schemaVersion: 'v', data: {}, shapes: {} });
      })
    );

    const t = new HttpTransport({ endpoint: ENDPOINT, getToken });
    await t.query({}, {});
    await t.query({}, {});
    expect(authHeaders).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });

  it('throws AuthError on 401', async () => {
    mockHandlers(
      http.post(`${ENDPOINT}/substrate/v1/query`, () => HttpResponse.text('nope', { status: 401 }))
    );
    const t = new HttpTransport({ endpoint: ENDPOINT });
    await expect(t.query({}, {})).rejects.toMatchObject({ name: 'AuthError', status: 401 });
  });

  it('throws AuthError on 403', async () => {
    mockHandlers(
      http.post(`${ENDPOINT}/substrate/v1/query`, () =>
        HttpResponse.text('forbidden', { status: 403 })
      )
    );
    const t = new HttpTransport({ endpoint: ENDPOINT });
    await expect(t.query({}, {})).rejects.toMatchObject({ name: 'AuthError', status: 403 });
  });

  it('throws NetworkError on fetch rejection', async () => {
    mockHandlers(http.post(`${ENDPOINT}/substrate/v1/query`, () => HttpResponse.error()));
    const t = new HttpTransport({ endpoint: ENDPOINT });
    await expect(t.query({}, {})).rejects.toBeInstanceOf(NetworkError);
  });

  it('federatedSchema GETs /substrate/v1/federated-schema', async () => {
    mockHandlers(
      http.get(`${ENDPOINT}/substrate/v1/federated-schema`, () =>
        HttpResponse.json({ claude: { schemaVersion: 'v1', types: {}, mutations: {} } })
      )
    );
    const t = new HttpTransport({ endpoint: ENDPOINT });
    const schema = await t.federatedSchema();
    expect(schema.claude).toMatchObject({ schemaVersion: 'v1' });
  });

  it('throws if both token and getToken are provided', () => {
    expect(
      () => new HttpTransport({ endpoint: ENDPOINT, token: 'x', getToken: async () => 'y' })
    ).toThrow(/provide `token` OR `getToken`/);
  });
});
