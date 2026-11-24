/** A declared action can call one of its namespace's own mutations. */

import {
  assertActionGraph,
  Engine,
  MemoryEdgesStore,
  type NamespaceConfig,
  Registry
} from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { ActionDecl, Identity, Row } from '@mnmal-ai/substrate-types';
import { expect, it } from 'vitest';
import { defineNamespace, field } from '../src/index.js';

const NOW = new Date('2026-05-01T12:00:00.000Z');
const alice: Identity = { id: 'alice', agentKeyId: 'alice', grants: { mail: ['read', 'mutate'] } };

function boot(actions: Record<string, ActionDecl>) {
  const edges = new MemoryEdgesStore({ now: () => NOW });
  const dataset = new MemoryDataset({ namespace: 'mail' });
  const registry = new Registry();
  defineNamespace('mail', {
    Message: { fields: { subject: field.string(), status: field.string() }, actions }
  }).install({ registry, dataset, edges });
  const calls: Array<[string, Record<string, unknown>]> = [];
  registry.register('sendMessage', {
    kind: 'mutation',
    params: { to: field.string(), subject: field.string() },
    returns: { kind: 'list', of: { kind: 'struct', fields: { id: field.string() } } },
    resolver: async (_ctx, args) => {
      calls.push(['send', args.params as Record<string, unknown>]);
      return [{ id: 'm1' }, { id: 'm2' }] as Row[];
    }
  });
  registry.register('ackMessage', {
    kind: 'mutation',
    params: { id: field.string() },
    returns: { kind: 'struct', fields: { id: field.string() } },
    resolver: async (_ctx, args) => {
      calls.push(['ack', args.params as Record<string, unknown>]);
      return { id: (args.params as { id: string }).id } as Row;
    }
  });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('mail', dataset);
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([['mail', { registry }]]),
    datasets,
    edges
  });
  const act = (sketch: string) => engine.act({ sketch, ctx: { identity: alice, now: NOW } });
  return { act, calls, dataset };
}

const actions: Record<string, ActionDecl> = {
  send: { kind: 'create', mutation: 'sendMessage', past: 'sent' },
  ack: { mutation: 'ackMessage', past: 'acked' }
};

it('passes the sketch args to the mutation as its params, and a reference as id', async () => {
  const { act, calls } = boot(actions);
  const sent = await act('send Message to=bob subject="hello there"');
  expect(sent).toMatchObject({ ok: true });
  const acked = await act('ack Message abc');
  expect(acked).toMatchObject({ ok: true });
  expect(calls).toEqual([
    ['send', { to: 'bob', subject: 'hello there' }],
    ['ack', { id: 'abc' }]
  ]);
});

it('refuses an arg that is not one of the mutation params, naming them', async () => {
  const { act, calls } = boot(actions);
  const res = await act('send Message to=bob status=unread');
  expect(res.ok).toBe(false);
  expect(JSON.stringify(res)).toContain('subject');
  expect(calls).toEqual([]);
});

it('shows the mutation and its params in help', async () => {
  const { act } = boot(actions);
  const res = await act('? Message');
  expect(res).toMatchObject({
    ok: true,
    help: {
      actions: {
        send: { kind: 'create', mutation: 'sendMessage', params: { to: { type: 'string' } } },
        ack: { kind: 'update', mutation: 'ackMessage', params: {} }
      }
    }
  });
});

it('refuses at compose an action naming a mutation its namespace does not have', () => {
  const registry = new Registry();
  defineNamespace('mail', {
    Message: { fields: { subject: field.string() }, actions }
  }).install({
    registry,
    dataset: new MemoryDataset({ namespace: 'mail' }),
    edges: new MemoryEdgesStore({ now: () => NOW })
  });
  expect(() => assertActionGraph(new Map([['mail', { registry }]]))).toThrow(
    "'sendMessage' is not a mutation of 'mail'"
  );
});

it('hands a custom mutation the id of a record named by shortId', async () => {
  const { act, calls, dataset } = boot(actions);
  const made = await dataset.write('Message', [{ subject: 's', status: 'unread', shortId: 7 }], {
    identity: { kind: 'agent', id: 'seed' },
    now: NOW
  });
  expect(await act('ack Message #7')).toMatchObject({ ok: true });
  expect(calls).toEqual([['ack', { id: made.ids[0] }]]);
  expect(await act('ack Message #8')).toMatchObject({ ok: false, error: { code: 'not_found' } });
});
