import { describe, expect, it, vi } from 'vitest';
import { MemoryDataset, MemoryDatasetRegistry } from '../src/index.js';

describe('MemoryDatasetRegistry', () => {
  it('set + get round-trip', () => {
    const reg = new MemoryDatasetRegistry();
    const ds = new MemoryDataset({ namespace: 'claude' });
    reg.set('claude', ds);
    expect(reg.get('claude')).toBe(ds);
  });

  it('has returns true after set', () => {
    const reg = new MemoryDatasetRegistry();
    const ds = new MemoryDataset({ namespace: 'default' });
    reg.set('default', ds);
    expect(reg.has('default')).toBe(true);
  });

  it('get on unknown ns returns undefined', () => {
    const reg = new MemoryDatasetRegistry();
    expect(reg.get('nope')).toBeUndefined();
    expect(reg.has('nope')).toBe(false);
  });
});

describe('MemoryDatasetRegistry — lifecycle (§6.4)', () => {
  it('dispose removes the mapping and fires listeners with the ns', () => {
    const reg = new MemoryDatasetRegistry();
    const ds = new MemoryDataset({ namespace: 'claude' });
    reg.set('claude', ds);

    const observed: string[] = [];
    reg.onNamespaceLost((ns) => observed.push(ns));

    reg.dispose('claude');
    expect(reg.has('claude')).toBe(false);
    expect(reg.get('claude')).toBeUndefined();
    expect(observed).toEqual(['claude']);
  });

  it('fires every listener in insertion order', () => {
    const reg = new MemoryDatasetRegistry();
    reg.set('foo', new MemoryDataset({ namespace: 'foo' }));

    const seen: string[] = [];
    reg.onNamespaceLost(() => seen.push('a'));
    reg.onNamespaceLost(() => seen.push('b'));
    reg.onNamespaceLost(() => seen.push('c'));

    reg.dispose('foo');
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('disposer returned by onNamespaceLost removes the listener', () => {
    const reg = new MemoryDatasetRegistry();
    reg.set('foo', new MemoryDataset({ namespace: 'foo' }));

    const spy = vi.fn();
    const off = reg.onNamespaceLost(spy);
    off();
    reg.dispose('foo');
    expect(spy).not.toHaveBeenCalled();
  });

  it('disposer is idempotent — second call is harmless', () => {
    const reg = new MemoryDatasetRegistry();
    reg.set('foo', new MemoryDataset({ namespace: 'foo' }));

    const spy = vi.fn();
    const off = reg.onNamespaceLost(spy);
    off();
    off();
    reg.dispose('foo');
    expect(spy).not.toHaveBeenCalled();
  });

  it('dispose of unknown ns is a silent no-op — no listener fires', () => {
    const reg = new MemoryDatasetRegistry();
    const spy = vi.fn();
    reg.onNamespaceLost(spy);
    reg.dispose('never-registered');
    expect(spy).not.toHaveBeenCalled();
  });

  it('listener registered after dispose does not see past events', () => {
    const reg = new MemoryDatasetRegistry();
    reg.set('foo', new MemoryDataset({ namespace: 'foo' }));
    reg.dispose('foo');

    const spy = vi.fn();
    reg.onNamespaceLost(spy);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a throwing listener does not stop siblings from firing', () => {
    const reg = new MemoryDatasetRegistry();
    reg.set('foo', new MemoryDataset({ namespace: 'foo' }));

    const seen: string[] = [];
    reg.onNamespaceLost(() => {
      seen.push('first');
      throw new Error('boom');
    });
    reg.onNamespaceLost(() => seen.push('second'));

    reg.dispose('foo');
    expect(seen).toEqual(['first', 'second']);
  });

  it('repeated dispose after a prior dispose does not re-fire', () => {
    const reg = new MemoryDatasetRegistry();
    reg.set('foo', new MemoryDataset({ namespace: 'foo' }));

    const spy = vi.fn();
    reg.onNamespaceLost(spy);
    reg.dispose('foo');
    reg.dispose('foo');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// Registry-level lazy factory: a hot-added namespace resolves to a dataset on
// first lookup without the host pre-registering one. Compose wires this to
// `(ns) => opts.dataset.forNamespace(ns)`.
describe('MemoryDatasetRegistry — factory fallback', () => {
  it('calls the factory on get-miss and returns the constructed dataset', () => {
    const factory = vi.fn((ns: string) => new MemoryDataset({ namespace: ns }));
    const reg = new MemoryDatasetRegistry({ factory });
    const got = reg.get('hot-add');
    expect(got).toBeDefined();
    expect(factory).toHaveBeenCalledWith('hot-add');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('caches the factory result so subsequent gets return the same instance', () => {
    const factory = vi.fn((ns: string) => new MemoryDataset({ namespace: ns }));
    const reg = new MemoryDatasetRegistry({ factory });
    const a = reg.get('hot-add');
    const b = reg.get('hot-add');
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('has() reflects the cached entry after a factory-served get', () => {
    const factory = (ns: string): MemoryDataset => new MemoryDataset({ namespace: ns });
    const reg = new MemoryDatasetRegistry({ factory });
    expect(reg.has('hot-add')).toBe(false);
    reg.get('hot-add');
    expect(reg.has('hot-add')).toBe(true);
  });

  it('explicit set() overrides the factory result for that ns', () => {
    const factoryDataset = new MemoryDataset({ namespace: 'override-me' });
    const explicit = new MemoryDataset({ namespace: 'override-me' });
    const reg = new MemoryDatasetRegistry({ factory: () => factoryDataset });
    reg.set('override-me', explicit);
    expect(reg.get('override-me')).toBe(explicit);
  });

  it('factory returning undefined leaves get() returning undefined and does not cache', () => {
    const factory = vi.fn(() => undefined);
    const reg = new MemoryDatasetRegistry({ factory });
    expect(reg.get('absent')).toBeUndefined();
    expect(reg.has('absent')).toBe(false);
    // Subsequent miss re-invokes the factory — caller may have provisioned
    // the underlying substrate in between.
    expect(reg.get('absent')).toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('no factory option keeps the original behaviour (miss returns undefined)', () => {
    const reg = new MemoryDatasetRegistry();
    expect(reg.get('absent')).toBeUndefined();
  });
});
