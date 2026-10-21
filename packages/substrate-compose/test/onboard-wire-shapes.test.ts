/**
 * `GET /substrate/v1/onboard` is the first call every non-MCP consumer makes, and its
 * `instructions` block is a hand-written description of wire formats it does
 * not own. This suite holds it to them by DRIVING the served document: each
 * test reads a claim out of the live onboard response and issues that exact
 * request against the real routes.
 *
 * Reading `instructions.subscribe.frame` out of the response and sending it is
 * a drift detector; writing the correct frame by hand next to it would just be
 * a second copy of the route's own assumption.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import type { CoordinatorPlugin } from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type AuthConfig, signHs256 } from '../src/auth.js';
import { compose } from '../src/compose.js';

const NS = 'docs';
const KEY = `${NS}/Note`;
const SECOND_KEY = `${NS}/Tag`;

const HS_SECRET = 'onboard-wire-shapes-test-secret';
const HS_KID = 'onboard-wire';
const TICKET_SECRET = 'onboard-wire-shapes-ticket-secret';

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
  frame?: string;
  notes?: string[];
  paths?: string[];
  path?: string;
  authByMode?: Record<string, string>;
}

/** Substitute the document's placeholder key for the fixture's real one. */
function realise(frameExample: string): Record<string, unknown> {
  return JSON.parse(frameExample.replaceAll('<ns>/<TypeName>', KEY)) as Record<string, unknown>;
}

