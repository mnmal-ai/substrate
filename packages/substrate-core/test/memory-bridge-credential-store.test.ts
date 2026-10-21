import { describe, expect, it } from 'vitest';
import { MemoryBridgeCredentialStore } from '../src/memory-bridge-credential-store.js';

describe('MemoryBridgeCredentialStore', () => {
  it('returns a provisioned credential by bridge name', () => {
    const store = new MemoryBridgeCredentialStore({
      'peripheral-a': {
        keyPath: '/keys/a.key',
        kid: 'labs-prime@host',
        origin: 'https://a.internal'
      }
    });
    expect(store.get('peripheral-a')).toEqual({
      keyPath: '/keys/a.key',
      kid: 'labs-prime@host',
      origin: 'https://a.internal'
    });
  });

  it('returns undefined for an unprovisioned name — this is the allowlist', () => {
    const store = new MemoryBridgeCredentialStore({});
    expect(store.get('evil')).toBeUndefined();
  });

  it('accepts no constructor argument and starts empty', () => {
    expect(new MemoryBridgeCredentialStore().get('anything')).toBeUndefined();
  });

  it('set() adds a credential after construction', () => {
    const store = new MemoryBridgeCredentialStore();
    store.set('peripheral-b', {
      keyPath: '/keys/b.key',
      kid: 'labs-prime@host',
      origin: 'https://b.internal'
    });
    expect(store.get('peripheral-b')?.kid).toBe('labs-prime@host');
  });
});
