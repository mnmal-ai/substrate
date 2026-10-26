/**
 * serve/config.ts — env-var configuration parsing for `substrate serve`.
 */

import { readFileSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import {
  type AuthConfig,
  type ConfigReport,
  type ContractViolation,
  isStoreProfileName,
  parseAuthConfig,
  type StoreProfileName
} from '@mnmal-ai/substrate-compose';
import { MemoryBridgeCredentialStore } from '@mnmal-ai/substrate-core';
import { parsePositiveInt, type TlsConfig } from '@mnmal-ai/substrate-types';
import pkg from '../../package.json' with { type: 'json' };
import { createKnobRecorder, type KnobRecorder, nonEmpty } from './knobs.js';
import { redactStoreSpec } from './wiring.js';

const DEFAULT_SWEEP_INTERVAL_MS = 300_000;
const DEFAULT_INVITE_SWEEP_INTERVAL_MS = 3_600_000;
const DEFAULT_TOMBSTONE_RETENTION_DAYS = 30;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const DEFAULT_PARTITION_BUDGET = 500;
const DEFAULT_INDEX_DISK_MARGIN_MB = 2048;
const DEFAULT_INDEX_RETRY_INTERVAL_MS = 600_000;
const DEFAULT_ADVISOR_INTERVAL_MS = 600_000;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_PORT = 3100;

export interface BridgeSpec {
  ns: string;
  name: string;
  url: string;
}

export interface ParsedConfig {
  storeSpec: string;
  /**
   * `true` when `SUBSTRATE_DATABASE_URL` was unset and the substrate fell back to memory
   * mode by default. Drives a loud boot banner so operators don't silently
   * lose data on the next restart.
   */
  memoryByDefault: boolean;
  bridges: Array<BridgeSpec>;
  /** Federation allowlist — bridge name → credential. Empty when unconfigured. */
  bridgeCreds: MemoryBridgeCredentialStore;
  auth: AuthConfig | null;
  tls: TlsConfig | null;
  sweepIntervalMs: number;
  /** Invite reaper cadence (§5.12). Only engaged when auth is enabled. */
  inviteSweepIntervalMs: number;
  /**
   * Retention window (in days) for tombstoned `rows` and `edges`
   * rows before the sweep loop hard-deletes them. Pg-backed only. Default 30.
   */
  tombstoneRetentionDays: number;
  /**
   * Max wall-clock to wait for in-flight HTTP requests to drain after
   * SIGTERM/SIGINT. Set systemd `TimeoutStopSec` above this so SIGKILL is
   * the backstop, not the primary stop mechanism. Default 5s.
   */
  shutdownGraceMs: number;
  /** `SUBSTRATE_PARTITION_BUDGET` — partitions under `rows` beyond which the config report warns. */
  partitionBudget: number;
  /**
   * `SUBSTRATE_INDEX_DISK_PATH` — the database volume's mount, when the
   * database is local, whose free space is checked before each background
   * index build. `'off'` turns the check off, for a database with no local
   * volume. `null` (unset) leaves it off too, and the storage report says so.
   */
  indexDiskPath: string | 'off' | null;
  /** `SUBSTRATE_INDEX_DISK_MARGIN_MB` — free space a build must leave. Default 2048; 0 requires only the estimate. */
  indexDiskMarginMb: number;
  /**
   * `SUBSTRATE_INDEX_RETRY_INTERVAL_MS` — how often the background pass
   * retries types with a non-unique index still pending or failed. Default
   * 10 minutes; 0 leaves them to the next boot.
   */
  indexRetryIntervalMs: number;
  /** `SUBSTRATE_ADVISOR_INTERVAL_MS` — how often the index advisor runs. Default 10 minutes; 0 turns it off. */
  advisorIntervalMs: number;
  /** `SUBSTRATE_STORE_PROFILE` — seeds `_system/StoreProfile` once; unset seeds `personal`. */
  storeProfile: StoreProfileName | null;
  /** `SUBSTRATE_STORE_WRITE_HEAVY=1` — the advisor halves its write-rate threshold for removing unused indexes. */
  storeWriteHeavy: boolean;
  /**
   * §5.13 mutation idempotency config. `disabled` kills dedup entirely (the
   * engine never sees a store); `defaultTtlMs === null` leaves the engine's
   * 24h default in place, any positive integer overrides it.
   */
  idempotency: { defaultTtlMs: number | null; disabled: boolean };
  /**
   * Peer IPs whose `x-forwarded-for` header is honoured for
   * `/substrate/v1/_system/register` rate-limit bucketing (§5.12). Exact IP strings
   * only — no CIDR. Empty means XFF is always ignored.
   */
  trustedProxies: Set<string>;
  port: number;
  host: string;
  /**
   * CORS config for browser-facing deployments. `null` when `SUBSTRATE_CORS_ORIGINS`
   * is unset — no CORS plugin is registered in that case.
   * `origins: '*'` allows any origin (credentials disabled); an explicit list
   * enables credentialed cross-origin requests from the listed origins.
   */
  cors: { origins: string[] | '*'; credentials: boolean } | null;
  /**
   * Max request body size in bytes for the Fastify transport. `null` when
   * `SUBSTRATE_BODY_LIMIT_BYTES` is unset — Fastify's 1 MiB default applies.
   */
  bodyLimit: number | null;
  /** Remote list-read page bounds (`SUBSTRATE_PAGE_LIMIT_DEFAULT` / `_MAX`). */
  pageLimits: { defaultLimit: number; maxLimit: number };
  /** Most rows a subscription snapshot may return (`SUBSTRATE_SNAPSHOT_LIMIT`, default the max page). */
  snapshotLimit: number;
  /**
   * Periodic re-prime interval (ms) for the `KeyRegistry` public-key
   * cache; bounds revocation staleness. Defaults to
   * {@link DEFAULT_KEY_REPRIME_INTERVAL_MS}; `null` when set to `off`. Only
   * takes effect when auth is enabled.
   */
  keyReprimeIntervalMs: number | null;
  /**
   * Effective value + provenance for every knob with a default. Rendered in
   * the boot banner and echoed by the admin-gated `GET /substrate/v1/config`.
   */
  knobs: ConfigReport;
  /**
   * HMAC secret signing the SSE stream tickets (`SUBSTRATE_STREAM_TICKET_SECRET`).
   * `null` when unset. Required by `compose` whenever auth is enabled: the
   * browser stream routes (`GET /substrate/v1/stream|subscribe`) can't carry a bearer
   * token, so the ticket signature is their only authentication.
   */
  streamTicketSecret: string | null;
  /**
   * `SUBSTRATE_SYSTEM_ACTOR` — who this deployment writes AS when auth is disabled
   * `null` when unset, which `compose` refuses at boot rather than
   * defaulting, so no deployment writes as an actor nobody chose.
   */
  systemActor: string | null;
}

export class EnvConfigError extends Error {
  override readonly name = 'EnvConfigError';
}

/**
 * Parses the serve env into a fully resolved `ParsedConfig`. The only I/O is
 * reading the auth and TLS PEM / JSON files. Throws `EnvConfigError` on any
 * malformed input.
 */
export function parseEnv(env: NodeJS.ProcessEnv): ParsedConfig {
  const knobs = createKnobRecorder();
  const storeSpec = env.SUBSTRATE_DATABASE_URL ?? 'memory';
  // The RECORDED value is redacted; `storeSpec` itself stays intact because it
  // is the live connection string. A postgres SUBSTRATE_DATABASE_URL carries its password
  // inline, and the knob report reaches the boot log and `GET /substrate/v1/config`.
  knobs.record(
    'storeSpec',
    'SUBSTRATE_DATABASE_URL',
    env.SUBSTRATE_DATABASE_URL,
    redactStoreSpec(storeSpec)
  );
  const memoryByDefault = env.SUBSTRATE_DATABASE_URL === undefined;
  const bridges = parseBridges(env.SUBSTRATE_BRIDGES);
  const bridgeCreds = parseBridgeCreds(env.SUBSTRATE_BRIDGE_CREDENTIALS);
  // Fail-closed: every configured bridge must carry a credential. Without
  // this, a typo'd or omitted entry silently downgrades that bridge to
  // unauthenticated requests.
  for (const spec of bridges) {
    const cred = bridgeCreds.get(spec.name);
    if (cred === undefined) {
      throw new EnvConfigError(
        `SUBSTRATE_BRIDGES: bridge '${spec.name}' has no entry in SUBSTRATE_BRIDGE_CREDENTIALS — ` +
          'every configured bridge must carry a credential'
      );
    }
    // The credential is bound to an origin; a static bridge pointed somewhere
    // else would present that credential to a host it was never provisioned
    // for. Compared as parsed origins, never raw strings — trailing slashes
    // and default ports are not differences.
    let specOrigin: string;
    try {
      specOrigin = new URL(spec.url).origin;
    } catch {
      throw new EnvConfigError(
        `SUBSTRATE_BRIDGES: bridge '${spec.name}' has a malformed url '${spec.url}'`
      );
    }
    if (specOrigin !== cred.origin) {
      throw new EnvConfigError(
        `SUBSTRATE_BRIDGES: bridge '${spec.name}' url origin '${specOrigin}' does not match its ` +
          `SUBSTRATE_BRIDGE_CREDENTIALS origin '${cred.origin}'`
      );
    }
  }
  const auth = parseAuthConfig(env);
  const tls = parseTlsConfig(env);
  // `auth.mode` defaults inside `parseAuthConfig` (substrate-compose), so the
  // effective value is read back off the parsed config rather than
  // re-derived here.
  knobs.record('authMode', 'SUBSTRATE_AUTH_MODE', env.SUBSTRATE_AUTH_MODE, auth?.mode ?? 'off');
  const publicOrigins = parsePublicOrigins(env.SUBSTRATE_PUBLIC_ORIGIN);
  const sweepIntervalMs = parseSweepIntervalMs(env, knobs);
  const inviteSweepIntervalMs = parseInviteSweepIntervalMs(env, knobs);
  const tombstoneRetentionDays = parseTombstoneRetentionDays(env, knobs);
  const shutdownGraceMs = parseShutdownGraceMs(env, knobs);
  const partitionBudget = parsePositiveIntEnv(
    env,
    knobs,
    'partitionBudget',
    'SUBSTRATE_PARTITION_BUDGET',
    DEFAULT_PARTITION_BUDGET,
    'partitions'
  );
  const indexDiskPath = knobs.record(
    'indexDiskPath',
    'SUBSTRATE_INDEX_DISK_PATH',
    env.SUBSTRATE_INDEX_DISK_PATH,
    diskPathOf(nonEmpty(env.SUBSTRATE_INDEX_DISK_PATH?.trim()))
  );
  const indexDiskMarginMb = parseNonNegativeIntEnv(
    env,
    knobs,
    'indexDiskMarginMb',
    'SUBSTRATE_INDEX_DISK_MARGIN_MB',
    DEFAULT_INDEX_DISK_MARGIN_MB,
    'megabytes'
  );
  const indexRetryIntervalMs = parseNonNegativeIntEnv(
    env,
    knobs,
    'indexRetryIntervalMs',
    'SUBSTRATE_INDEX_RETRY_INTERVAL_MS',
    DEFAULT_INDEX_RETRY_INTERVAL_MS,
    'milliseconds, 0 to disable'
  );
  const advisorIntervalMs = parseNonNegativeIntEnv(
    env,
    knobs,
    'advisorIntervalMs',
    'SUBSTRATE_ADVISOR_INTERVAL_MS',
    DEFAULT_ADVISOR_INTERVAL_MS,
    'milliseconds, 0 to disable'
  );
  const profileRaw = nonEmpty(env.SUBSTRATE_STORE_PROFILE?.trim());
  if (profileRaw !== undefined && !isStoreProfileName(profileRaw)) {
    throw new EnvConfigError(
      `SUBSTRATE_STORE_PROFILE must be personal, growth or scale, got '${profileRaw}'`
    );
  }
  const storeProfile = knobs.record(
    'storeProfile',
    'SUBSTRATE_STORE_PROFILE',
    env.SUBSTRATE_STORE_PROFILE,
    profileRaw ?? null
  );
  const writeHeavyRaw = env.SUBSTRATE_STORE_WRITE_HEAVY;
  const storeWriteHeavy = knobs.record(
    'storeWriteHeavy',
    'SUBSTRATE_STORE_WRITE_HEAVY',
    writeHeavyRaw,
    writeHeavyRaw !== undefined && (writeHeavyRaw === '1' || writeHeavyRaw.toLowerCase() === 'true')
  );
  const idempotency = parseIdempotencyConfig(env, knobs);
  const trustedProxies = parseTrustedProxies(env, knobs);
  const port = parsePort(env, knobs);
  // Without auth every caller acts as the system actor, admin routes included,
  // so an unauthenticated server listens on loopback unless HOST says otherwise.
  const host = knobs.record(
    'host',
    'HOST',
    env.HOST,
    env.HOST ?? (auth === null ? '127.0.0.1' : '0.0.0.0')
  );
  const openRaw = env.SUBSTRATE_ALLOW_UNAUTHENTICATED_HOST;
  const allowOpenHost = knobs.record(
    'allowUnauthenticatedHost',
    'SUBSTRATE_ALLOW_UNAUTHENTICATED_HOST',
    openRaw,
    openRaw !== undefined && (openRaw === '1' || openRaw.toLowerCase() === 'true')
  );
  if (auth === null && !isLoopbackHost(host) && !allowOpenHost) {
    throw new EnvConfigError(
      `HOST '${host}' is not loopback and auth is off, so every caller would act as the system actor (admin routes included). Enable auth, bind to loopback, or set SUBSTRATE_ALLOW_UNAUTHENTICATED_HOST=1. Inside a container, a port published only on the host's 127.0.0.1 still needs the opt-in: the server binds a non-loopback interface there.`
    );
  }
  // Unchecked, a token minted for any other origin would replay here: required off loopback,
  // and on loopback the origins this server answers at.
  if (auth !== null && publicOrigins === null && !isLoopbackHost(host)) {
    throw new EnvConfigError(
      `SUBSTRATE_PUBLIC_ORIGIN is required when auth is on and HOST '${host}' is not loopback: set it to the origins callers reach this server by (e.g. https://host:3100), so a token minted for another origin is refused.`
    );
  }
  let audiences = publicOrigins;
  if (auth !== null && audiences === null) {
    const bound = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const scheme = tls !== null ? 'https' : 'http';
    audiences = [
      ...new Set(
        ['127.0.0.1', 'localhost', '[::1]', bound].map(
          (h) => new URL(`${scheme}://${h}:${port}`).origin
        )
      )
    ];
  }
  if (auth !== null && audiences !== null) auth.audiences = audiences;
  knobs.record(
    'publicOrigin',
    'SUBSTRATE_PUBLIC_ORIGIN',
    env.SUBSTRATE_PUBLIC_ORIGIN,
    audiences?.join(',') ?? null
  );
  const cors = parseCorsConfig(env, knobs);
  const bodyLimit = parseBodyLimit(env, knobs);
  const pageLimits = parsePageLimits(env, knobs);
  const snapshotLimit = parseSnapshotLimit(env, knobs, pageLimits.maxLimit);
  const keyReprimeIntervalMs = parseKeyReprimeIntervalMs(env, knobs);
  knobs.recordSecret(
    'streamTicketSecret',
    'SUBSTRATE_STREAM_TICKET_SECRET',
    env.SUBSTRATE_STREAM_TICKET_SECRET
  );
  knobs.record(
    'systemActor',
    'SUBSTRATE_SYSTEM_ACTOR',
    env.SUBSTRATE_SYSTEM_ACTOR,
    nonEmpty(env.SUBSTRATE_SYSTEM_ACTOR?.trim()) ?? null
  );
  // Trimmed before the empty check: an env line with a trailing space, or a
  // whitespace-only value, must read as ABSENT rather than as a valid-looking
  // HMAC key. compose() rejects a whitespace secret too — this is the outer
  // half of that pair, so the operator sees "missing", not "too short".
  const streamTicketSecret = nonEmpty(env.SUBSTRATE_STREAM_TICKET_SECRET?.trim()) ?? null;
  return {
    storeSpec,
    memoryByDefault,
    bridges,
    bridgeCreds,
    auth,
    tls,
    sweepIntervalMs,
    inviteSweepIntervalMs,
    tombstoneRetentionDays,
    shutdownGraceMs,
    partitionBudget,
    indexDiskPath,
    indexDiskMarginMb,
    indexRetryIntervalMs,
    advisorIntervalMs,
    storeProfile,
    storeWriteHeavy,
    idempotency,
    trustedProxies,
    port,
    host,
    cors,
    bodyLimit,
    pageLimits,
    snapshotLimit,
    keyReprimeIntervalMs,
    knobs: knobs.report(),
    streamTicketSecret,
    systemActor: nonEmpty(env.SUBSTRATE_SYSTEM_ACTOR?.trim()) ?? null
  };
}

/**
 * Parse `SUBSTRATE_KEY_REFRESH_INTERVAL_MS` — periodic public-key-cache re-prime
 * interval in ms. Unset or empty → {@link DEFAULT_KEY_REPRIME_INTERVAL_MS}.
 * The literal `off` disables it. A set value must otherwise be a positive
 * integer; anything else is a config bug and throws rather than silently
 * disabling the safety net.
 *
 * On by default: single-instance deployments are exactly where nothing else
 * repairs a stale cache entry.
 */
export const DEFAULT_KEY_REPRIME_INTERVAL_MS = 30_000;

function parseKeyReprimeIntervalMs(env: NodeJS.ProcessEnv, knobs: KnobRecorder): number | null {
  const note = (v: number | null): number | null =>
    knobs.record(
      'keyReprimeIntervalMs',
      'SUBSTRATE_KEY_REFRESH_INTERVAL_MS',
      env.SUBSTRATE_KEY_REFRESH_INTERVAL_MS,
      v
    );
  const raw = nonEmpty(env.SUBSTRATE_KEY_REFRESH_INTERVAL_MS);
  if (raw === undefined) return note(DEFAULT_KEY_REPRIME_INTERVAL_MS);
  if (raw.trim().toLowerCase() === 'off') return note(null);
  try {
    return note(parsePositiveInt(raw, 'SUBSTRATE_KEY_REFRESH_INTERVAL_MS', 0));
  } catch (err) {
    throw new EnvConfigError(
      `${err instanceof Error ? err.message : String(err)} — expected a positive integer (milliseconds)`
    );
  }
}

/**
 * Parse `SUBSTRATE_BODY_LIMIT_BYTES` — max Fastify request body size in bytes. Unset or
 * empty (docker `${VAR:-}` substitution) → `null`, leaving Fastify's 1 MiB
 * default in place. A set value must be a positive integer; anything else is a
 * config bug and throws rather than silently falling back.
 */
function parseBodyLimit(env: NodeJS.ProcessEnv, knobs: KnobRecorder): number | null {
  const note = (v: number | null): number | null =>
    knobs.record('bodyLimit', 'SUBSTRATE_BODY_LIMIT_BYTES', env.SUBSTRATE_BODY_LIMIT_BYTES, v);
  const raw = nonEmpty(env.SUBSTRATE_BODY_LIMIT_BYTES);
  if (raw === undefined) return note(null);
  try {
    return note(parsePositiveInt(raw, 'SUBSTRATE_BODY_LIMIT_BYTES', 0));
  } catch (err) {
    throw new EnvConfigError(
      `${err instanceof Error ? err.message : String(err)} — expected a positive integer (bytes)`
    );
  }
}

/** Parse `SUBSTRATE_PAGE_LIMIT_DEFAULT` (100) and `SUBSTRATE_PAGE_LIMIT_MAX` (1000). */
function parsePageLimits(
  env: NodeJS.ProcessEnv,
  knobs: KnobRecorder
): { defaultLimit: number; maxLimit: number } {
  const read = (name: string, fallback: number): number => {
    const raw = nonEmpty(env[name]);
    const v = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(v) || v <= 0) {
      throw new EnvConfigError(`${name}: invalid value '${raw}' — expected a positive integer`);
    }
    return knobs.record(
      name === 'SUBSTRATE_PAGE_LIMIT_MAX' ? 'pageLimitMax' : 'pageLimitDefault',
      name,
      env[name],
      v
    );
  };
  const defaultLimit = read('SUBSTRATE_PAGE_LIMIT_DEFAULT', 100);
  const maxLimit = read('SUBSTRATE_PAGE_LIMIT_MAX', 1000);
  if (defaultLimit > maxLimit) {
    throw new EnvConfigError(
      `SUBSTRATE_PAGE_LIMIT_DEFAULT (${defaultLimit}) exceeds SUBSTRATE_PAGE_LIMIT_MAX (${maxLimit})`
    );
  }
  return { defaultLimit, maxLimit };
}

