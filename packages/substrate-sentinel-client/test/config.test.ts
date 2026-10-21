import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/**
 * A configured sentinel URL requires a credential — sentinel's privileged
 * frames refuse an unauthenticated client. Cases below that are
 * about URL or reconnect parsing supply this so they stay scoped to their own
 * subject; the credential rules have their own describe block.
 */
const TEST_CRED = JSON.stringify({ keyPath: '/keys/test.key', kid: 'test@host' });

describe('loadConfig', () => {
  it('returns null when SUBSTRATE_SENTINEL_URL is unset', () => {
    expect(loadConfig({})).toBeNull();
  });

  it('returns null when SUBSTRATE_SENTINEL_URL is empty', () => {
    expect(loadConfig({ SUBSTRATE_SENTINEL_URL: '' })).toBeNull();
  });

  it('reads a valid ws:// URL', () => {
    const cfg = loadConfig({
      SUBSTRATE_SENTINEL_URL: 'ws://127.0.0.1:3300/plugins/substrate-sentinel/ws',
      SUBSTRATE_SENTINEL_CREDENTIAL: TEST_CRED
    });
    expect(cfg).not.toBeNull();
    expect(cfg?.url).toBe('ws://127.0.0.1:3300/plugins/substrate-sentinel/ws');
  });

  it('accepts wss:// URLs', () => {
    const cfg = loadConfig({
      SUBSTRATE_SENTINEL_URL: 'wss://sentinel.example.com/plugins/substrate-sentinel/ws',
      SUBSTRATE_SENTINEL_CREDENTIAL: TEST_CRED
    });
    expect(cfg?.url).toBe('wss://sentinel.example.com/plugins/substrate-sentinel/ws');
  });

  it('throws on a non-ws URL scheme', () => {
    expect(() => loadConfig({ SUBSTRATE_SENTINEL_URL: 'http://example.com' })).toThrow(
      'SUBSTRATE_SENTINEL_URL must be a ws:// or wss:// URL'
    );
  });

  it('reads optional reconnect knobs with defaults', () => {
    const cfg = loadConfig({
      SUBSTRATE_SENTINEL_URL: 'ws://x/y',
      SUBSTRATE_SENTINEL_CREDENTIAL: TEST_CRED
    });
    expect(cfg?.reconnectBaseMs).toBe(500);
    expect(cfg?.reconnectMaxMs).toBe(30_000);
  });

  it('overrides reconnect knobs from env', () => {
    const cfg = loadConfig({
      SUBSTRATE_SENTINEL_URL: 'ws://x/y',
      SUBSTRATE_SENTINEL_CREDENTIAL: TEST_CRED,
      SUBSTRATE_SENTINEL_RECONNECT_BASE_MS: '100',
      SUBSTRATE_SENTINEL_RECONNECT_MAX_MS: '5000'
    });
    expect(cfg?.reconnectBaseMs).toBe(100);
    expect(cfg?.reconnectMaxMs).toBe(5000);
  });

  it('rejects non-positive reconnect knobs', () => {
    expect(() =>
      loadConfig({
        SUBSTRATE_SENTINEL_URL: 'ws://x/y',
        SUBSTRATE_SENTINEL_CREDENTIAL: TEST_CRED,
        SUBSTRATE_SENTINEL_RECONNECT_BASE_MS: '0'
      })
    ).toThrow('SUBSTRATE_SENTINEL_RECONNECT_BASE_MS must be a positive integer');
  });
});

describe('loadConfig — sentinel credential', () => {
  const URL_OK = 'wss://sentinel.example.com/plugins/substrate-sentinel/ws';
  const CRED = JSON.stringify({ keyPath: '/keys/labs.key', kid: 'labs-prime@host' });

  it('parses SUBSTRATE_SENTINEL_CREDENTIAL into a { keyPath, kid } credential', () => {
    const cfg = loadConfig({ SUBSTRATE_SENTINEL_URL: URL_OK, SUBSTRATE_SENTINEL_CREDENTIAL: CRED });
    expect(cfg?.cred).toEqual({ keyPath: '/keys/labs.key', kid: 'labs-prime@host' });
  });

  it('refuses a configured sentinel URL with no credential', () => {
    // Fail-closed: sentinel's watch/register are privileged, so a credential-less
    // client would connect and then be refused every frame — a silent permanent
    // reconnect loop. Better to refuse at boot.
    expect(() => loadConfig({ SUBSTRATE_SENTINEL_URL: URL_OK })).toThrow(
      /SUBSTRATE_SENTINEL_CREDENTIAL/
    );
  });

  it('throws on malformed SUBSTRATE_SENTINEL_CREDENTIAL JSON', () => {
    expect(() =>
      loadConfig({ SUBSTRATE_SENTINEL_URL: URL_OK, SUBSTRATE_SENTINEL_CREDENTIAL: '{not json' })
    ).toThrow(/SUBSTRATE_SENTINEL_CREDENTIAL/);
  });

  it('throws when the credential is missing keyPath or kid', () => {
    expect(() =>
      loadConfig({
        SUBSTRATE_SENTINEL_URL: URL_OK,
        SUBSTRATE_SENTINEL_CREDENTIAL: JSON.stringify({ kid: 'k@h' })
      })
    ).toThrow(/keyPath/);
    expect(() =>
      loadConfig({
        SUBSTRATE_SENTINEL_URL: URL_OK,
        SUBSTRATE_SENTINEL_CREDENTIAL: JSON.stringify({ keyPath: '/k' })
      })
    ).toThrow(/kid/);
  });
});
