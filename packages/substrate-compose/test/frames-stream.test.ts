/**
 * Length-prefixed frame streams on POST /substrate/v1/subscribe and /stream:
 * negotiation, the payload per encoding, terminal frames, heartbeats, and the
 * oversized-frame refusal.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import {
  applyDecodePlanInPlace,
  buildDecodePlan,
  decodeStreamFrames,
  decodeWsEnvelope,
  FRAMES_JSON_MIME,
  FRAMES_PACK_MIME,
  type WireMode
} from '@mnmal-ai/substrate-pack';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { CoordinatorPlugin, FieldInput, WsResponseFrame } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { type AuthConfig, signHs256 } from '../src/auth.js';
import { compose } from '../src/compose.js';
import { createConnectionLimiter } from '../src/routes/connection-limit.js';
import { createFramesTransport } from '../src/routes/frames-transport.js';
import { serializeFrame } from '../src/routes/pack-frame.js';
import { registerStreamRoutes } from '../src/routes/stream-routes.js';

const todoPlugin: CoordinatorPlugin = {
  name: 'frames-stream-fixture',
  contractVersion: '*',
  namespaces: [
    defineNamespace('default', {
      Todo: { fields: { id: field.string(), title: field.string() }, autoCrud: true }
    })
  ]
};
const FRAME = { 'default/Todo': { fields: { id: true, title: true } } };

/** The frames of a body, decoded as a client would, one at a time. */
async function* framesOf(
  body: ReadableStream<Uint8Array>,
  mode: WireMode,
  plan: ReturnType<typeof buildDecodePlan> = []
): AsyncGenerator<WsResponseFrame> {
  for await (const payload of decodeStreamFrames(body)) {
    const frame =
      mode === 'json'
        ? (JSON.parse(new TextDecoder().decode(payload)) as WsResponseFrame)
        : decodeWsEnvelope<WsResponseFrame>(payload, 'pack');
    applyDecodePlanInPlace(frame, plan);
    yield frame;
  }
}

async function next(frames: AsyncGenerator<WsResponseFrame>): Promise<WsResponseFrame> {
  const { value, done } = await frames.next();
  if (done === true) throw new Error('stream ended early');
  return value;
}