/** Parse `SUBSTRATE_SNAPSHOT_LIMIT`, defaulting to the max page size. */
function parseSnapshotLimit(env: NodeJS.ProcessEnv, knobs: KnobRecorder, fallback: number): number {
  const raw = nonEmpty(env.SUBSTRATE_SNAPSHOT_LIMIT);
  const v = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(v) || v <= 0) {
    throw new EnvConfigError(
      `SUBSTRATE_SNAPSHOT_LIMIT: invalid value '${raw}' — expected a positive integer`
    );
  }
  return knobs.record('snapshotLimit', 'SUBSTRATE_SNAPSHOT_LIMIT', env.SUBSTRATE_SNAPSHOT_LIMIT, v);
}

/**
 * Parse `SUBSTRATE_TRUSTED_PROXIES` — CSV of exact peer-IP strings. Entries are
 * trimmed; empty entries are dropped. A non-empty value that devolves to an
 * empty set after trimming (e.g. `",,,"`) is a config bug and throws —
 * silently treating it as "no trust" would mask a deployment typo.
 */
function parseTrustedProxies(env: NodeJS.ProcessEnv, knobs: KnobRecorder): Set<string> {
  const raw = env.SUBSTRATE_TRUSTED_PROXIES;
  const note = (ips: Set<string>): Set<string> => {
    // Reported as the effective CSV rather than the raw string: the question
    // is which peers this process trusts, and a raw value with stray commas
    // or spacing answers a different one.
    knobs.record('trustedProxies', 'SUBSTRATE_TRUSTED_PROXIES', raw, [...ips].join(',') || null);
    return ips;
  };
  if (raw === undefined || raw.trim() === '') return note(new Set<string>());
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new EnvConfigError(
      `SUBSTRATE_TRUSTED_PROXIES: value '${raw}' contains no usable IP entries — supply a CSV of exact peer-IP strings or unset the var`
    );
  }
  return note(new Set<string>(parts));
}

