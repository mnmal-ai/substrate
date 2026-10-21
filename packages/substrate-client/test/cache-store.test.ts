import { describe, expect, it, vi } from 'vitest';
import { CacheStore } from '../src/cache/store.js';

describe('CacheStore', () => {
  it('creates an entry on first subscribe; same entry returned on second subscribe', () => {
    const store = new CacheStore({ idleGcMs: 100 });
    const unsub1 = store.subscribe('ns/T:x');
    const e1 = store.get('ns/T:x');
    const unsub2 = store.subscribe('ns/T:x');
    const e2 = store.get('ns/T:x');
    expect(e1).toBe(e2);
    expect(e1.refCount).toBe(2);
    unsub1();
    expect(e1.refCount).toBe(1);
    unsub2();
    expect(e1.refCount).toBe(0);
  });

  it('returns undefined for entries that were never subscribed', () => {
    const store = new CacheStore({ idleGcMs: 100 });
    expect(store.peek('ns/T:x')).toBeUndefined();
  });

  it('set() updates the data signal and clears loading/error', () => {
    const store = new CacheStore({ idleGcMs: 100 });
    store.subscribe('ns/T:x');
    const entry = store.get('ns/T:x');
    entry.loading.value = true;
    entry.error.value = new Error('stale');
    store.set('ns/T:x', { foo: 'bar' });
    expect(entry.data.value).toEqual({ foo: 'bar' });
    expect(entry.loading.value).toBe(false);
    expect(entry.error.value).toBe(null);
  });

  it('setError() updates the error signal and clears loading', () => {
    const store = new CacheStore({ idleGcMs: 100 });
    store.subscribe('ns/T:x');
    const entry = store.get('ns/T:x');
    entry.loading.value = true;
    store.setError('ns/T:x', new Error('boom'));
    expect(entry.error.value?.message).toBe('boom');
    expect(entry.loading.value).toBe(false);
  });

  it('invalidate() with refCount > 0 sets invalidatedAt; refCount = 0 drops entry', () => {
    const store = new CacheStore({ idleGcMs: 100 });
    const unsub = store.subscribe('a/T:x');
    store.set('a/T:x', 1);
    store.subscribe('b/T:y');
    store.set('b/T:y', 2);

    store.invalidate('a/T');
    expect(store.peek('a/T:x')?.invalidatedAt).toBeGreaterThan(0);

    unsub();
    store.invalidate('a/T');
    expect(store.peek('a/T:x')).toBeUndefined();
    expect(store.peek('b/T:y')).toBeDefined();
  });

  it('invalidate matches on key prefix (namespace/Type)', () => {
    const store = new CacheStore({ idleGcMs: 100 });
    store.subscribe('claude/Todo:{"limit":10}');
    store.subscribe('claude/Todo:{"limit":20}');
    store.subscribe('claude/Decision:{}');
    store.invalidate('claude/Todo');
    expect(store.peek('claude/Todo:{"limit":10}')?.invalidatedAt).toBeGreaterThan(0);
    expect(store.peek('claude/Todo:{"limit":20}')?.invalidatedAt).toBeGreaterThan(0);
    expect(store.peek('claude/Decision:{}')?.invalidatedAt ?? null).toBeNull();
  });

  it('GC drops entries after idle window elapses without subscribers', () => {
    vi.useFakeTimers();
    const store = new CacheStore({ idleGcMs: 50 });
    const unsub = store.subscribe('k');
    store.set('k', 1);
    unsub();
    expect(store.peek('k')).toBeDefined();
    vi.advanceTimersByTime(50);
    expect(store.peek('k')).toBeUndefined();
    vi.useRealTimers();
  });

  it('invalidate() bumps invalidatedSignal for entries with refCount > 0', () => {
    const store = new CacheStore({ idleGcMs: 100 });
    store.subscribe('ns/T:x');
    store.set('ns/T:x', 1);
    const entry = store.get('ns/T:x');
    expect(entry.invalidatedSignal.value).toBe(0);
    store.invalidate('ns/T');
    expect(entry.invalidatedSignal.value).toBeGreaterThan(0);
  });

  it('set() resets invalidatedSignal to 0', () => {
    const store = new CacheStore({ idleGcMs: 100 });
    store.subscribe('ns/T:x');
    store.set('ns/T:x', 1);
    store.invalidate('ns/T');
    const entry = store.get('ns/T:x');
    expect(entry.invalidatedSignal.value).toBeGreaterThan(0);
    store.set('ns/T:x', 2);
    expect(entry.invalidatedSignal.value).toBe(0);
  });

  it('GC cancels if a new subscribe arrives inside the idle window', () => {
    vi.useFakeTimers();
    const store = new CacheStore({ idleGcMs: 50 });
    const unsub1 = store.subscribe('k');
    unsub1();
    vi.advanceTimersByTime(25);
    const unsub2 = store.subscribe('k');
    vi.advanceTimersByTime(100);
    expect(store.peek('k')).toBeDefined();
    unsub2();
    vi.useRealTimers();
  });
});
