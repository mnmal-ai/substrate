import type { BridgeClient, PackEnvelope } from '@mnmal-ai/substrate-types';
import { BridgeUnreachableError } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { BridgeSubsystem } from '../src/engine/bridge.js';

function envelope(): PackEnvelope {
  return { schemaVersion: 'test', data: {}, shapes: {} };
}

function bridgeStub(name: string): BridgeClient {
  return {
    name,
    baseUrl: 'http://remote.test',
    federatedSchema: async () => ({}),
    query: async () => ({ schemaVersion: 't', data: {}, shapes: {} }),
    mutate: async () => ({ schemaVersion: 't', data: {}, shapes: {} }),
    readRow: async () => null,
    isReachable: () => false,
    dispose: () => {}
  };
}

describe('bridge completeness', () => {
  it('marks the key incomplete and names the bridge when unreachable', async () => {
    const sub = new BridgeSubsystem({
      bridges: {
        has: () => true,
        get: () => bridgeStub('peripheral-a'),
        isUnreachable: () => true,
        entries: () => []
      },
      metric: () => {}
    });
    const env = envelope();
    await sub.runQuery('alpha', { 'alpha/Widget': { fields: { id: true } } }, env);

    expect(env._completeness).toEqual({
      'alpha/Widget': { complete: false, unreachable: ['peripheral-a'] }
    });
    // The per-row orphan marker is unchanged — §6.6 still holds.
    expect(env.data['alpha/Widget']).toEqual({ __orphan: true, reason: 'bridge_unreachable' });
  });

  it('leaves _completeness absent when the bridge is healthy', async () => {
    const sub = new BridgeSubsystem({
      bridges: {
        has: () => true,
        get: () => ({ ...bridgeStub('peripheral-a'), isReachable: () => true }),
        isUnreachable: () => false,
        entries: () => []
      },
      metric: () => {}
    });
    const env = envelope();
    await sub.runQuery('alpha', { 'alpha/Widget': { fields: { id: true } } }, env);

    expect(env._completeness).toBeUndefined();
  });

  // `errors[]` and `_completeness` describe the same fact; a consumer reading
  // only the typed sidecar must not read a refused bridge read as complete.
  it('marks the key incomplete when the bridge throws a non-unreachable error', async () => {
    const sub = new BridgeSubsystem({
      bridges: {
        has: () => true,
        get: () => ({
          ...bridgeStub('peripheral-a'),
          isReachable: () => true,
          query: async () => {
            throw new Error('remote refused');
          }
        }),
        isUnreachable: () => false,
        entries: () => []
      },
      metric: () => {}
    });
    const env = envelope();
    await sub.runQuery('alpha', { 'alpha/Widget': { fields: { id: true } } }, env);

    expect(env.errors?.[0]?.code).toBe('bridge_error');
    expect(env._completeness).toEqual({
      'alpha/Widget': { complete: false, unreachable: ['peripheral-a'] }
    });
  });
});

/**
 * §6: a misprovisioned credential and a down peer present identically to the
 * caller but demand opposite operator responses. Merging them in metrics hides
 * the misconfiguration behind an apparent outage.
 */
describe('bridge auth-failure metric', () => {
  function subsystemThrowing(err: unknown, metrics: Array<string>): BridgeSubsystem {
    return new BridgeSubsystem({
      bridges: {
        has: () => true,
        get: () => ({
          ...bridgeStub('peripheral-a'),
          isReachable: () => true,
          query: async () => {
            throw err;
          },
          mutate: async () => {
            throw err;
          }
        }),
        isUnreachable: () => false,
        entries: () => []
      },
      metric: (name: string) => {
        metrics.push(name);
      }
    });
  }

  it('reports a 401 as bridge_auth_failed, not as an unreachable read', async () => {
    const metrics: Array<string> = [];
    const err = new BridgeUnreachableError('peripheral-a', 'http://remote.test', 'HTTP 401 (auth)');
    const env = envelope();
    await subsystemThrowing(err, metrics).runQuery(
      'alpha',
      { 'alpha/Widget': { fields: { id: true } } },
      env
    );

    expect(metrics).toEqual(['bridge_auth_failed']);
    // Still non-fatal for the caller — §6.6 is unchanged by the metric split.
    expect(env.data['alpha/Widget']).toEqual({ __orphan: true, reason: 'bridge_unreachable' });
    expect(env._completeness?.['alpha/Widget']?.complete).toBe(false);
  });

  it('still reports a genuine outage as engine_bridge_unreachable_read', async () => {
    const metrics: Array<string> = [];
    const err = new BridgeUnreachableError('peripheral-a', 'http://remote.test', 'ECONNREFUSED');
    await subsystemThrowing(err, metrics).runQuery(
      'alpha',
      { 'alpha/Widget': { fields: { id: true } } },
      envelope()
    );

    expect(metrics).toEqual(['engine_bridge_unreachable_read']);
  });

  it('splits the mutate path the same way', async () => {
    const authMetrics: Array<string> = [];
    await subsystemThrowing(
      new BridgeUnreachableError('peripheral-a', 'http://remote.test', 'HTTP 403 (auth)'),
      authMetrics
    ).runMutate('alpha', { 'alpha/createWidget': { params: {} } }, envelope());
    expect(authMetrics).toEqual(['bridge_auth_failed']);

    const downMetrics: Array<string> = [];
    await subsystemThrowing(
      new BridgeUnreachableError('peripheral-a', 'http://remote.test', 'ECONNREFUSED'),
      downMetrics
    ).runMutate('alpha', { 'alpha/createWidget': { params: {} } }, envelope());
    expect(downMetrics).toEqual(['engine_bridge_unreachable_mutate']);
  });
});

describe('bridge error wording', () => {
  it('names the bridge but never its base URL, and keeps the detail in the metric', async () => {
    const metrics: Array<{ name: string; payload: unknown }> = [];
    const sub = new BridgeSubsystem({
      bridges: {
        has: () => true,
        get: () => ({
          ...bridgeStub('peripheral-a'),
          isReachable: () => true,
          mutate: async () => {
            throw new BridgeUnreachableError('peripheral-a', 'http://10.1.2.3:3100', 'ECONNRESET');
          },
          query: async () => {
            throw new Error('http://10.1.2.3:3100 said no');
          }
        }),
        isUnreachable: () => false,
        entries: () => []
      },
      metric: (name, payload) => metrics.push({ name, payload })
    });
    const env = envelope();
    await sub.runMutate('alpha', { 'alpha/createWidget': { params: {} } }, env);
    await sub.runQuery('alpha', { 'alpha/Widget': { fields: { id: true } } }, env);

    expect(env.errors?.map((e) => e.message)).toEqual([
      "bridge 'peripheral-a' unreachable",
      "bridge 'peripheral-a' request failed"
    ]);
    expect(JSON.stringify(metrics)).toContain('10.1.2.3');
  });
});