/**
 * Parse `SUBSTRATE_CORS_ORIGINS` — optional CORS origin allowlist for browser clients.
 *
 * Returns `null` when the env var is unset or empty — the CORS plugin is not
 * registered and the server behaves as it does today (agent-only deployments).
 *
 * `'*'` allows any origin. Credentials are automatically disabled for wildcard
 * origins because browsers reject `Access-Control-Allow-Credentials: true` when
 * the origin is `*`. An explicit comma-separated list enables credentialed
 * cross-origin requests (Authorization header) from those origins.
 */
function parseCorsConfig(
  env: NodeJS.ProcessEnv,
  knobs: KnobRecorder
): { origins: string[] | '*'; credentials: boolean } | null {
  const raw = env.SUBSTRATE_CORS_ORIGINS;
  type Cors = { origins: string[] | '*'; credentials: boolean } | null;
  const note = (c: Cors): Cors => {
    const value = c === null ? null : c.origins === '*' ? '*' : c.origins.join(',');
    knobs.record('cors', 'SUBSTRATE_CORS_ORIGINS', raw, value);
    return c;
  };
  if (raw === undefined || raw.trim() === '') return note(null);
  const trimmed = raw.trim();
  if (trimmed === '*') return note({ origins: '*', credentials: false });
  const origins = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (origins.length === 0) {
    throw new EnvConfigError(
      `SUBSTRATE_CORS_ORIGINS: value '${raw}' contains no usable origin entries — supply a CSV of origins, '*', or unset the var`
    );
  }
  return note({ origins, credentials: true });
}

