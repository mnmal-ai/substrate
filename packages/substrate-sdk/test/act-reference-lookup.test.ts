/** A sketch can name a referenced record by one of its fields, and the caller as `@me`. */

import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { Identity, Row } from '@mnmal-ai/substrate-types';
import { expect, it } from 'vitest';
import { defineNamespace, field } from '../src/index.js';

const NOW = new Date('2026-05-01T12:00:00.000Z');
const grants = { mail: ['read', 'mutate'] };
const alice: Identity = { id: 'alice@host', agentKeyId: 'alice@host', grants };

async function boot() {
  const edges = new MemoryEdgesStore({ now: () => NOW });
  const dataset = new MemoryDataset({ namespace: 'mail', walkReference: true });
  const registry = new Registry();
  defineNamespace('mail', {
    Person: { fields: { kid: field.string(), team: field.string() } },
    Message: {
      fields: { subject: field.string(), recipient: field.crossRef('mail', 'Person') }
    }
  }).install({ registry, dataset, edges });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('mail', dataset);
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([['mail', { registry }]]),
    datasets,
    edges
  });
  const act = (sketch: string, identity: Identity | null = alice, mode?: 'dry-run') =>
    engine.act({ sketch, ctx: { identity, now: NOW }, ...(mode !== undefined ? { mode } : {}) });
  for (const sketch of [
    'create Person kid=alice@host team=core as $a; create Message subject=one recipient=$a',
    'create Person kid=bob@host team=core as $b; create Message subject=two recipient=$b'
  ]) {
    expect(await act(sketch)).toMatchObject({ ok: true });
  }
  const subjects = async () =>
    (await dataset.read('Message', {})).rows.map((r: Row) => r.subject).sort();
  return { act, dataset, subjects };
}

const found = (res: unknown) =>
  (res as { found?: Array<{ rows: Row[] }> }).found?.[0]?.rows.map((r) => r.subject);

it('finds by a field of the referenced record, and by the caller', async () => {
  const { act } = await boot();
  expect(found(await act('find Message recipient=kid:bob@host fields=subject'))).toEqual(['two']);
  expect(found(await act('find Message recipient=kid:@me fields=subject'))).toEqual(['one']);
});

it('fills a written reference the same way', async () => {
  const { act, dataset } = await boot();
  expect(await act('create Message subject=three recipient=kid:bob@host')).toMatchObject({
    ok: true
  });
  const bob = (await dataset.read('Person', { where: { kid: { eq: 'bob@host' } } })).rows[0];
  const three = (await dataset.read('Message', { where: { subject: { eq: 'three' } } })).rows[0];
  expect(three?.recipient).toBe(bob?.id);
});

it('fails the step when no record, or more than one, holds the value', async () => {
  const { act, subjects } = await boot();
  const none = await act('create Message subject=x recipient=kid:nobody@host');
  expect(none).toMatchObject({ ok: false, error: { code: 'not_found' } });
  const many = await act('create Message subject=x recipient=team:core');
  expect(many).toMatchObject({ ok: false, error: { code: 'ambiguous_reference' } });
  expect(await subjects()).toEqual(['one', 'two']);
});

it('keeps an id that names no field a plain id, and shows the lookup in a dry run', async () => {
  const { act } = await boot();
  // `nofield:x` names no field of Person, so it is sent as the id it looks like.
  expect(found(await act('find Message recipient=nofield:x fields=subject'))).toEqual([]);
  const dry = await act('find Message recipient=kid:@me fields=subject', alice, 'dry-run');
  expect(JSON.stringify(dry)).toContain('recipient=kid:alice@host');
});
