/**
 * §5.12 — env → config wiring coverage plus an end-to-end auth integration.
 *
 * `parseEnv` is exercised as a pure function (I/O is scoped to reading the
 * auth key-file and TLS key/cert/ca PEMs off disk at parse time). The auth
 * integration test composes a server with the same auth config a real
 * deployment would produce via env vars and asserts the gate behaviour
 * end-to-end: valid token → 200, missing/invalid → 401, schema routes stay
 * public.
 */

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ComposeResult, compose, signHs256 } from '@mnmal-ai/substrate-compose';
import { MemoryBridgeCredentialStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { PackEnvelope, Schema } from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBridgeRegistry,
  DEFAULT_KEY_REPRIME_INTERVAL_MS,
  EnvConfigError,
  listeningBanner,
  memoryStoreBanner,
  noPluginsBanner,
  parseBridgeCreds,
  parseEnv
} from '../src/main.js';
import { fixturePlugin } from './_fixtures/fixture-plugin.js';

const SECRET = 'auth-integration-secret-at-least-32-bytes';

function writeKeyFile(dir: string, alg: string, publicKey: string, kid?: string): string {
  const path = join(dir, 'keys.json');
  const entry: Record<string, unknown> = { alg, publicKey };
  if (kid !== undefined) entry.kid = kid;
  writeFileSync(path, JSON.stringify([entry]), 'utf8');
  return path;
}

