/**
 * Every knob with a default reports its effective value AND whether that
 * value came from the operator. The environment is the input; only the
 * process knows what it resolved to.
 *
 * The completeness test is the load-bearing one: it reads the env accesses
 * out of `serve/config.ts` and requires each to be either reported or
 * explicitly exempted with a reason, so a newly added knob cannot go
 * unreported.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/serve/config.js';

const CONFIG_SRC = join(dirname(fileURLToPath(import.meta.url)), '../src/serve/config.ts');

/**
 * Env vars read by `parseEnv` that carry NO default, so there is no
 * default-vs-explicit question to answer. Each needs a reason, because an
 * exemption list is how a completeness check quietly stops being one.
 */
const NO_DEFAULT: Record<string, string> = {
  SUBSTRATE_BRIDGES:
    'no default — absent means no bridges, and each entry is validated structurally',
  SUBSTRATE_BRIDGE_CREDENTIALS:
    'no default — fail-closed; a bridge without a credential refuses to boot',
  SUBSTRATE_TLS_KEY_PATH: 'no default — TLS is on or off, and the boot report says which',
  SUBSTRATE_TLS_CERT_PATH: 'no default — see SUBSTRATE_TLS_KEY_PATH',
  SUBSTRATE_TLS_CA_PATH: 'no default — optional chain material, reported as part of tls: enabled'
};

/** Every `env.FOO` / `env[FOO]` property access in the parser source. */
function envVarsReadByConfig(): string[] {
  const src = readFileSync(CONFIG_SRC, 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) names.add(m[1] as string);
  // `parsePositiveIntEnv` reads `env[varName]`, so its four callers pass the
  // name as a literal. Those literals are the access, and a regex over
  // `env.FOO` cannot see them.
  for (const m of src.matchAll(/'(SUBSTRATE_[A-Z0-9_]+)'/g)) names.add(m[1] as string);
  return [...names];
}

describe('knob report', () => {
  it('reports every defaulted knob, or names why it is exempt', () => {
    const reported = new Set(Object.values(parseEnv({}).knobs).map((k) => k.env));
    const unreported = envVarsReadByConfig().filter(
      (v) => !reported.has(v) && !Object.hasOwn(NO_DEFAULT, v)
    );
    expect(unreported).toEqual([]);
  });

  it('says default when the operator set nothing', () => {
    const knobs = parseEnv({}).knobs;
    expect(knobs.sweepIntervalMs).toEqual({
      env: 'SUBSTRATE_SWEEP_INTERVAL_MS',
      value: 300_000,
      source: 'default'
    });
    expect(knobs.port).toEqual({ env: 'PORT', value: 3100, source: 'default' });
    expect(knobs.host).toEqual({ env: 'HOST', value: '127.0.0.1', source: 'default' });
  });

  it('says explicit when the operator set the value the default would have produced', () => {
    // The point of the field. Setting a knob to its own default is NOT the
    // same as leaving it alone: the explicit value survives a change to the
    // default, so a host that typed this keeps its number when everyone
    // else's moves. That difference is invisible in the value alone.
    const knobs = parseEnv({ SUBSTRATE_SWEEP_INTERVAL_MS: '300000' }).knobs;
    expect(knobs.sweepIntervalMs).toEqual({
      env: 'SUBSTRATE_SWEEP_INTERVAL_MS',
      value: 300_000,
      source: 'explicit'
    });
  });

  it('treats an empty string as unset, matching what the parsers do with it', () => {
    // docker-compose `${VAR:-}` passes `""` for a blank .env line. Every
    // parser already reads that as absent; a report that called it explicit
    // would state the operator's intent backwards in exactly the deployments
    // most likely to have made the mistake.
    expect(parseEnv({ SUBSTRATE_SWEEP_INTERVAL_MS: '' }).knobs.sweepIntervalMs?.source).toBe(
      'default'
    );
    expect(parseEnv({ PORT: '' }).knobs.port).toEqual({
      env: 'PORT',
      value: 3100,
      source: 'default'
    });
  });

  it('reports a null effective value for knobs that defer to a lower layer', () => {
    // `null` is an answer — Fastify's own 1 MiB cap, the engine's 24h TTL —
    // and distinct from the knob being unreported. Both appear.
    const knobs = parseEnv({}).knobs;
    expect(knobs.bodyLimit).toEqual({
      env: 'SUBSTRATE_BODY_LIMIT_BYTES',
      value: null,
      source: 'default'
    });
    expect(knobs.idempotencyTtlMs?.value).toBeNull();
  });

  it('never carries a secret value, but does answer whether one is set', () => {
    const unset = parseEnv({}).knobs.streamTicketSecret;
    expect(unset).toEqual({
      env: 'SUBSTRATE_STREAM_TICKET_SECRET',
      value: null,
      source: 'default',
      redacted: true
    });
    const set = parseEnv({ SUBSTRATE_STREAM_TICKET_SECRET: 'hunter2-hunter2-hunter2' }).knobs
      .streamTicketSecret;
    expect(set).toEqual({
      env: 'SUBSTRATE_STREAM_TICKET_SECRET',
      value: '<set>',
      source: 'explicit',
      redacted: true
    });
    expect(
      JSON.stringify(parseEnv({ SUBSTRATE_STREAM_TICKET_SECRET: 'hunter2-hunter2-hunter2' }).knobs)
    ).not.toContain('hunter2');
  });

  it('NEVER reports a credential, including one embedded in a URL', () => {
    // Redaction is judged by what a value CAN CONTAIN, not by its name: the
    // connection string carries the database password.
    const url = 'postgres://substrate:sup3r-s3cret@127.0.0.1:5433/substrate_prod';
    const knobs = parseEnv({ SUBSTRATE_DATABASE_URL: url }).knobs;
    expect(JSON.stringify(knobs)).not.toContain('sup3r-s3cret');
    // The user and host stay — useful to ops, and not sensitive alone.
    expect(knobs.storeSpec?.value).toBe(
      'postgres://substrate:<redacted>@127.0.0.1:5433/substrate_prod'
    );
  });

  it('still hands the LIVE connection string to the rest of the config', () => {
    // The redaction belongs to the report, not to the value. Redacting
    // `storeSpec` itself would leave the server unable to reach postgres.
    const url = 'postgres://substrate:sup3r-s3cret@127.0.0.1:5433/substrate_prod';
    expect(parseEnv({ SUBSTRATE_DATABASE_URL: url }).storeSpec).toBe(url);
  });

  it('reports the EFFECTIVE value, not the raw string', () => {
    // A raw value answers a different question than "what is this process
    // doing". Trailing spacing and stray commas are the operator's typing,
    // not the trust list.
    expect(
      parseEnv({ SUBSTRATE_TRUSTED_PROXIES: '10.0.0.1, 10.0.0.2 ,' }).knobs.trustedProxies
    ).toEqual({ env: 'SUBSTRATE_TRUSTED_PROXIES', value: '10.0.0.1,10.0.0.2', source: 'explicit' });
  });
});