const diskPathOf = (raw: string | undefined): string | 'off' | null =>
  raw === undefined ? null : raw.toLowerCase() === 'off' ? 'off' : raw;

/** As {@link parsePositiveIntEnv}, but 0 is allowed. */
function parseNonNegativeIntEnv(
  env: NodeJS.ProcessEnv,
  knobs: KnobRecorder,
  key: string,
  varName: string,
  defaultValue: number,
  units: string
): number {
  const raw = nonEmpty(env[varName]);
  const n = raw === undefined ? defaultValue : Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new EnvConfigError(
      `${varName}: got '${raw}' — expected a non-negative integer (${units})`
    );
  }
  return knobs.record(key, varName, env[varName], n);
}

/**
 * Parses positive-integer env var `varName`, falling back to `defaultValue`
 * when unset or empty, and records it under `key`. Throws `EnvConfigError`
 * naming the var and `units` on a malformed value.
 *
 * Empty must mean unset: docker-compose `${VAR:-}` passes `""`, and NaN
 * flowing into `setInterval` fires the callback every 1 ms.
 */
function parsePositiveIntEnv(
  env: NodeJS.ProcessEnv,
  knobs: KnobRecorder,
  key: string,
  varName: string,
  defaultValue: number,
  units: string
): number {
  const raw = env[varName];
  try {
    return knobs.record(key, varName, raw, parsePositiveInt(nonEmpty(raw), varName, defaultValue));
  } catch (err) {
    throw new EnvConfigError(
      `${varName}: ${err instanceof Error ? err.message : String(err)} — expected a positive integer (${units})`
    );
  }
}