describe('parseEnv', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrate-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('bounds remote list reads at 100 by default and 1000 at most, both configurable', () => {
    expect(parseEnv({}).pageLimits).toEqual({ defaultLimit: 100, maxLimit: 1000 });
    expect(
      parseEnv({ SUBSTRATE_PAGE_LIMIT_DEFAULT: '50', SUBSTRATE_PAGE_LIMIT_MAX: '500' }).pageLimits
    ).toEqual({ defaultLimit: 50, maxLimit: 500 });
    expect(() => parseEnv({ SUBSTRATE_PAGE_LIMIT_DEFAULT: '2000' })).toThrow(/exceeds/);
    expect(() => parseEnv({ SUBSTRATE_PAGE_LIMIT_MAX: 'lots' })).toThrow(/positive integer/);
  });

  it('listens on every interface by default only when auth is on', () => {
    const on = parseEnv({
      SUBSTRATE_AUTH_MODE: 'required',
      SUBSTRATE_DATABASE_URL: 'postgres://u@h/db_test',
      SUBSTRATE_PUBLIC_ORIGIN: 'https://h:3100'
    });
    expect(on.host).toBe('0.0.0.0');
    expect(parseEnv({}).host).toBe('127.0.0.1');
  });

  it('returns sensible defaults with no env vars set', () => {
    const cfg = parseEnv({});
    expect(cfg.storeSpec).toBe('memory');
    expect(cfg.bridges).toEqual([]);
    expect(cfg.auth).toBeNull();
    expect(cfg.tls).toBeNull();
    expect(cfg.sweepIntervalMs).toBe(300_000);
    expect(cfg.port).toBe(3100);
    expect(cfg.host).toBe('127.0.0.1'); // auth off listens on loopback
    // null => Fastify's 1 MiB default applies.
    expect(cfg.bodyLimit).toBeNull();
    // Re-prime is ON by default: the key cache must self-repair even when
    // nothing tells it to. Opting out takes an explicit `off`.
    expect(cfg.keyReprimeIntervalMs).toBe(DEFAULT_KEY_REPRIME_INTERVAL_MS);
  });

  it('parses SUBSTRATE_STREAM_TICKET_SECRET, treating empty as unset', () => {
    // compose() refuses to boot an auth-enabled instance without this — the
    // ungated browser stream routes authenticate on the ticket signature alone.
    expect(parseEnv({ SUBSTRATE_STREAM_TICKET_SECRET: 'sekrit' }).streamTicketSecret).toBe(
      'sekrit'
    );
    expect(parseEnv({}).streamTicketSecret).toBeNull();
    expect(parseEnv({ SUBSTRATE_STREAM_TICKET_SECRET: '' }).streamTicketSecret).toBeNull();
    // Whitespace-only must read as ABSENT, not as a valid-looking HMAC key —
    // Node HMACs happily with `'   '` and the forgery is then trivial.
    expect(parseEnv({ SUBSTRATE_STREAM_TICKET_SECRET: '   ' }).streamTicketSecret).toBeNull();
    // A stray trailing space in the env file must not change the signing key.
    expect(parseEnv({ SUBSTRATE_STREAM_TICKET_SECRET: ' sekrit ' }).streamTicketSecret).toBe(
      'sekrit'
    );
  });

  it('parses SUBSTRATE_KEY_REFRESH_INTERVAL_MS into a positive ms count, rejecting bad values', () => {
    expect(parseEnv({ SUBSTRATE_KEY_REFRESH_INTERVAL_MS: '60000' }).keyReprimeIntervalMs).toBe(
      60_000
    );
    expect(() => parseEnv({ SUBSTRATE_KEY_REFRESH_INTERVAL_MS: '0' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_KEY_REFRESH_INTERVAL_MS: '-1' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_KEY_REFRESH_INTERVAL_MS: 'soon' })).toThrow(
      /positive integer/
    );
  });

  it('defaults SUBSTRATE_KEY_REFRESH_INTERVAL_MS ON, and disables only on an explicit `off`', () => {
    // Unset and empty (docker `${VAR:-}` substitution) both get the default.
    expect(parseEnv({}).keyReprimeIntervalMs).toBe(DEFAULT_KEY_REPRIME_INTERVAL_MS);
    expect(parseEnv({ SUBSTRATE_KEY_REFRESH_INTERVAL_MS: '' }).keyReprimeIntervalMs).toBe(
      DEFAULT_KEY_REPRIME_INTERVAL_MS
    );
    // Opting out is something an operator has to type, and is greppable.
    expect(parseEnv({ SUBSTRATE_KEY_REFRESH_INTERVAL_MS: 'off' }).keyReprimeIntervalMs).toBeNull();
    expect(
      parseEnv({ SUBSTRATE_KEY_REFRESH_INTERVAL_MS: ' OFF ' }).keyReprimeIntervalMs
    ).toBeNull();
  });

  it('records whether the reprime interval was explicit, so the banner can say so', () => {
    // An explicit value silently beats a new default, so a deployment that set
    // this as a workaround keeps ITS number when the default moves. Without
    // this the startup log cannot distinguish inherited from chosen, and the
    // only other instrument is revoking a key and timing it.
    const sourceOf = (env: NodeJS.ProcessEnv): string | undefined =>
      parseEnv(env).knobs.keyReprimeIntervalMs?.source;
    expect(sourceOf({})).toBe('default');
    expect(sourceOf({ SUBSTRATE_KEY_REFRESH_INTERVAL_MS: '' })).toBe('default');
    expect(sourceOf({ SUBSTRATE_KEY_REFRESH_INTERVAL_MS: '60000' })).toBe('explicit');
    // `off` is a CHOICE, not an absence — the operator typed something, and a
    // report that called it `default` would say the reprime timer was never
    // considered on a host that deliberately turned it off.
    expect(sourceOf({ SUBSTRATE_KEY_REFRESH_INTERVAL_MS: 'off' })).toBe('explicit');
  });

  it('parses SUBSTRATE_BODY_LIMIT_BYTES into a positive byte count, rejecting bad values', () => {
    expect(parseEnv({ SUBSTRATE_BODY_LIMIT_BYTES: '5242880' }).bodyLimit).toBe(5_242_880);
    // Empty/whitespace is treated as unset (docker `${VAR:-}` substitution).
    expect(parseEnv({ SUBSTRATE_BODY_LIMIT_BYTES: '' }).bodyLimit).toBeNull();
    expect(() => parseEnv({ SUBSTRATE_BODY_LIMIT_BYTES: '0' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_BODY_LIMIT_BYTES: '-1' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_BODY_LIMIT_BYTES: 'huge' })).toThrow(/positive integer/);
  });

  it('reads SUBSTRATE_DATABASE_URL unchanged (memory or pg URL)', () => {
    expect(parseEnv({ SUBSTRATE_DATABASE_URL: 'memory' }).storeSpec).toBe('memory');
    expect(parseEnv({ SUBSTRATE_DATABASE_URL: 'postgres://u:p@h:5432/d' }).storeSpec).toBe(
      'postgres://u:p@h:5432/d'
    );
  });

  it('flags memoryByDefault when SUBSTRATE_DATABASE_URL is unset', () => {
    expect(parseEnv({}).memoryByDefault).toBe(true);
    expect(parseEnv({ SUBSTRATE_DATABASE_URL: 'memory' }).memoryByDefault).toBe(false);
    expect(parseEnv({ SUBSTRATE_DATABASE_URL: 'postgres://u:p@h:5432/d' }).memoryByDefault).toBe(
      false
    );
  });

  it('memoryStoreBanner advertises non-durability + suggests SUBSTRATE_DATABASE_URL=postgres://', () => {
    const banner = memoryStoreBanner(true);
    expect(banner).toContain('NOT persisted');
    expect(banner).toContain("SUBSTRATE_DATABASE_URL='postgres://");
    expect(banner).toContain('SUBSTRATE_DATABASE_URL not set');
  });

  it('memoryStoreBanner distinguishes explicit memory choice from default', () => {
    expect(memoryStoreBanner(true)).toContain('SUBSTRATE_DATABASE_URL not set');
    expect(memoryStoreBanner(false)).toContain('SUBSTRATE_DATABASE_URL=memory');
  });

  it('noPluginsBanner names the consequence, not just the condition', () => {
    // A plugin-less boot serves no user types at all. `coordinators:` prints
    // only when non-empty, so without this banner the boot would say nothing.
    const banner = noPluginsBanner(null);
    expect(banner).toContain('/health only');
    expect(banner).toContain('SUBSTRATE_PLUGIN_DIR');
  });

  it('noPluginsBanner distinguishes UNSET from set-but-empty', () => {
    // The two have different fixes — edit env, versus install packages under
    // the directory already named — so the message must tell them apart.
    const unset = noPluginsBanner(null);
    const empty = noPluginsBanner('/srv/substrate');

    expect(unset).toContain('is not set');
    expect(empty).toContain('found none');
    expect(empty).not.toContain('is not set');
  });

  // The banner is the likeliest place an operator copies a base URL from, and
  // `substrate federate enroll --origin` needs it exactly right, so a TLS boot must
  // advertise `https://`.
  it('listeningBanner reports the scheme that actually answers', () => {
    expect(listeningBanner('0.0.0.0', 3100, true)).toContain('https://0.0.0.0:3100');
    expect(listeningBanner('0.0.0.0', 3100, false)).toContain('http://0.0.0.0:3100');
  });

  it('parses SUBSTRATE_BRIDGES as JSON array of { ns, name, url }', () => {
    // Fail-closed: every configured bridge needs a matching SUBSTRATE_BRIDGE_CREDENTIALS
    // entry or parseEnv throws — see the 'bridge credential completeness
    // (fail-closed)' describe block below.
    // Provisioning both here keeps this test scoped to SUBSTRATE_BRIDGES parsing.
    const cfg = parseEnv({
      SUBSTRATE_BRIDGES: JSON.stringify([
        { ns: 'cal', name: 'cal', url: 'https://cal.internal' },
        { ns: 'shop', name: 'shop', url: 'https://shop.internal' }
      ]),
      SUBSTRATE_BRIDGE_CREDENTIALS: JSON.stringify({
        cal: { keyPath: '/keys/cal.key', kid: 'cal-prime@host', origin: 'https://cal.internal' },
        shop: {
          keyPath: '/keys/shop.key',
          kid: 'shop-prime@host',
          origin: 'https://shop.internal'
        }
      })
    });
    expect(cfg.bridges).toEqual([
      { ns: 'cal', name: 'cal', url: 'https://cal.internal' },
      { ns: 'shop', name: 'shop', url: 'https://shop.internal' }
    ]);
  });

  it('throws on malformed SUBSTRATE_BRIDGES JSON', () => {
    expect(() => parseEnv({ SUBSTRATE_BRIDGES: '{not json}' })).toThrow(EnvConfigError);
  });

  it('throws on SUBSTRATE_BRIDGES that is not an array', () => {
    expect(() => parseEnv({ SUBSTRATE_BRIDGES: '{}' })).toThrow(/must be a JSON array/);
  });

  it('throws on a bridge entry missing ns / name / url', () => {
    expect(() =>
      parseEnv({ SUBSTRATE_BRIDGES: JSON.stringify([{ name: 'cal', url: 'https://cal' }]) })
    ).toThrow(/missing string 'ns'/);
    expect(() =>
      parseEnv({ SUBSTRATE_BRIDGES: JSON.stringify([{ ns: 'cal', url: 'https://cal' }]) })
    ).toThrow(/missing string 'name'/);
    expect(() =>
      parseEnv({ SUBSTRATE_BRIDGES: JSON.stringify([{ ns: 'cal', name: 'cal' }]) })
    ).toThrow(/missing string 'url'/);
  });

  it('loads SUBSTRATE_AUTH_KEY_REGISTRY when set', () => {
    const path = writeKeyFile(dir, 'HS256', SECRET);
    const cfg = parseEnv({
      SUBSTRATE_AUTH_KEY_REGISTRY: path,
      SUBSTRATE_ADMIN_CAPABILITY: 'role=admin',
      SUBSTRATE_PUBLIC_ORIGIN: 'https://h:3100'
    });
    expect(cfg.auth?.keys).toHaveLength(1);
    expect(cfg.auth?.adminCapability).toBe('role=admin');
  });

  it('respects SUBSTRATE_SWEEP_INTERVAL_MS, PORT, HOST overrides', () => {
    const cfg = parseEnv({
      SUBSTRATE_SWEEP_INTERVAL_MS: '12345',
      PORT: '4040',
      HOST: '127.0.0.1'
    });
    expect(cfg.sweepIntervalMs).toBe(12345);
    expect(cfg.port).toBe(4040);
    expect(cfg.host).toBe('127.0.0.1');
  });

  it('refuses a non-loopback HOST with auth off unless opted in', () => {
    expect(() => parseEnv({ HOST: '0.0.0.0' })).toThrow(/SUBSTRATE_ALLOW_UNAUTHENTICATED_HOST/);
    expect(parseEnv({ HOST: '::1' }).host).toBe('::1');
    const cfg = parseEnv({ HOST: '0.0.0.0', SUBSTRATE_ALLOW_UNAUTHENTICATED_HOST: '1' });
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.knobs.allowUnauthenticatedHost?.value).toBe(true);
  });

  it('parses SUBSTRATE_PUBLIC_ORIGIN as a list of origins onto the auth config', () => {
    const keys = join(dir, 'aud-keys.json');
    writeFileSync(keys, JSON.stringify([{ kid: 'k', alg: 'HS256', publicKey: 'x'.repeat(32) }]));
    const env = {
      SUBSTRATE_AUTH_KEY_REGISTRY: keys,
      SUBSTRATE_STREAM_TICKET_SECRET: 's'.repeat(16)
    };
    const cfg = parseEnv({ ...env, SUBSTRATE_PUBLIC_ORIGIN: 'https://a:3100/, https://b' });
    expect(cfg.auth?.audiences).toEqual(['https://a:3100', 'https://b']);
    for (const bad of ['a:3100', 'https://a:3100/path', 'ftp://a', 'https://a,']) {
      expect(() => parseEnv({ ...env, SUBSTRATE_PUBLIC_ORIGIN: bad })).toThrow(
        /SUBSTRATE_PUBLIC_ORIGIN/
      );
    }
  });

  it('requires SUBSTRATE_PUBLIC_ORIGIN with auth on a non-loopback host, and defaults it to loopback', () => {
    const keys = join(dir, 'aud-req-keys.json');
    writeFileSync(keys, JSON.stringify([{ kid: 'k', alg: 'HS256', publicKey: 'x'.repeat(32) }]));
    const env = {
      SUBSTRATE_AUTH_KEY_REGISTRY: keys,
      SUBSTRATE_STREAM_TICKET_SECRET: 's'.repeat(16)
    };
    expect(() => parseEnv(env)).toThrow(/SUBSTRATE_PUBLIC_ORIGIN is required/);
    expect(() => parseEnv({ ...env, HOST: '10.0.0.1' })).toThrow(/SUBSTRATE_PUBLIC_ORIGIN/);
    expect(parseEnv({ ...env, HOST: '127.0.0.1', PORT: '4000' }).auth?.audiences).toEqual([
      'http://127.0.0.1:4000',
      'http://localhost:4000',
      'http://[::1]:4000'
    ]);
  });

  it('treats every spelling of loopback as loopback, and nothing else', () => {
    for (const host of ['::ffff:127.0.0.1', '[::1]', '0:0:0:0:0:0:0:1', '127.1.2.3', 'LOCALHOST']) {
      expect(parseEnv({ HOST: host }).host).toBe(host);
    }
    for (const host of ['::ffff:10.0.0.1', '::', '128.0.0.1']) {
      expect(() => parseEnv({ HOST: host })).toThrow(/published only on the host's 127\.0\.0\.1/);
    }
  });

  it('TLS: key+cert produces a tls object on the parsed config', () => {
    const keyPath = join(dir, 'tls.key');
    const certPath = join(dir, 'tls.crt');
    writeFileSync(keyPath, 'KEY-MATERIAL', 'utf8');
    writeFileSync(certPath, 'CERT-MATERIAL', 'utf8');
    const cfg = parseEnv({
      SUBSTRATE_TLS_KEY_PATH: keyPath,
      SUBSTRATE_TLS_CERT_PATH: certPath
    });
    expect(cfg.tls).not.toBeNull();
    expect(cfg.tls?.key.toString('utf8')).toBe('KEY-MATERIAL');
    expect(cfg.tls?.cert.toString('utf8')).toBe('CERT-MATERIAL');
    expect(cfg.tls?.ca).toBeUndefined();
  });

  it('TLS: key+cert+ca produces a tls object with ca included', () => {
    const keyPath = join(dir, 'tls.key');
    const certPath = join(dir, 'tls.crt');
    const caPath = join(dir, 'chain.pem');
    writeFileSync(keyPath, 'KEY', 'utf8');
    writeFileSync(certPath, 'CERT', 'utf8');
    writeFileSync(caPath, 'CHAIN', 'utf8');
    const cfg = parseEnv({
      SUBSTRATE_TLS_KEY_PATH: keyPath,
      SUBSTRATE_TLS_CERT_PATH: certPath,
      SUBSTRATE_TLS_CA_PATH: caPath
    });
    expect(cfg.tls).not.toBeNull();
    expect(cfg.tls?.key.toString('utf8')).toBe('KEY');
    expect(cfg.tls?.cert.toString('utf8')).toBe('CERT');
    expect(cfg.tls?.ca).toBeDefined();
    expect((cfg.tls!.ca as Buffer).toString('utf8')).toBe('CHAIN');
  });

  it('TLS: SUBSTRATE_TLS_CERT_PATH set without SUBSTRATE_TLS_KEY_PATH throws', () => {
    const certPath = join(dir, 'tls.crt');
    writeFileSync(certPath, 'CERT', 'utf8');
    expect(() => parseEnv({ SUBSTRATE_TLS_CERT_PATH: certPath })).toThrow(
      /SUBSTRATE_TLS_CERT_PATH set but SUBSTRATE_TLS_KEY_PATH is not/
    );
    expect(() => parseEnv({ SUBSTRATE_TLS_CERT_PATH: certPath })).toThrow(EnvConfigError);
  });

  it('TLS: SUBSTRATE_TLS_KEY_PATH set without SUBSTRATE_TLS_CERT_PATH throws', () => {
    const keyPath = join(dir, 'tls.key');
    writeFileSync(keyPath, 'KEY', 'utf8');
    expect(() => parseEnv({ SUBSTRATE_TLS_KEY_PATH: keyPath })).toThrow(
      /SUBSTRATE_TLS_KEY_PATH set but SUBSTRATE_TLS_CERT_PATH is not/
    );
    expect(() => parseEnv({ SUBSTRATE_TLS_KEY_PATH: keyPath })).toThrow(EnvConfigError);
  });

  it('TLS: non-existent key file throws with env-var name and path', () => {
    const certPath = join(dir, 'tls.crt');
    writeFileSync(certPath, 'CERT', 'utf8');
    const missingKey = join(dir, 'does-not-exist.key');
    expect(() =>
      parseEnv({ SUBSTRATE_TLS_KEY_PATH: missingKey, SUBSTRATE_TLS_CERT_PATH: certPath })
    ).toThrow(new RegExp(`SUBSTRATE_TLS_KEY_PATH: cannot read '${missingKey}'`));
  });

  it('TLS: non-existent cert file throws with env-var name and path', () => {
    const keyPath = join(dir, 'tls.key');
    writeFileSync(keyPath, 'KEY', 'utf8');
    const missingCert = join(dir, 'does-not-exist.crt');
    expect(() =>
      parseEnv({ SUBSTRATE_TLS_KEY_PATH: keyPath, SUBSTRATE_TLS_CERT_PATH: missingCert })
    ).toThrow(new RegExp(`SUBSTRATE_TLS_CERT_PATH: cannot read '${missingCert}'`));
  });

  it('TLS: non-existent ca file throws with env-var name and path', () => {
    const keyPath = join(dir, 'tls.key');
    const certPath = join(dir, 'tls.crt');
    writeFileSync(keyPath, 'KEY', 'utf8');
    writeFileSync(certPath, 'CERT', 'utf8');
    const missingCa = join(dir, 'does-not-exist.pem');
    expect(() =>
      parseEnv({
        SUBSTRATE_TLS_KEY_PATH: keyPath,
        SUBSTRATE_TLS_CERT_PATH: certPath,
        SUBSTRATE_TLS_CA_PATH: missingCa
      })
    ).toThrow(new RegExp(`SUBSTRATE_TLS_CA_PATH: cannot read '${missingCa}'`));
  });

  it('TLS: no TLS env vars leaves tls undefined on the parsed config', () => {
    const cfg = parseEnv({
      SUBSTRATE_DATABASE_URL: 'memory',
      PORT: '3100'
    });
    expect(cfg.tls).toBeNull();
  });

  it('TLS: SUBSTRATE_TLS_CA_PATH alone (without key/cert) is a config bug and throws', () => {
    const caPath = join(dir, 'chain.pem');
    writeFileSync(caPath, 'CHAIN', 'utf8');
    expect(() => parseEnv({ SUBSTRATE_TLS_CA_PATH: caPath })).toThrow(
      /SUBSTRATE_TLS_CA_PATH set but SUBSTRATE_TLS_KEY_PATH and SUBSTRATE_TLS_CERT_PATH are not/
    );
  });

  it('trusted proxies: unset → empty set', () => {
    const cfg = parseEnv({});
    expect(cfg.trustedProxies).toBeInstanceOf(Set);
    expect(cfg.trustedProxies.size).toBe(0);
  });

  it('trusted proxies: CSV parses into a set of trimmed exact IPs', () => {
    const cfg = parseEnv({ SUBSTRATE_TRUSTED_PROXIES: '10.0.0.1, 10.0.0.2' });
    expect(cfg.trustedProxies).toEqual(new Set(['10.0.0.1', '10.0.0.2']));
  });

  it('trusted proxies: empty string → empty set', () => {
    const cfg = parseEnv({ SUBSTRATE_TRUSTED_PROXIES: '' });
    expect(cfg.trustedProxies.size).toBe(0);
  });

  it('trusted proxies: whitespace-only → empty set', () => {
    const cfg = parseEnv({ SUBSTRATE_TRUSTED_PROXIES: '   ' });
    expect(cfg.trustedProxies.size).toBe(0);
  });

  it('trusted proxies: all-comma garbage like ",,," throws EnvConfigError', () => {
    expect(() => parseEnv({ SUBSTRATE_TRUSTED_PROXIES: ',,,' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_TRUSTED_PROXIES: ',,,' })).toThrow(/no usable IP entries/);
  });

  it('invite sweep interval: defaults to 1h', () => {
    const cfg = parseEnv({});
    expect(cfg.inviteSweepIntervalMs).toBe(3_600_000);
  });

  it('invite sweep interval: integer override honoured', () => {
    const cfg = parseEnv({ SUBSTRATE_INVITE_SWEEP_INTERVAL_MS: '7200000' });
    expect(cfg.inviteSweepIntervalMs).toBe(7_200_000);
  });

  it('invite sweep interval: non-integer throws EnvConfigError', () => {
    expect(() => parseEnv({ SUBSTRATE_INVITE_SWEEP_INTERVAL_MS: 'abc' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_INVITE_SWEEP_INTERVAL_MS: '1.5' })).toThrow(EnvConfigError);
  });

  it('invite sweep interval: non-positive throws EnvConfigError', () => {
    expect(() => parseEnv({ SUBSTRATE_INVITE_SWEEP_INTERVAL_MS: '0' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_INVITE_SWEEP_INTERVAL_MS: '-1' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_INVITE_SWEEP_INTERVAL_MS: '-1000' })).toThrow(
      /positive integer/
    );
  });

  it('tombstone retention: defaults to 30 days', () => {
    const cfg = parseEnv({});
    expect(cfg.tombstoneRetentionDays).toBe(30);
  });

  it('tombstone retention: integer override honoured', () => {
    const cfg = parseEnv({ SUBSTRATE_TOMBSTONE_RETENTION_DAYS: '7' });
    expect(cfg.tombstoneRetentionDays).toBe(7);
  });

  it('tombstone retention: empty string falls back to default', () => {
    const cfg = parseEnv({ SUBSTRATE_TOMBSTONE_RETENTION_DAYS: '' });
    expect(cfg.tombstoneRetentionDays).toBe(30);
  });

  it('tombstone retention: malformed throws EnvConfigError', () => {
    expect(() => parseEnv({ SUBSTRATE_TOMBSTONE_RETENTION_DAYS: 'abc' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_TOMBSTONE_RETENTION_DAYS: '1.5' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_TOMBSTONE_RETENTION_DAYS: '0' })).toThrow(/positive integer/);
    expect(() => parseEnv({ SUBSTRATE_TOMBSTONE_RETENTION_DAYS: '-1' })).toThrow(EnvConfigError);
  });

  it('shutdown grace: defaults to 5000 ms', () => {
    const cfg = parseEnv({});
    expect(cfg.shutdownGraceMs).toBe(5_000);
  });

  it('shutdown grace: integer override honoured', () => {
    const cfg = parseEnv({ SUBSTRATE_SHUTDOWN_GRACE_MS: '8000' });
    expect(cfg.shutdownGraceMs).toBe(8_000);
  });

  it('shutdown grace: empty string falls back to default', () => {
    const cfg = parseEnv({ SUBSTRATE_SHUTDOWN_GRACE_MS: '' });
    expect(cfg.shutdownGraceMs).toBe(5_000);
  });

  it('shutdown grace: malformed throws EnvConfigError', () => {
    expect(() => parseEnv({ SUBSTRATE_SHUTDOWN_GRACE_MS: 'abc' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_SHUTDOWN_GRACE_MS: '1.5' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_SHUTDOWN_GRACE_MS: '0' })).toThrow(/positive integer/);
    expect(() => parseEnv({ SUBSTRATE_SHUTDOWN_GRACE_MS: '-1' })).toThrow(EnvConfigError);
  });

  it('partition budget: defaults to 500, honours an override, refuses anything else', () => {
    expect(parseEnv({}).partitionBudget).toBe(500);
    expect(parseEnv({ SUBSTRATE_PARTITION_BUDGET: '3' }).partitionBudget).toBe(3);
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      expect(() => parseEnv({ SUBSTRATE_PARTITION_BUDGET: bad })).toThrow(EnvConfigError);
    }
  });

  it('index disk check: off without a path, margin defaults to 2048 MB', () => {
    expect(parseEnv({}).indexDiskPath).toBeNull();
    expect(parseEnv({ SUBSTRATE_INDEX_DISK_PATH: 'off' }).indexDiskPath).toBe('off');
    expect(parseEnv({ SUBSTRATE_INDEX_DISK_PATH: 'OFF' }).indexDiskPath).toBe('off');
    expect(parseEnv({}).indexDiskMarginMb).toBe(2048);
    const cfg = parseEnv({
      SUBSTRATE_INDEX_DISK_PATH: '/var/lib/postgresql',
      SUBSTRATE_INDEX_DISK_MARGIN_MB: '512'
    });
    expect(cfg.indexDiskPath).toBe('/var/lib/postgresql');
    expect(cfg.indexDiskMarginMb).toBe(512);
    expect(parseEnv({ SUBSTRATE_INDEX_DISK_MARGIN_MB: '0' }).indexDiskMarginMb).toBe(0);
    for (const bad of ['-1', '1.5', 'abc']) {
      expect(() => parseEnv({ SUBSTRATE_INDEX_DISK_MARGIN_MB: bad })).toThrow(EnvConfigError);
    }
  });

  it('index retry interval: defaults to 10 minutes, 0 disables, refuses anything else', () => {
    expect(parseEnv({}).indexRetryIntervalMs).toBe(600_000);
    expect(parseEnv({ SUBSTRATE_INDEX_RETRY_INTERVAL_MS: '0' }).indexRetryIntervalMs).toBe(0);
    expect(parseEnv({ SUBSTRATE_INDEX_RETRY_INTERVAL_MS: '5000' }).indexRetryIntervalMs).toBe(5000);
    for (const bad of ['-1', '1.5', 'abc']) {
      expect(() => parseEnv({ SUBSTRATE_INDEX_RETRY_INTERVAL_MS: bad })).toThrow(EnvConfigError);
    }
  });

  // Regression: docker-compose `${VAR:-}` substitution passes `""` when an
  // operator leaves the .env line blank. parseInt('') is NaN, and NaN in
  // setInterval fires continuously, so empty must mean "not set".
  it('sweep interval: empty string falls back to default (NaN trap)', () => {
    const cfg = parseEnv({ SUBSTRATE_SWEEP_INTERVAL_MS: '' });
    expect(cfg.sweepIntervalMs).toBe(300_000);
    expect(Number.isNaN(cfg.sweepIntervalMs)).toBe(false);
  });

  it('sweep interval: integer override honoured', () => {
    const cfg = parseEnv({ SUBSTRATE_SWEEP_INTERVAL_MS: '120000' });
    expect(cfg.sweepIntervalMs).toBe(120_000);
  });

  it('sweep interval: malformed throws EnvConfigError', () => {
    expect(() => parseEnv({ SUBSTRATE_SWEEP_INTERVAL_MS: 'abc' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_SWEEP_INTERVAL_MS: '1.5' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ SUBSTRATE_SWEEP_INTERVAL_MS: '0' })).toThrow(/positive integer/);
    expect(() => parseEnv({ SUBSTRATE_SWEEP_INTERVAL_MS: '-1' })).toThrow(EnvConfigError);
  });

  it('PORT: empty string falls back to default (NaN trap)', () => {
    const cfg = parseEnv({ PORT: '' });
    expect(cfg.port).toBe(3100);
    expect(Number.isNaN(cfg.port)).toBe(false);
  });

  it('PORT: integer override honoured', () => {
    const cfg = parseEnv({ PORT: '8080' });
    expect(cfg.port).toBe(8080);
  });

  it('PORT: malformed or out-of-range throws EnvConfigError', () => {
    expect(() => parseEnv({ PORT: 'abc' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ PORT: '1.5' })).toThrow(EnvConfigError);
    expect(() => parseEnv({ PORT: '0' })).toThrow(/1\.\.65535/);
    expect(() => parseEnv({ PORT: '70000' })).toThrow(/1\.\.65535/);
    expect(() => parseEnv({ PORT: '-1' })).toThrow(EnvConfigError);
  });
});

