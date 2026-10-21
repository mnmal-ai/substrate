import type { Dataset, EdgesStore } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { toResolverArgs } from '../src/engine/internals.js';

const noEdges = {} as EdgesStore;
const entry = { params: { a: 1 } } as never;

describe('toResolverArgs resolveDataset', () => {
  it('omits resolveDataset when not supplied', () => {
    const args = toResolverArgs(entry, undefined, noEdges);
    expect(args.resolveDataset).toBeUndefined();
  });

  it('threads resolveDataset through when supplied', () => {
    const stub = { namespace: 'other' } as Dataset;
    const resolve = (ns: string) => (ns === 'other' ? stub : undefined);
    const args = toResolverArgs(entry, undefined, noEdges, undefined, undefined, resolve);
    expect(args.resolveDataset?.('other')).toBe(stub);
    expect(args.resolveDataset?.('nope')).toBeUndefined();
  });
});
