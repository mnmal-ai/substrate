/**
 * `GET /substrate/v1/onboard` is the first call every non-MCP consumer makes, and its
 * `instructions` block is a hand-written description of wire formats it does
 * not own. This suite holds it to them by DRIVING the served document: each
 * test reads a claim out of the live onboard response and issues that exact
 * request against the real routes.
 *
 * Reading `instructions.subscribe.body` out of the response and sending it is
 * a drift detector; writing the correct body by hand next to it would just be
 * a second copy of the route's own assumption.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { decodeStreamFrames, decodeWsEnvelope } from '@mnmal-ai/substrate-pack';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import type { CoordinatorPlugin } from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createH2Fetch } from '../../substrate-client/src/transport/h2-fetch.js';
import { type AuthConfig, signHs256 } from '../src/auth.js';
import { compose } from '../src/compose.js';

// The server speaks HTTP/2 only; the platform fetch speaks HTTP/1.1.
const h2fetch = createH2Fetch();

const NS = 'docs';
const KEY = `${NS}/Note`;
const SECOND_KEY = `${NS}/Tag`;

const HS_SECRET = 'onboard-wire-shapes-test-secret';
const HS_KID = 'onboard-wire';

/** Compose only reads `mode` here; the key list is what makes a token verifiable. */
function authConfig(mode: 'required' | 'attribute'): AuthConfig {
  return { mode, keys: [{ kid: HS_KID, alg: 'HS256', publicKey: HS_SECRET }] };
}

function validBearer(): string {
  return signHs256(
    { sub: 'onboard-caller', capabilities: ['read'], exp: Math.floor(Date.now() / 1000) + 300 },
    HS_SECRET,
    { kid: HS_KID }
  );
}

const notesPlugin: CoordinatorPlugin = {
  name: 'onboard-wire-fixture',
  contractVersion: '*',
  namespaces: [
    defineNamespace(NS, {
      Note: { fields: { text: field.string() } },
      Tag: { fields: { label: field.string() } }
    })
  ]
};

interface Section {
  method?: string;
  path?: string;
  accept?: string;
  body?: string;
  notes?: string[];
}

type Frame = Record<string, unknown> & { kind?: string; errors?: Array<{ code: string }> };

/** Substitute the document's placeholder key for the fixture's real one. */
function realise(example: string): Record<string, unknown> {
  return JSON.parse(example.replaceAll('<ns>/<TypeName>', KEY)) as Record<string, unknown>;
}

/** POST a frame to a stream route with the given Accept. */
function post(
  baseUrl: string,
  path: string,
  accept: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return h2fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept, ...headers },
    body: JSON.stringify(body)
  });
}

/**
 * Read up to `max` JSON frames off a frames body, then cancel it. A subscribe
 * never ends on its own, so the caller says how many frames it needs.
 */
async function readFrames(res: Response, max: number): Promise<Frame[]> {
  const out: Frame[] = [];
  const iter = decodeStreamFrames(res.body!)[Symbol.asyncIterator]();
  try {
    while (out.length < max) {
      const { value, done } = await iter.next();
      if (done === true) break;
      if (value.byteLength === 0) continue; // heartbeat
      out.push(JSON.parse(new TextDecoder().decode(value)) as Frame);
    }
  } finally {
    await iter.return?.(undefined);
  }
  return out;
}

const codesOf = (frames: Frame[]): string[] =>
  frames.flatMap((f) => (f.errors ?? []).map((e) => e.code));

