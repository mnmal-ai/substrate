/**
 * A crossRef the set_null sweep nulls reads back absent. The dataset is wired
 * as `substrate serve` wires it: `makeTypeDefLookupFactory` over the live
 * registry, so the lookup carries the fields autoCRUD registered.
 */

import { type ComposeResult, compose } from '@mnmal-ai/substrate-compose';
import type { Engine } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTypeDefLookupFactory } from '../src/serve/wiring.js';
import { FIXTURE_NAMESPACE, fixturePlugin } from './_fixtures/fixture-plugin.js';

describe('set_null sweep (engine, memory)', () => {
  let composed: ComposeResult;
  let dataset: MemoryDataset;

  beforeEach(async () => {
    const engineRef: { current: Engine | null } = { current: null };
    const typeDefLookup = makeTypeDefLookupFactory(new Map(), (n) =>
      engineRef.current?.registryFor(n)
    )(FIXTURE_NAMESPACE);
    dataset = new MemoryDataset({ namespace: FIXTURE_NAMESPACE, typeDefLookup });
    composed = await compose({
      systemActor: 'test',
      server: new MemorySubstrateServer(),
      dataset,
      coordinators: [fixturePlugin]
    });
    engineRef.current = composed.engine;
  });

  afterEach(async () => {
    await composed.stop();
  });

  it('deleting the target through the engine leaves the referrer without the key', async () => {
    const ctx = {
      identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } }
    } as const;
    const mutate = async (frame: Record<string, unknown>) => {
      const env = await composed.engine.mutate({ frame: frame as never, ctx: ctx as never });
      expect(env.errors).toBeUndefined();
    };
    await mutate({ 'default/createTodo': { params: { id: 't1', title: 'parent' } } });
    await mutate({ 'default/createTag': { params: { id: 'tag1', label: 'blue', todoId: 't1' } } });
    expect((await dataset.read('Tag', { id: 'tag1' })).rows[0]?.todoId).toBe('t1');

    await mutate({ 'default/deleteTodo': { params: { id: 't1' } } });
    await composed.runSweepNow();

    const row = (await dataset.read('Tag', { id: 'tag1' })).rows[0];
    expect(row?.label).toBe('blue');
    expect('todoId' in (row ?? {})).toBe(false);
  });
});