describe('GET /substrate/v1/onboard describes the wire the routes actually speak', () => {
  let server: FastifySubstrateServer;
  let baseUrl: string;
  let wsUrl: string;
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
    wsUrl = `ws://${address}:${port}/substrate/v1/ws`;
    const res = await fetch(`${baseUrl}/substrate/v1/onboard`);
    instructions = (await res.json()).instructions;
  });

  afterEach(async () => {
    await server.stop({ grace: 0 });
  });

  /** Send frames on one socket, collect replies until it falls quiet. */
  async function wsExchange(
    frames: unknown[],
    settleMs = 150
  ): Promise<Array<Record<string, unknown>>> {
    const sock = new WebSocket(wsUrl);
    const received: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      sock.on('error', reject);
      sock.on('open', () => resolve());
    });
    sock.on('message', (d) => received.push(JSON.parse(String(d)) as Record<string, unknown>));
    for (const f of frames) sock.send(JSON.stringify(f));
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, settleMs);
      t.unref?.();
    });
    sock.close();
    return received;
  }

  it('serves the subscribe frame example the WS route accepts', async () => {
    const frames = await wsExchange([realise(section('subscribe').frame as string)]);

    // The documented example must not be the thing the route rejects.
    expect(frames.map((f) => f.kind)).not.toContain('error');
    expect(frames[0]).toMatchObject({ kind: 'snapshot' });
    expect(Object.keys(frames[0]?.data as object)).toEqual([KEY]);
  });

  it('serves a stream frame example the WS route accepts as a dispatch', async () => {
    const frames = await wsExchange([realise(section('stream').frame as string)]);

    // autoCRUD types are not streamable, so the honest bar is that the frame
    // PARSES and reaches dispatch — `not_streamable` is an engine verdict on a
    // well-formed frame, `invalid_frame` is a rejection of the grammar itself.
    const codes = frames.flatMap((f) =>
      ((f.errors ?? []) as Array<{ code: string }>).map((e) => e.code)
    );
    expect(codes).not.toContain('invalid_frame');
  });

  it('refuses the pre-unification grammar the document used to advertise', async () => {
    // Pins the claim as discriminating: `op`/`frame` is not merely one accepted
    // spelling among several, and the `{ type, payload }` shape is refused.
    const frames = await wsExchange([
      { id: '1', type: 'subscribe', payload: { [KEY]: { params: {} } } }
    ]);

    expect(frames[0]).toMatchObject({ kind: 'error' });
    expect((frames[0]!.errors as Array<{ code: string }>)[0]?.code).toBe('invalid_frame');
  });

  it('documents subscribe params being narrower than query params', async () => {
    const notes = (section('subscribe').notes ?? []).join(' ');
    expect(notes).toMatch(/limit/i);

    // `limit` is a query param and is refused on subscribe — the divergence the
    // note claims. A consumer carrying its POST /substrate/v1/query params across gets
    // `unknown_param`, not a silently unbounded subscription.
    const frames = await wsExchange([
      { id: '1', op: 'subscribe', frame: { [KEY]: { params: { limit: 1 }, fields: { id: true } } } }
    ]);
    expect((frames[0]!.errors as Array<{ code: string }>)[0]?.code).toBe('unknown_param');

    const accepted = await wsExchange([
      {
        id: '1',
        op: 'subscribe',
        frame: { [KEY]: { params: { where: {} }, fields: { id: true } } }
      }
    ]);
    expect(accepted[0]).toMatchObject({ kind: 'snapshot' });
  });

  it('subscribe accepts the multi-key frame stream refuses', async () => {
    const frames = await wsExchange([
      {
        id: '1',
        op: 'subscribe',
        frame: {
          [KEY]: { params: { where: {} }, fields: { id: true } },
          [SECOND_KEY]: { params: { where: {} }, fields: { id: true } }
        }
      }
    ]);

    const keys = frames.flatMap((f) => Object.keys((f.data ?? {}) as object));
    expect(keys).toEqual(expect.arrayContaining([KEY, SECOND_KEY]));
  });

  it('documents stream being single-key while subscribe is not', async () => {
    const multi = {
      [KEY]: { params: {}, fields: { id: true } },
      [SECOND_KEY]: { params: {}, fields: { id: true } }
    };
    const frames = await wsExchange([{ id: '1', op: 'stream', frame: multi }]);

    const codes = frames.flatMap((f) =>
      ((f.errors ?? []) as Array<{ code: string }>).map((e) => e.code)
    );
    expect(codes).toContain('stream_multi_key');
  });

  it('names the SSE transport, and every path it names answers', async () => {
    // An SSE consumer reading only this document must be told the transport
    // is there.
    const paths = section('sse').paths as string[];
    expect(paths).toContain('/substrate/v1/subscribe');

    const res = await fetch(`${baseUrl}/substrate/v1/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [KEY]: { params: { where: {} }, fields: { id: true } } })
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    let text = '';
    for (let i = 0; i < 2; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();

    // The envelope the SSE note claims — `event: <kind>` with `{ key, rows }` —
    // and NOT the WS envelope, which keys `data` by the frame key.
    expect(text).toContain('event: snapshot');
    expect(text).toContain(`"key":"${KEY}"`);
    expect(text).toContain('"rows":');
  });

  it('the whoami section it advertises is a route that answers', async () => {
    // whoami must be advertised, and the advertisement must match the route.
    const path = section('whoami').path as string;
    expect(path).toBe('/substrate/v1/whoami');

    const res = await fetch(`${baseUrl}${path}`);
    expect(res.status).toBe(200);

    // No auth is configured on this fixture, so the document's claim that the
    // two are separate fields is checkable here.
    const body = (await res.json()) as { authEnabled: unknown; identity: unknown };
    expect(body).toEqual({ authEnabled: false, identity: null });
  });

  it('serves a WS whoami op that the route accepts', async () => {
    const notes = (section('subscribe').notes ?? []).join(' ');
    expect(notes).toMatch(/whoami/);

    const frames = await wsExchange([{ id: '1', op: 'whoami' }]);

    expect(frames[0]).toMatchObject({ id: '1', kind: 'whoami' });
    expect(frames.map((f) => f.kind)).not.toContain('error');
  });

  it('refuses the query-parameter spelling of schema scoping it warns about', async () => {
    const notes = (section('schema').notes ?? []).join(' ');
    expect(notes).toMatch(/path segments/i);

    const res = await fetch(`${baseUrl}/substrate/v1/schema?namespace=${NS}`);
    // 400, not a 404 about `default`: the caller named a namespace, so the
    // answer must be about the shape of the request rather than about a
    // namespace they never asked for.
    expect(res.status).toBe(400);
    expect((await res.json()).hint).toContain(`/substrate/v1/schema/${NS}`);
  });
});

/**
 * The auth claims in the same block, which the suite above cannot reach: it
 * composes a server with no auth at all.
 *
 * The matrix is {required, attribute} × {absent, invalid, valid} minus the two
 * cells the document says nothing about. It is driven rather than asserted from
 * a second copy of the route's own logic, and each cell is the one the note
 * names — including the cell `attribute` must NOT open, since a careless
 * "just honour the mode" reading of that note would open it.
 */
describe('GET /substrate/v1/onboard describes the auth the WS route actually enforces', () => {
  let server: FastifySubstrateServer | null = null;
  let baseUrl: string;
  let wsUrl: string;
  let authByMode: Record<string, string>;

  /**
   * The document's own cell for `name`, or a failure naming what it served. A
   * missing cell is the drift this suite exists to catch, so it must not read
   * as an undefined that quietly matches nothing.
   */
  const cell = (name: string): string => {
    const found = authByMode?.[name];
    if (found === undefined) {
      throw new Error(
        `onboard subscribe.authByMode has no '${name}' cell: ${Object.keys(authByMode ?? {}).join(', ')}`
      );
    }
    return found;
  };

  /** Compose, boot, and read the served claims. Replaces any server already up. */
  async function start(mode: 'required' | 'attribute'): Promise<void> {
    await stop();
    server = new FastifySubstrateServer();
    await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: NS }),
      coordinators: [notesPlugin],
      auth: authConfig(mode),
      streamTicketSecret: TICKET_SECRET
    });
    const { address, port } = await server.start({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://${address}:${port}`;
    wsUrl = `ws://${address}:${port}/substrate/v1/ws`;
    // Onboarding needs a key under `required`.
    const res = await fetch(`${baseUrl}/substrate/v1/onboard`, {
      headers: { authorization: `Bearer ${validBearer()}` }
    });
    authByMode = (await res.json()).instructions.subscribe.authByMode as Record<string, string>;
  }

  async function stop(): Promise<void> {
    if (server === null) return;
    const running = server;
    server = null;
    await running.stop({ grace: 0 });
  }

  afterEach(stop);

  /**
   * Upgrade with the given headers and report what the socket did. Resolves on
   * close, or after `settleMs` of an open socket that was never closed — the
   * two outcomes the note distinguishes.
   */
  async function upgrade(
    headers: Record<string, string>,
    send: unknown[] = [],
    settleMs = 200
  ): Promise<{ closeCode: number | null; frames: Array<Record<string, unknown>> }> {
    const sock = new WebSocket(wsUrl, { headers });
    const frames: Array<Record<string, unknown>> = [];
    sock.on('message', (d) => frames.push(JSON.parse(String(d)) as Record<string, unknown>));
    const closeCode = await new Promise<number | null>((resolve, reject) => {
      const t = setTimeout(() => resolve(null), settleMs);
      t.unref?.();
      sock.on('error', reject);
      sock.on('open', () => {
        for (const f of send) sock.send(JSON.stringify(f));
      });
      sock.on('close', (code) => {
        clearTimeout(t);
        resolve(code);
      });
    });
    sock.close();
    return { closeCode, frames };
  }

  it('claims 4001 for a tokenless socket under required, and delivers it', async () => {
    await start('required');
    expect(cell('required')).toMatch(/4001/);
    expect(cell('required')).toMatch(/unauthorized/);

    const { closeCode, frames } = await upgrade({});

    expect(closeCode).toBe(4001);
    expect(frames[0]).toMatchObject({ kind: 'error' });
    expect((frames[0]!.errors as Array<{ code: string }>)[0]?.code).toBe('unauthorized');
  });

  it('claims attribute admits a tokenless socket anonymously, and it does', async () => {
    await start('attribute');
    // The cell must say ADMITTED, not refused.
    expect(cell('attribute')).toMatch(/ADMITTED/);
    expect(cell('attribute')).not.toMatch(/4001/);

    // Admitted AND anonymous, in one frame, using the op the document
    // advertises two bullets earlier. A socket that merely stayed open would
    // not distinguish "admitted anonymously" from "admitted as somebody".
    const { closeCode, frames } = await upgrade({}, [{ id: '1', op: 'whoami' }]);

    expect(closeCode).toBeNull();
    expect(frames[0]).toMatchObject({
      id: '1',
      kind: 'whoami',
      data: { authEnabled: true, identity: null }
    });
  });

  it.each(['required', 'attribute'] as const)(
    'refuses a present-but-invalid token under mode=%s, as the note claims',
    async (mode) => {
      await start(mode);
      expect(cell('invalidToken')).toMatch(/BOTH modes/);

      // The cell `attribute` must NOT open — it relaxes "you sent nothing",
      // never "what you sent is broken". A careless reading of the note that
      // gated on `mode` alone would open exactly this one.
      const { closeCode } = await upgrade({ authorization: 'Bearer not-a-real-jwt' });
      expect(closeCode).toBe(4001);
    }
  );

  it('attributes a valid token under mode=attribute rather than merely admitting it', async () => {
    await start('attribute');

    const { closeCode, frames } = await upgrade({ authorization: `Bearer ${validBearer()}` }, [
      { id: '1', op: 'whoami' }
    ]);

    expect(closeCode).toBeNull();
    const data = frames[0]?.data as { authEnabled: boolean; identity: { id: string } | null };
    expect(data.authEnabled).toBe(true);
    expect(data.identity?.id).toBe('onboard-caller');

    // The identity shape the whoami note advertises, read out of the served
    // document rather than restated here.
    const res = await fetch(`${baseUrl}/substrate/v1/onboard`);
    const notes = ((await res.json()).instructions.whoami.notes as string[]).join(' ');
    const advertised = /otherwise \{ ([^}]+) \}/.exec(notes)?.[1]?.split(/,\s*/).sort();
    expect(advertised).toBeDefined();
    expect(Object.keys(data.identity ?? {}).sort()).toEqual(advertised);
  });
});