describe('frame streams over a real socket', () => {
  it('subscribe frames+json: snapshot, then add/update/remove after mutates, never compressed', async () => {
    const server = new FastifySubstrateServer();
    const composed = await compose({
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      coordinators: [todoPlugin]
    });
    const { address, port } = await server.start({ host: '127.0.0.1', port: 0 });
    const base = `http://${address}:${port}`;
    const mutate = (body: unknown) =>
      fetch(`${base}/substrate/v1/mutate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }).then((r) => r.json() as Promise<{ data: Record<string, { id: string }> }>);
    try {
      await mutate({ 'default/createTodo': { params: { title: 'seeded' } } });
      const res = await fetch(`${base}/substrate/v1/subscribe`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: FRAMES_JSON_MIME,
          'accept-encoding': 'gzip, br'
        },
        body: JSON.stringify(FRAME)
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(FRAMES_JSON_MIME);
      expect(res.headers.get('content-encoding')).toBeNull();
      const frames = framesOf(res.body as ReadableStream<Uint8Array>, 'json');

      const snapshot = await next(frames);
      expect(snapshot).toMatchObject({ id: 'frames-subscribe', kind: 'snapshot' });
      expect(snapshot.data).toEqual({
        'default/Todo': [{ id: expect.any(String), title: 'seeded' }]
      });

      const created = await mutate({ 'default/createTodo': { params: { title: 'live' } } });
      const id = created.data['default/createTodo']?.id as string;
      expect(await next(frames)).toMatchObject({
        kind: 'add',
        data: { 'default/Todo': { id, title: 'live' } }
      });

      await mutate({ 'default/updateTodo': { params: { id, title: 'edited' } } });
      expect(await next(frames)).toMatchObject({
        kind: 'update',
        data: { 'default/Todo': { id, title: 'edited' } }
      });

      await mutate({ 'default/deleteTodo': { params: { id } } });
      expect(await next(frames)).toMatchObject({ kind: 'remove', removedId: id });
      await frames.return(undefined);
    } finally {
      await composed.stop();
    }
  });
});

describe('frame streams through the route', () => {
  async function setup(auth?: AuthConfig) {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      coordinators: [todoPlugin],
      ...(auth !== undefined ? { auth } : {})
    });
    const open = (path: string, accept: string, headers: Record<string, string> = {}) =>
      server.inject({
        method: 'POST',
        path,
        headers: { accept, ...headers },
        body: Buffer.from(JSON.stringify(FRAME))
      });
    return { server, composed, open };
  }

  it('frames+pack decodes with the frame decode plan', async () => {
    const { server, composed, open } = await setup();
    await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      body: Buffer.from(JSON.stringify({ 'default/createTodo': { params: { title: 'packed' } } }))
    });
    const res = await open('/substrate/v1/subscribe', FRAMES_PACK_MIME);
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toBe(FRAMES_PACK_MIME);
    const plan = buildDecodePlan(FRAME, composed.engine.federatedSchema());
    const frames = framesOf(res.body as ReadableStream<Uint8Array>, 'pack', plan);
    expect(await next(frames)).toMatchObject({
      kind: 'snapshot',
      data: { 'default/Todo': [{ id: expect.any(String), title: 'packed' }] }
    });
    await frames.return(undefined);
    await composed.stop();
  });

  it.each(['json', 'pack'] as const)(
    'carries byte for byte what the WS route sends, in %s',
    async (mode) => {
      const { composed } = await setup();
      const fieldsByKey = new Map<string, FieldInput>([
        ['default/Todo', { id: true, title: true }]
      ]);
      const frame: WsResponseFrame = {
        id: 'p',
        kind: 'snapshot',
        shapes: { 'default/Todo': 'list' },
        // `extra` is not selected, so projection must drop it on both paths.
        data: { 'default/Todo': [{ id: 'a', title: 'big 9007199254740993', extra: 1n }] }
      };
      const { body, transport } = createFramesTransport({
        mode,
        engine: composed.engine,
        onTooLarge: () => {}
      });
      void transport.emit(frame, fieldsByKey);
      transport.close('complete');
      const payloads: Uint8Array[] = [];
      for await (const p of decodeStreamFrames(body)) payloads.push(p);
      expect(payloads).toHaveLength(1);
      expect(Buffer.from(payloads[0] as Uint8Array)).toEqual(
        Buffer.from(serializeFrame(frame, mode, fieldsByKey, composed.engine))
      );
      await composed.stop();
    }
  );

  it('ends an oversized snapshot with error and end, freeing its session slot', async () => {
    const cancels: string[] = [];
    const engine = {
      subscribe: async (input: { id: string; onFrame: (f: WsResponseFrame) => Promise<void> }) => {
        await input.onFrame({
          id: input.id,
          kind: 'snapshot',
          shapes: { 'default/Todo': 'list' },
          data: { 'default/Todo': [{ id: 'a', title: 'a'.repeat(17 * 1024 * 1024) }] }
        });
        return { id: input.id, cancel: (r?: string) => cancels.push(r ?? 'cancel') };
      }
    };
    const server = new MemorySubstrateServer();
    registerStreamRoutes(
      server,
      engine as never,
      new Set<string>(),
      (h) => h,
      () => {},
      undefined,
      createConnectionLimiter(1)
    );
    const open = () =>
      server.inject({
        method: 'POST',
        path: '/substrate/v1/subscribe',
        peerIp: '203.0.113.7',
        headers: { accept: FRAMES_JSON_MIME },
        body: Buffer.from(JSON.stringify(FRAME))
      });

    const first = await open();
    expect(first.status).toBe(200);
    const got: WsResponseFrame[] = [];
    for await (const f of framesOf(first.body as ReadableStream<Uint8Array>, 'json')) got.push(f);
    expect(got.map((f) => [f.kind, f.reason ?? f.errors?.[0]?.code])).toEqual([
      ['error', 'frame_too_large'],
      ['end', 'frame_too_large']
    ]);
    expect(cancels).toHaveLength(1);
    // The slot came back, so a cap of one admits the next stream.
    expect((await open()).status).toBe(200);
  });

  it('stream mode ends with end{final:true}', async () => {
    const { composed, open } = await setup();
    const res = await open('/substrate/v1/stream', FRAMES_JSON_MIME);
    const got: WsResponseFrame[] = [];
    for await (const f of framesOf(res.body as ReadableStream<Uint8Array>, 'json')) got.push(f);
    expect(got.at(-1)).toMatchObject({ id: 'frames-stream', kind: 'end', final: true });
    await composed.stop();
  });

  it('answers an auth failure with 401 JSON before any frame', async () => {
    const config: AuthConfig = {
      keys: [{ kid: 'k', alg: 'HS256', publicKey: 'frames-test-secret' }]
    };
    const { composed, open } = await setup(config);
    const anonymous = await open('/substrate/v1/subscribe', FRAMES_JSON_MIME);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers?.['content-type']).toContain('application/json');

    const token = signHs256(
      { sub: 't', capabilities: ['read'], exp: Math.floor(Date.now() / 1000) + 300 },
      'frames-test-secret',
      { kid: 'k' }
    );
    const authed = await open('/substrate/v1/subscribe', FRAMES_JSON_MIME, {
      authorization: `Bearer ${token}`
    });
    expect(authed.status).toBe(200);
    await (authed.body as ReadableStream<Uint8Array>).cancel();
    await composed.stop();
  });

  it('sends end{reason:server_restart} before the body closes on shutdown', async () => {
    const { composed, open } = await setup();
    const res = await open('/substrate/v1/subscribe', FRAMES_JSON_MIME);
    const got: WsResponseFrame[] = [];
    const drained = (async () => {
      for await (const f of framesOf(res.body as ReadableStream<Uint8Array>, 'json')) got.push(f);
    })();
    await composed.stop();
    await drained;
    expect(got.at(-1)).toMatchObject({ kind: 'end', reason: 'server_restart', final: true });
  });
});

describe('createFramesTransport', () => {
  const engine = {} as Parameters<typeof createFramesTransport>[0]['engine'];

  it('sends zero-length heartbeat frames while idle', async () => {
    const { body, transport } = createFramesTransport({
      mode: 'json',
      engine,
      heartbeatMs: 20,
      onTooLarge: () => {}
    });
    const reader = body.getReader();
    const { value } = await reader.read();
    expect(Array.from(value ?? [])).toEqual([0, 0, 0, 0]);
    transport.close('complete');
  });

  it('replaces an oversized frame with error and end, then asks the route to end the session', async () => {
    let ended = 0;
    // As the route does: ending the session closes the transport, releasing a parked emit.
    const { body, transport } = createFramesTransport({
      mode: 'json',
      engine,
      onTooLarge: () => {
        ended++;
        transport.close('cancelled');
      }
    });
    const huge = { id: 's', kind: 'chunk' as const, data: { 'x/Y': 'a'.repeat(17 * 1024 * 1024) } };
    await transport.emit(huge, new Map());
    await transport.emit({ id: 's', kind: 'chunk', data: { 'x/Y': 'dropped' } }, new Map());

    const got: WsResponseFrame[] = [];
    for await (const f of framesOf(body, 'json')) got.push(f);
    expect(got).toEqual([
      {
        id: 's',
        kind: 'error',
        errors: [{ code: 'frame_too_large', message: expect.stringContaining('exceeds') }]
      },
      { id: 's', kind: 'end', reason: 'frame_too_large', final: true }
    ]);
    expect(ended).toBe(1);
  });
});