/** Parse `SUBSTRATE_SWEEP_INTERVAL_MS` — main edge-sweep cadence (§6.4 reaper). Default 5min. */
function parseSweepIntervalMs(env: NodeJS.ProcessEnv, knobs: KnobRecorder): number {
  return parsePositiveIntEnv(
    env,
    knobs,
    'sweepIntervalMs',
    'SUBSTRATE_SWEEP_INTERVAL_MS',
    DEFAULT_SWEEP_INTERVAL_MS,
    'milliseconds'
  );
}

/** Parse `SUBSTRATE_INVITE_SWEEP_INTERVAL_MS` — reaper cadence for expired `Invite` rows. Default 1h. */
function parseInviteSweepIntervalMs(env: NodeJS.ProcessEnv, knobs: KnobRecorder): number {
  return parsePositiveIntEnv(
    env,
    knobs,
    'inviteSweepIntervalMs',
    'SUBSTRATE_INVITE_SWEEP_INTERVAL_MS',
    DEFAULT_INVITE_SWEEP_INTERVAL_MS,
    'milliseconds'
  );
}

/**
 * Parse `SUBSTRATE_TOMBSTONE_RETENTION_DAYS` — retention window before tombstoned
 * `rows` / `edges` are hard-deleted by the sweep loop. Default 30.
 */