describe('auth integration', () => {
  let dir: string;
  let composed: ComposeResult | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrate-auth-int-'));
  });

  afterEach(async () => {
    if (composed !== null) {
      await composed.stop();
      composed = null;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function bodyToString(body: unknown): string {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body)) return body.toString('utf8');
    if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
    return '';
  }

  it('auth-enabled server: valid token passes, invalid/missing rejected, schema needs a key', async () => {
    const keyPath = writeKeyFile(dir, 'HS256', SECRET, 'k1');
    const cfg = parseEnv({
      SUBSTRATE_AUTH_KEY_REGISTRY: keyPath,
      SUBSTRATE_ADMIN_CAPABILITY: 'role=admin',
      SUBSTRATE_PUBLIC_ORIGIN: 'https://h:3100'
    });
    expect(cfg.auth).not.toBeNull();
    if (cfg.auth === null) throw new Error('auth expected');

    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      systemActor: 'test',
      server,
      dataset,
      auth: cfg.auth,
      coordinators: [fixturePlugin],
      streamTicketSecret: 'test-stream-ticket-secret'
    });
    await server.start();

    // Phase 1 route-capability map: query needs `read`, mutate needs `mutate`.
    // Token with no ns claim defaults to the wildcard for back-compat.
    const validToken = signHs256(
      {
        sub: 'home',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read', 'mutate'],
        aud: 'https://h:3100'
      },
      SECRET,
      { kid: 'k1' }
    );

    const queryOk = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${validToken}`
      },
      body: Buffer.from(
        JSON.stringify({
          'default/Todo': { params: { limit: 10 }, fields: { id: true, title: true } }
        })
      )
    });
    expect(queryOk.status).toBe(200);

    const mutateOk = await server.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${validToken}`
      },
      body: Buffer.from(
        JSON.stringify({
          'default/createTodo': { params: { title: 'authed', done: false }, fields: { id: true } }
        })
      )
    });
    expect(mutateOk.status).toBe(200);
    const mutateEnv = JSON.parse(bodyToString(mutateOk.body)) as PackEnvelope;
    expect(mutateEnv.data['default/createTodo']).toBeDefined();

    const invalid = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer this-is-not-a-jwt'
      },
      body: Buffer.from(JSON.stringify({ 'default/Todo': { params: {}, fields: {} } }))
    });
    expect(invalid.status).toBe(401);
    // A non-JWT names itself — the bare body is reserved for the
    // oracle boundary (unknown kid / bad signature), never for shape failures.
    expect(JSON.parse(bodyToString(invalid.body))).toEqual({
      code: 'unauthorized',
      reason: 'malformed_token'
    });

    const missing = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ 'default/Todo': { params: {}, fields: {} } }))
    });
    expect(missing.status).toBe(401);

    // Schema discovery needs a key once auth is on.
    const schemaAnon = await server.inject({ method: 'GET', path: '/substrate/v1/schema' });
    expect(schemaAnon.status).toBe(401);
    const schemaSigned = await server.inject({
      method: 'GET',
      path: '/substrate/v1/schema',
      headers: { authorization: `Bearer ${validToken}` }
    });
    expect(schemaSigned.status).toBe(200);
    const schema = JSON.parse(bodyToString(schemaSigned.body)) as Schema;
    expect(schema.types.Todo).toBeDefined();

    const federatedAnon = await server.inject({
      method: 'GET',
      path: '/substrate/v1/federated-schema'
    });
    expect(federatedAnon.status).toBe(401);

    const expiredToken = signHs256(
      { sub: 'home', exp: Math.floor(Date.now() / 1000) - 60 },
      SECRET,
      { kid: 'k1' }
    );
    const expired = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${expiredToken}`
      },
      body: Buffer.from(JSON.stringify({ 'default/Todo': { params: {}, fields: {} } }))
    });
    expect(expired.status).toBe(401);
  });

  it('auth-disabled server: everything passes without Authorization', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    composed = await compose({
      // Auth is off, so the deployment must declare who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [fixturePlugin]
    });
    await server.start();

    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ 'default/Todo': { params: {}, fields: {} } }))
    });
    expect(res.status).toBe(200);
  });
});

describe('parseBridgeCreds', () => {
  it('returns an empty store when unset', () => {
    expect(parseBridgeCreds(undefined).get('anything')).toBeUndefined();
  });

  it('parses name → { keyPath, kid, origin }', () => {
    const store = parseBridgeCreds(
      JSON.stringify({
        'peripheral-a': {
          keyPath: '/keys/a.key',
          kid: 'labs-prime@host',
          origin: 'https://a.test'
        }
      })
    );
    expect(store.get('peripheral-a')).toEqual({
      keyPath: '/keys/a.key',
      kid: 'labs-prime@host',
      origin: 'https://a.test'
    });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseBridgeCreds('{not json')).toThrow(/SUBSTRATE_BRIDGE_CREDENTIALS/);
  });

  it('throws when an entry is missing keyPath or kid', () => {
    expect(() => parseBridgeCreds(JSON.stringify({ a: { kid: 'k@h' } }))).toThrow(/keyPath/);
    expect(() => parseBridgeCreds(JSON.stringify({ a: { keyPath: '/k' } }))).toThrow(/kid/);
  });

  // `origin` is REQUIRED with no opt-out: the allowlist must gate WHERE a
  // bridge points, not merely WHICH coordinator forms one.
  it('throws when an entry is missing origin', () => {
    expect(() => parseBridgeCreds(JSON.stringify({ a: { keyPath: '/k', kid: 'k@h' } }))).toThrow(
      /origin/
    );
    expect(() =>
      parseBridgeCreds(JSON.stringify({ a: { keyPath: '/k', kid: 'k@h', origin: '' } }))
    ).toThrow(/origin/);
  });

  it('throws on an origin that is not a parseable URL origin', () => {
    expect(() =>
      parseBridgeCreds(JSON.stringify({ a: { keyPath: '/k', kid: 'k@h', origin: 'a.test' } }))
    ).toThrow(/malformed 'origin'/);
  });

  it('canonicalises the stored origin so comparisons are origin-vs-origin', () => {
    const store = parseBridgeCreds(
      JSON.stringify({ a: { keyPath: '/k', kid: 'k@h', origin: 'https://a.test:443/' } })
    );
    expect(store.get('a')?.origin).toBe('https://a.test');
  });
});

describe('bridge credential completeness (fail-closed)', () => {
  it('refuses to boot when a configured bridge has no credential', () => {
    expect(() =>
      parseEnv({
        SUBSTRATE_DATABASE_URL: 'memory',
        SUBSTRATE_BRIDGES: JSON.stringify([
          { ns: 'cal', name: 'peripheral-a', url: 'https://a.test' }
        ]),
        SUBSTRATE_BRIDGE_CREDENTIALS: '{}'
      } as NodeJS.ProcessEnv)
    ).toThrow(/peripheral-a.*SUBSTRATE_BRIDGE_CREDENTIALS/s);
  });

  it('accepts a bridge whose credential is provisioned', () => {
    const config = parseEnv({
      SUBSTRATE_DATABASE_URL: 'memory',
      SUBSTRATE_BRIDGES: JSON.stringify([
        { ns: 'cal', name: 'peripheral-a', url: 'https://a.test' }
      ]),
      SUBSTRATE_BRIDGE_CREDENTIALS: JSON.stringify({
        'peripheral-a': {
          keyPath: '/keys/a.key',
          kid: 'labs-prime@host',
          origin: 'https://a.test'
        }
      })
    } as NodeJS.ProcessEnv);
    expect(config.bridges).toHaveLength(1);
  });

  it('accepts no bridges and no credentials', () => {
    expect(() => parseEnv({ SUBSTRATE_DATABASE_URL: 'memory' } as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe('bridge origin binding (fail-closed)', () => {
  it('refuses to boot when a bridge url origin disagrees with its credential', () => {
    expect(() =>
      parseEnv({
        SUBSTRATE_DATABASE_URL: 'memory',
        SUBSTRATE_BRIDGES: JSON.stringify([
          { ns: 'cal', name: 'peripheral-a', url: 'https://evil.test' }
        ]),
        SUBSTRATE_BRIDGE_CREDENTIALS: JSON.stringify({
          'peripheral-a': {
            keyPath: '/keys/a.key',
            kid: 'labs-prime@host',
            origin: 'https://a.test'
          }
        })
      } as NodeJS.ProcessEnv)
    ).toThrow(/https:\/\/evil\.test.*https:\/\/a\.test/s);
  });

  it('accepts a bridge url that differs from the origin only by path / default port', () => {
    const config = parseEnv({
      SUBSTRATE_DATABASE_URL: 'memory',
      SUBSTRATE_BRIDGES: JSON.stringify([
        { ns: 'cal', name: 'peripheral-a', url: 'https://a.test:443/substrate' }
      ]),
      SUBSTRATE_BRIDGE_CREDENTIALS: JSON.stringify({
        'peripheral-a': { keyPath: '/keys/a.key', kid: 'labs-prime@host', origin: 'https://a.test' }
      })
    } as NodeJS.ProcessEnv);
    expect(config.bridges).toHaveLength(1);
  });

  it('refuses a bridge whose url is not parseable', () => {
    expect(() =>
      parseEnv({
        SUBSTRATE_DATABASE_URL: 'memory',
        SUBSTRATE_BRIDGES: JSON.stringify([{ ns: 'cal', name: 'peripheral-a', url: 'not-a-url' }]),
        SUBSTRATE_BRIDGE_CREDENTIALS: JSON.stringify({
          'peripheral-a': {
            keyPath: '/keys/a.key',
            kid: 'labs-prime@host',
            origin: 'https://a.test'
          }
        })
      } as NodeJS.ProcessEnv)
    ).toThrow(/malformed url/);
  });
});

describe('buildBridgeRegistry credential validation (fail-closed)', () => {
  const dirs: Array<string> = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function writeEd25519Key(): string {
    const { privateKey } = generateKeyPairSync('ed25519');
    const dir = mkdtempSync(join(tmpdir(), 'substrate-bridge-cred-'));
    dirs.push(dir);
    const path = join(dir, 'bridge.key');
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    return path;
  }

  // `makeTokenProvider` reads the key lazily, so without an eager first mint an
  // unreadable keyPath boots cleanly and only throws inside the bridge client's
  // try-block — reporting a LOCAL misconfiguration as a REMOTE outage.
  it('throws at construction when the credential keyPath is unreadable', () => {
    const creds = parseBridgeCreds(
      JSON.stringify({
        'peripheral-a': {
          keyPath: '/nonexistent/definitely-not-here.key',
          kid: 'labs-prime@host',
          origin: 'https://a.test'
        }
      })
    );
    expect(() =>
      buildBridgeRegistry([{ ns: 'cal', name: 'peripheral-a', url: 'https://a.test' }], creds)
    ).toThrow();
  });

  it('constructs a registry when the credential key is readable', () => {
    const creds = parseBridgeCreds(
      JSON.stringify({
        'peripheral-a': {
          keyPath: writeEd25519Key(),
          kid: 'labs-prime@host',
          origin: 'https://a.test'
        }
      })
    );
    const { registry, dispose } = buildBridgeRegistry(
      [{ ns: 'cal', name: 'peripheral-a', url: 'https://a.test' }],
      creds
    );
    expect(registry.has('cal')).toBe(true);
    dispose();
  });

  it("mints the bridge's token for the credential's origin", async () => {
    const creds = parseBridgeCreds(
      JSON.stringify({
        'peripheral-a': {
          keyPath: writeEd25519Key(),
          kid: 'labs-prime@host',
          origin: 'https://a.test'
        }
      })
    );
    const auths: Array<string | null> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      auths.push(new Headers(init?.headers).get('authorization'));
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    try {
      const { registry, dispose } = buildBridgeRegistry(
        [{ ns: 'cal', name: 'peripheral-a', url: 'https://a.test' }],
        creds
      );
      await registry
        .get('cal')
        ?.federatedSchema()
        .catch(() => {});
      dispose();
      const jwt = (auths.find((a) => a !== null) ?? '').replace(/^Bearer /, '');
      const claims = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
      expect(claims.aud).toBe('https://a.test');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('bridge credential origin hardening', () => {
  const KEY = { keyPath: '/keys/a.key', kid: 'a@h' };

  it('rejects an origin whose scheme is not http(s)', () => {
    // `new URL('foo://bar').origin` is the literal string "null", which then
    // matches EVERY advertised URL with an opaque origin. The canonicalisation
    // was added to turn a typo into a loud boot error; without a scheme check
    // it turns one into a silent match-anything instead.
    expect(() => parseBridgeCreds(JSON.stringify({ a: { ...KEY, origin: 'foo://bar' } }))).toThrow(
      /origin/
    );
  });

  it('rejects a file: origin', () => {
    expect(() => parseBridgeCreds(JSON.stringify({ a: { ...KEY, origin: 'file:///x' } }))).toThrow(
      /origin/
    );
  });

  it('accepts http and https origins', () => {
    const store = parseBridgeCreds(
      JSON.stringify({
        a: { ...KEY, origin: 'https://a.internal:3100' },
        b: { ...KEY, origin: 'http://b.internal' }
      })
    );
    expect(store.get('a')?.origin).toBe('https://a.internal:3100');
    expect(store.get('b')?.origin).toBe('http://b.internal');
  });

  it('buildBridgeRegistry refuses a spec whose url origin disagrees with the credential', () => {
    // parseEnv is the boot-time gate, but buildBridgeRegistry is exported and
    // re-checks credential existence for direct callers, so it must enforce
    // the origin half of the allowlist too.
    const creds = new MemoryBridgeCredentialStore({
      'peer-b': { keyPath: '/keys/a.key', kid: 'a@h', origin: 'https://b.internal:3100' }
    });
    expect(() =>
      buildBridgeRegistry([{ ns: 'demo', name: 'peer-b', url: 'https://evil.test' }], creds)
    ).toThrow(/origin/);
  });
});
