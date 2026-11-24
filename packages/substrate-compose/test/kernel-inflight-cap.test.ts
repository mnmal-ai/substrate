import type { SubstrateRequest } from '@mnmal-ai/substrate-types';
import { expect, it } from 'vitest';
import { withInFlightCap } from '../src/kernel.js';

const req = (id?: string, peerIp?: string) =>
  ({
    method: 'POST',
    path: '/x',
    headers: {},
    query: {},
    params: {},
    ...(id !== undefined ? { identity: { id, grants: {} } } : {}),
    ...(peerIp !== undefined ? { peerIp } : {})
  }) as SubstrateRequest;

it('answers 429 past the cap for one caller and frees the slot when a request ends', async () => {
  const release: Array<() => void> = [];
  const handler = withInFlightCap(async () => {
    await new Promise<void>((r) => release.push(r));
    return { status: 200, headers: {}, body: Buffer.from('') };
  }, 2);

  const a1 = handler(req('a'));
  const a2 = handler(req('a'));
  const refused = await handler(req('a'));
  expect(refused.status).toBe(429);
  expect(JSON.parse(String(refused.body))).toMatchObject({ code: 'too_many_in_flight', max: 2 });

  // Another identity, and a caller known only by address, have their own slots.
  const b = handler(req('b'));
  const anon = handler(req(undefined, '203.0.113.7'));
  expect(release).toHaveLength(4);

  release[0]?.();
  expect((await a1).status).toBe(200);
  const a3 = handler(req('a'));
  expect(release).toHaveLength(5);
  for (const r of release) r();
  expect((await Promise.all([a2, a3, b, anon])).map((r) => r.status)).toEqual([200, 200, 200, 200]);
});

it('frees the slot when the handler throws', async () => {
  let fail = true;
  const handler = withInFlightCap(async () => {
    if (fail) throw new Error('boom');
    return { status: 200, headers: {}, body: Buffer.from('') };
  }, 1);
  await expect(handler(req('a'))).rejects.toThrow('boom');
  fail = false;
  expect((await handler(req('a'))).status).toBe(200);
});