describe('GET /substrate/v1/onboard describes the wire the routes actually speak', () => {
  let server: FastifySubstrateServer;
  let baseUrl: string;
  let body: Record<string, unknown>;
  let instructions: Record<string, Section | undefined>;

  /** The named section, or a failure naming what the document actually served. */
  const section = (name: string): Section => {
    const found = instructions[name];
    if (found === undefined) {
      throw new Error(
        `onboard instructions has no '${name}' section: ${Object.keys(instructions).join(', ')}`
      );
    }
    return found;
  };

  /** POST to the named section's path with its advertised Accept. */
  const send = (name: 'subscribe' | 'stream', frame: unknown): Promise<Response> => {
    const s = section(name);
    expect(s.method).toBe('POST');
    return post(baseUrl, s.path as string, s.accept as string, frame);
  };

  beforeEach(async () => {
    server = new FastifySubstrateServer();
    await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: NS }),
      coordinators: [notesPlugin]
    });
    const { address, port } = await server.start({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://${address}:${port}`;
    const res = await h2fetch(`${baseUrl}/substrate/v1/onboard`);
    body = (await res.json()) as Record<string, unknown>;
    instructions = body.instructions as Record<string, Section | undefined>;
  });

  afterEach(async () => {
    await server.stop({ grace: 0 });
  });

  it('serves the subscribe body example the route accepts', async () => {
    const res = await send('subscribe', realise(section('subscribe').body as string));
    expect(res.status).toBe(200);
    const frames = await readFrames(res, 1);

    // The documented example must not be the thing the route rejects.
    expect(codesOf(frames)).toEqual([]);
    expect(frames[0]).toMatchObject({ kind: 'snapshot' });
    expect(Object.keys(frames[0]?.data as object)).toEqual([KEY]);
  });

  it('serves a stream body example the route accepts as a dispatch', async () => {
    const notes = (section('stream').notes ?? []).join(' ');
    expect(notes).toMatch(/not_streamable/);

    const res = await send('stream', realise(section('stream').body as string));
    expect(res.status).toBe(200);
    const frames = await readFrames(res, 5);

    // autoCRUD types are not streamable, as the note claims: the body PARSES
    // and reaches dispatch, and the verdict is the engine's, not `invalid_frame`.
    expect(codesOf(frames)).not.toContain('invalid_frame');
    expect(codesOf(frames)).toContain('not_streamable');
  });

  it('refuses a non-frames Accept with 406 not_acceptable, as the note claims', async () => {
    const notes = (section('subscribe').notes ?? []).join(' ');
    expect(notes).toMatch(/406/);
    expect(notes).toMatch(/not_acceptable/);

    for (const accept of ['application/json', 'text/event-stream']) {
      const res = await post(
        baseUrl,
        section('subscribe').path as string,
        accept,
        realise(section('subscribe').body as string)
      );
      expect(res.status).toBe(406);
      expect((await res.json()).errors[0].code).toBe('not_acceptable');
    }
  });

  it('serves pack frames under the advertised substratePack accept', async () => {
    const accept = section('substratePack').accept as string;
    const res = await post(
      baseUrl,
      section('subscribe').path as string,
      accept,
      realise(section('subscribe').body as string)
    );
    expect(res.status).toBe(200);

    const iter = decodeStreamFrames(res.body!)[Symbol.asyncIterator]();
    let payload: Uint8Array | undefined;
    try {
      while (payload === undefined) {
        const { value, done } = await iter.next();
        if (done === true) break;
        if (value.byteLength > 0) payload = value;
      }
    } finally {
      await iter.return?.(undefined);
    }
    expect(payload).toBeDefined();
    expect(decodeWsEnvelope<Frame>(payload!, 'pack')).toMatchObject({ kind: 'snapshot' });
  });

  it('refuses the pre-unification grammar the document used to advertise', async () => {
    // The old `{ id, type, payload }` envelope is not a frame record: `id` is a
    // string, not a `{ params, fields }` entry.
    const res = await send('subscribe', {
      id: '1',
      type: 'subscribe',
      payload: { [KEY]: { params: {} } }
    });
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].code).toBe('invalid_frame');
  });

  it('documents subscribe params being narrower than query params', async () => {
    const notes = (section('subscribe').notes ?? []).join(' ');
    expect(notes).toMatch(/limit/i);

    // `limit` is a query param and is refused on subscribe — the divergence the
    // note claims. A consumer carrying its POST /substrate/v1/query params across gets
    // `unknown_param`, not a silently unbounded subscription.
    const refused = await send('subscribe', {
      [KEY]: { params: { limit: 1 }, fields: { id: true } }
    });
    expect(codesOf(await readFrames(refused, 1))).toContain('unknown_param');

    const accepted = await send('subscribe', {
      [KEY]: { params: { where: {} }, fields: { id: true } }
    });
    expect((await readFrames(accepted, 1))[0]).toMatchObject({ kind: 'snapshot' });
  });

  it('subscribe accepts the multi-key frame stream refuses', async () => {
    const res = await send('subscribe', {
      [KEY]: { params: { where: {} }, fields: { id: true } },
      [SECOND_KEY]: { params: { where: {} }, fields: { id: true } }
    });
    // One snapshot per key.
    const frames = await readFrames(res, 2);

    expect(codesOf(frames)).toEqual([]);
    const keys = frames.flatMap((f) => Object.keys((f.data ?? {}) as object));
    expect(keys).toEqual(expect.arrayContaining([KEY, SECOND_KEY]));
  });

  it('documents stream being single-key while subscribe is not', async () => {
    const notes = (section('stream').notes ?? []).join(' ');
    expect(notes).toMatch(/stream_multi_key/);

    const res = await send('stream', {
      [KEY]: { params: {}, fields: { id: true } },
      [SECOND_KEY]: { params: {}, fields: { id: true } }
    });
    expect(codesOf(await readFrames(res, 5))).toContain('stream_multi_key');
  });

  it('no longer advertises WebSocket, tickets or SSE anywhere', () => {
    const text = JSON.stringify(body);
    expect(text).not.toContain('/substrate/v1/ws');
    expect(text).not.toContain('ticket');
    expect(text).not.toContain('text/event-stream');
  });

  it('the whoami section it advertises is a route that answers', async () => {
    // whoami must be advertised, and the advertisement must match the route.
    const path = section('whoami').path as string;
    expect(path).toBe('/substrate/v1/whoami');

    const res = await h2fetch(`${baseUrl}${path}`);
    expect(res.status).toBe(200);

    // No auth is configured on this fixture, so the document's claim that the
    // two are separate fields is checkable here.
    const whoami = (await res.json()) as { authEnabled: unknown; identity: unknown };
    expect(whoami).toEqual({ authEnabled: false, identity: null });
  });

  it('refuses the query-parameter spelling of schema scoping it warns about', async () => {
    const notes = (section('schema').notes ?? []).join(' ');
    expect(notes).toMatch(/path segments/i);

    const res = await h2fetch(`${baseUrl}/substrate/v1/schema?namespace=${NS}`);
    // 400, not a 404 about `default`: the caller named a namespace, so the
    // answer must be about the shape of the request rather than about a
    // namespace they never asked for.
    expect(res.status).toBe(400);
    expect((await res.json()).hint).toContain(`/substrate/v1/schema/${NS}`);
  });
});