function parseTombstoneRetentionDays(env: NodeJS.ProcessEnv, knobs: KnobRecorder): number {
  return parsePositiveIntEnv(
    env,
    knobs,
    'tombstoneRetentionDays',
    'SUBSTRATE_TOMBSTONE_RETENTION_DAYS',
    DEFAULT_TOMBSTONE_RETENTION_DAYS,
    'days'
  );
}

/** Parse `SUBSTRATE_SHUTDOWN_GRACE_MS` — graceful drain deadline. Default 5s. */
function parseShutdownGraceMs(env: NodeJS.ProcessEnv, knobs: KnobRecorder): number {
  return parsePositiveIntEnv(
    env,
    knobs,
    'shutdownGraceMs',
    'SUBSTRATE_SHUTDOWN_GRACE_MS',
    DEFAULT_SHUTDOWN_GRACE_MS,
    'milliseconds'
  );
}

/**
 * Parse `PORT` — Fastify HTTP listen port. Defaults to 3100. Empty string
 * and unset both fall back to the default; malformed values throw at boot.
 */
function parsePort(env: NodeJS.ProcessEnv, knobs: KnobRecorder): number {
  const raw = env.PORT;
  const note = (v: number): number => knobs.record('port', 'PORT', raw, v);
  if (raw === undefined || raw === '') return note(DEFAULT_PORT);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new EnvConfigError(`PORT: invalid value '${raw}' — expected an integer in 1..65535`);
  }
  return note(parsed);
}

/**
 * `SUBSTRATE_PUBLIC_ORIGIN`: comma-separated origins (`https://a:3100,https://b`)
 * a token's `aud` may name. Null when unset; anything not a bare http(s)
 * origin throws.
 */
