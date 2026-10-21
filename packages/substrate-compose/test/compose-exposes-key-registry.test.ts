/**
 * `ComposeResult.keyRegistry`.
 *
 * compose derives `{ ...opts.auth, keyRegistry }` for its own routes without
 * mutating the caller's AuthConfig. Routes mounted outside compose (substrate
 * kernel routes) need that same registry: `verifyBearerToken` consults
 * `cfg.keyRegistry` to resolve an asymmetric kid, and without it a GOOD agent
 * token 401s as present-but-invalid. Exposing the one compose built keeps a
 * single construction site.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { describe, expect, it } from 'vitest';
import type { AuthConfig } from '../src/auth.js';
import { compose } from '../src/compose.js';

const streamTicketSecret = 'test-stream-ticket-secret';

describe('ComposeResult.keyRegistry', () => {
  it('is exposed when auth is on, so the root can mount kernel routes with it', async () => {
    const auth: AuthConfig = {
      keys: [{ kid: 'kr-test', alg: 'HS256', publicKey: 'key-registry-test-secret' }]
    };
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server: new MemorySubstrateServer(),
      dataset: new MemoryDataset({ namespace: 'default' }),
      auth,
      streamTicketSecret
    });

    // The whole point: the root needs a handle to the SAME registry compose
    // primed. Building a second one would reintroduce the divergence.
    expect(composed.keyRegistry).not.toBeNull();
    expect(typeof composed.keyRegistry?.lookup).toBe('function');
    await composed.stop();
  });

  it('is null — not undefined — when auth is off', async () => {
    // A caller must be able to tell "auth disabled" from "registry not ready";
    // an optional field would collapse the two.
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server: new MemorySubstrateServer(),
      dataset: new MemoryDataset({ namespace: 'default' }),
      streamTicketSecret
    });
    expect(composed.keyRegistry).toBeNull();
    expect('keyRegistry' in composed).toBe(true);
    await composed.stop();
  });

  it('does NOT mutate the caller AuthConfig — the care that created the gap', async () => {
    // The derived config must not mutate the caller's AuthConfig.
    const auth: AuthConfig = {
      keys: [{ kid: 'kr-test-2', alg: 'HS256', publicKey: 'another-test-secret' }]
    };
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server: new MemorySubstrateServer(),
      dataset: new MemoryDataset({ namespace: 'default' }),
      auth,
      streamTicketSecret
    });
    expect(auth.keyRegistry).toBeUndefined();
    await composed.stop();
  });
});