/**
 * The one auth claim the stream sections make — "auth is the same as POST
 * /substrate/v1/query" — which the suite above cannot reach: it composes a
 * server with no auth at all. Each case drives subscribe and query side by
 * side, so the claim is checked against the query route rather than a second
 * copy of its logic.
 */
describe('GET /substrate/v1/onboard describes the auth the stream routes actually enforce', () => {
  let server: FastifySubstrateServer | null = null;
  let baseUrl: string;
  let subscribe: Section;

  /** Compose, boot, and read the served claims. Replaces any server already up. */
  async function start(mode: 'required' | 'attribute'): Promise<void> {
    await stop();
    server = new FastifySubstrateServer();
    await compose({
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: NS }),
      coordinators: [notesPlugin],
      auth: authConfig(mode)
    });
    const { address, port } = await server.start({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://${address}:${port}`;
    // Onboarding needs a key under `required`.
    const res = await h2fetch(`${baseUrl}/substrate/v1/onboard`, {
      headers: { authorization: `Bearer ${validBearer()}` }
    });
    subscribe = (await res.json()).instructions.subscribe as Section;
    expect((subscribe.notes ?? []).join(' ')).toMatch(
      /auth is the same as POST \/substrate\/v1\/query/
    );
  }

  async function stop(): Promise<void> {
    if (server === null) return;
    const running = server;
    server = null;
    await running.stop({ grace: 0 });
  }

  afterEach(stop);

  const frame = { [KEY]: { params: { where: {} }, fields: { id: true } } };

  /** The status of a subscribe and of a query, each sent with `headers`. */
  async function statuses(
    headers: Record<string, string>
  ): Promise<{ subscribe: Response; query: number }> {
    const sub = await post(
      baseUrl,
      subscribe.path as string,
      subscribe.accept as string,
      frame,
      headers
    );
    const query = await h2fetch(`${baseUrl}/substrate/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(frame)
    });
    return { subscribe: sub, query: query.status };
  }

  it('refuses a tokenless subscribe under required exactly as it refuses a tokenless query', async () => {
    await start('required');
    const { subscribe: sub, query } = await statuses({});
    expect(query).toBe(401);
    expect(sub.status).toBe(query);
  });

  it('admits a tokenless subscribe under attribute exactly as it admits a tokenless query', async () => {
    await start('attribute');
    const { subscribe: sub, query } = await statuses({});
    expect(query).toBe(200);
    expect(sub.status).toBe(query);
    expect((await readFrames(sub, 1))[0]).toMatchObject({ kind: 'snapshot' });
  });

  it.each(['required', 'attribute'] as const)(
    'refuses a present-but-invalid token under mode=%s, as query does',
    async (mode) => {
      await start(mode);
      // `attribute` relaxes "you sent nothing", never "what you sent is broken".
      const { subscribe: sub, query } = await statuses({ authorization: 'Bearer not-a-real-jwt' });
      expect(query).toBe(401);
      expect(sub.status).toBe(query);
    }
  );

  it('attributes a valid token under mode=attribute rather than merely admitting it', async () => {
    await start('attribute');
    const authorization = `Bearer ${validBearer()}`;

    const { subscribe: sub, query } = await statuses({ authorization });
    expect(query).toBe(200);
    expect(sub.status).toBe(200);
    expect((await readFrames(sub, 1))[0]).toMatchObject({ kind: 'snapshot' });

    // The same token, on the route that reports who it was read as.
    const res = await h2fetch(`${baseUrl}/substrate/v1/whoami`, { headers: { authorization } });
    const whoami = (await res.json()) as {
      authEnabled: boolean;
      identity: { id: string } | null;
    };
    expect(whoami.authEnabled).toBe(true);
    expect(whoami.identity?.id).toBe('onboard-caller');
  });
});