function parsePublicOrigins(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  return raw.split(',').map((part) => {
    const entry = part.trim();
    let origin: string | undefined;
    try {
      const url = new URL(entry);
      if (url.protocol === 'https:' || url.protocol === 'http:') origin = url.origin;
    } catch {
      // Reported below.
    }
    if (origin === undefined || origin !== entry.replace(/\/$/, '')) {
      throw new EnvConfigError(
        `SUBSTRATE_PUBLIC_ORIGIN: '${entry}' is not an origin like 'https://host:3100'`
      );
    }
    return origin;
  });
}

// BlockList also matches IPv4-mapped IPv6 (`::ffff:127.0.0.1`) against the IPv4 subnet.
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[(.*)\]$/, '$1');
  if (h.toLowerCase() === 'localhost') return true;
  const family = isIP(h);
  return family !== 0 && LOOPBACK.check(h, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Parses the §5.13 idempotency knobs. Dedup is on by default;
 * `SUBSTRATE_IDEMPOTENCY_DISABLED` honours `1` / `true` (case-insensitive). A
 * malformed TTL (non-integer, negative) throws `EnvConfigError`.
 */
function parseIdempotencyConfig(
  env: NodeJS.ProcessEnv,
  knobs: KnobRecorder
): {
  defaultTtlMs: number | null;
  disabled: boolean;
} {
  const disabledRaw = env.SUBSTRATE_IDEMPOTENCY_DISABLED;
  const disabled =
    disabledRaw !== undefined && (disabledRaw === '1' || disabledRaw.toLowerCase() === 'true');
  knobs.record('idempotencyDisabled', 'SUBSTRATE_IDEMPOTENCY_DISABLED', disabledRaw, disabled);
  const ttlRaw = env.SUBSTRATE_IDEMPOTENCY_TTL_MS;
  // `null` means the engine's own 24h default, not "no TTL".
  const noteTtl = (v: number | null): number | null =>
    knobs.record('idempotencyTtlMs', 'SUBSTRATE_IDEMPOTENCY_TTL_MS', ttlRaw, v);
  if (disabled) {
    noteTtl(null);
    return { defaultTtlMs: null, disabled: true };
  }

  if (ttlRaw === undefined || ttlRaw === '') {
    return { defaultTtlMs: noteTtl(null), disabled: false };
  }
  const parsed = Number(ttlRaw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new EnvConfigError(
      `SUBSTRATE_IDEMPOTENCY_TTL_MS: invalid value '${ttlRaw}' — expected a non-negative integer (milliseconds)`
    );
  }
  return { defaultTtlMs: noteTtl(parsed), disabled: false };
}

/**
 * Read TLS material off disk at parse time. Partial key/cert pairs are a
 * config bug — silently downgrading to plaintext would mask a deployment
 * mistake, so we throw. CA is optional (many deployments use the server cert
 * alone or a `fullchain.pem` with the chain inlined).
 */
function parseTlsConfig(env: NodeJS.ProcessEnv): TlsConfig | null {
  const keyPath = env.SUBSTRATE_TLS_KEY_PATH;
  const certPath = env.SUBSTRATE_TLS_CERT_PATH;
  const caPath = env.SUBSTRATE_TLS_CA_PATH;
  const hasKey = typeof keyPath === 'string' && keyPath.length > 0;
  const hasCert = typeof certPath === 'string' && certPath.length > 0;
  if (!hasKey && !hasCert) {
    if (typeof caPath === 'string' && caPath.length > 0) {
      throw new EnvConfigError(
        'SUBSTRATE_TLS_CA_PATH set but SUBSTRATE_TLS_KEY_PATH and SUBSTRATE_TLS_CERT_PATH are not'
      );
    }
    return null;
  }
  if (!hasKey) {
    throw new EnvConfigError('SUBSTRATE_TLS_CERT_PATH set but SUBSTRATE_TLS_KEY_PATH is not');
  }
  if (!hasCert) {
    throw new EnvConfigError('SUBSTRATE_TLS_KEY_PATH set but SUBSTRATE_TLS_CERT_PATH is not');
  }
  const key = readTlsFile('SUBSTRATE_TLS_KEY_PATH', keyPath);
  const cert = readTlsFile('SUBSTRATE_TLS_CERT_PATH', certPath);
  const tls: TlsConfig = { key, cert };
  if (typeof caPath === 'string' && caPath.length > 0) {
    tls.ca = readTlsFile('SUBSTRATE_TLS_CA_PATH', caPath);
  }
  return tls;
}

function readTlsFile(envVar: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new EnvConfigError(
      `${envVar}: cannot read '${path}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// Returns the binary's version from package.json. The JSON import is inlined
// at build time, so this works in the bundled binary, which has no
// package.json beside it.
export function readPackageVersion(): string {
  if (typeof pkg.version === 'string' && pkg.version.length > 0) {
    return pkg.version;
  }
  process.stderr.write(
    "warning: apps/substrate package.json has no string 'version' field — onboard will report '0.0.0'\n"
  );
  return '0.0.0';
}

/**
 * The binary's substrate-types contract version. Lifted from package.json at
 * build time; vite inlines the import so the bundled binary carries the
 * literal value. Plugin contractVersion ranges are checked against this.
 */
export const BINARY_CONTRACT_VERSION: string = readPackageVersion();

/**
 * Throws `EnvConfigError` for a plugin whose `contractVersion` does not admit
 * this binary. Fatal by design: a plugin built against an unsatisfied
 * contract fails silently rather than loudly.
 */
export function refuseContractViolation(v: ContractViolation): never {
  const detail =
    v.reason === 'invalid-range'
      ? `declares contractVersion '${v.declared}', which is not a valid semver range`
      : `declares contractVersion '${v.declared}', which does not admit this binary (${v.hostVersion})`;
  throw new EnvConfigError(
    `[${v.packageName}] ${v.tier} plugin ${detail}. ` +
      `Refusing to load it: a plugin built against a contract this binary does not satisfy ` +
      `fails silently rather than loudly, which is why this is fatal. ` +
      `Fix by widening that plugin's contractVersion to admit ${v.hostVersion} — ` +
      `a range's ceiling tracks actual compatibility, so it moves only ` +
      `when a major genuinely breaks the plugin interface, not at every major boundary.`
  );
}

export function parseBridges(raw: string | undefined): Array<BridgeSpec> {
  if (raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new EnvConfigError(
      `SUBSTRATE_BRIDGES: invalid JSON — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new EnvConfigError(
      'SUBSTRATE_BRIDGES: must be a JSON array of { ns, name, url } entries'
    );
  }
  const out: Array<BridgeSpec> = [];
  for (const [i, entry] of parsed.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new EnvConfigError(`SUBSTRATE_BRIDGES: entry ${i} must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const ns = e.ns;
    const name = e.name;
    const url = e.url;
    if (typeof ns !== 'string' || ns.length === 0) {
      throw new EnvConfigError(`SUBSTRATE_BRIDGES: entry ${i} missing string 'ns'`);
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new EnvConfigError(`SUBSTRATE_BRIDGES: entry ${i} missing string 'name'`);
    }
    if (typeof url !== 'string' || url.length === 0) {
      throw new EnvConfigError(`SUBSTRATE_BRIDGES: entry ${i} missing string 'url'`);
    }
    out.push({ ns, name, url });
  }
  return out;
}

export function parseBridgeCreds(raw: string | undefined): MemoryBridgeCredentialStore {
  const store = new MemoryBridgeCredentialStore();
  if (raw === undefined || raw.trim() === '') return store;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new EnvConfigError(
      `SUBSTRATE_BRIDGE_CREDENTIALS: invalid JSON — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EnvConfigError(
      'SUBSTRATE_BRIDGE_CREDENTIALS: must be a JSON object mapping bridge name → { keyPath, kid }'
    );
  }
  for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new EnvConfigError(`SUBSTRATE_BRIDGE_CREDENTIALS: entry '${name}' must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.keyPath !== 'string' || e.keyPath.length === 0) {
      throw new EnvConfigError(
        `SUBSTRATE_BRIDGE_CREDENTIALS: entry '${name}' missing string 'keyPath'`
      );
    }
    if (typeof e.kid !== 'string' || e.kid.length === 0) {
      throw new EnvConfigError(
        `SUBSTRATE_BRIDGE_CREDENTIALS: entry '${name}' missing string 'kid'`
      );
    }
    // `origin` is required with no opt-out: the allowlist must gate WHERE a
    // bridge points, not merely WHICH coordinator may form one. Absent it, a
    // provisioned name pointed at an attacker's URL still mints a valid token.
    if (typeof e.origin !== 'string' || e.origin.length === 0) {
      throw new EnvConfigError(
        `SUBSTRATE_BRIDGE_CREDENTIALS: entry '${name}' missing string 'origin'`
      );
    }
    // Stored canonicalised so every downstream comparison is origin-vs-origin.
    // An unparseable value is a misconfiguration that would otherwise match
    // nothing at all — surface it here rather than as a silent never-bridges.
    let origin: string;
    try {
      const parsed = new URL(e.origin);
      // Opaque schemes (`foo://bar`, `file:///x`, `data:…`) all canonicalise to
      // the literal string "null", which would then match EVERY advertised URL
      // with an opaque origin — a match-anything credential.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new EnvConfigError(
          `SUBSTRATE_BRIDGE_CREDENTIALS: entry '${name}' has a non-http(s) 'origin' — ` +
            `expected http:// or https://, got '${e.origin}'`
        );
      }
      origin = parsed.origin;
    } catch (err) {
      if (err instanceof EnvConfigError) throw err;
      throw new EnvConfigError(
        `SUBSTRATE_BRIDGE_CREDENTIALS: entry '${name}' has a malformed 'origin' — ` +
          `expected scheme://host[:port], got '${e.origin}'`
      );
    }
    store.set(name, { keyPath: e.keyPath, kid: e.kid, origin });
  }
  return store;
}
