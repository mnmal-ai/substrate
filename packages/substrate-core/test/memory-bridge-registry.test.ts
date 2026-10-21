/**
 * MemoryBridgeRegistry — §5.8 registry surface. Does not touch a real
 * BridgeClient: a minimal stub suffices to verify has/get/isUnreachable/
 * entries semantics.
 */

import type {
  BridgeClient,
  BridgeFrame,
  EdgeRef,
  PackEnvelope,
  Row,
  Schema
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { MemoryBridgeRegistry } from '../src/index.js';
import { DuplicateBridgeRegistration } from '../src/memory-bridge-registry.js';

function mkClient(name: string, opts: { reachable?: boolean } = {}): BridgeClient {
  let reachable = opts.reachable ?? true;
  return {
    name,
    baseUrl: `http://${name}.internal`,
    async federatedSchema(): Promise<Record<string, Schema>> {
      return {};
    },
    async query(_frame: BridgeFrame): Promise<PackEnvelope> {
      return { schemaVersion: '000000000000', data: {}, shapes: {} };
    },
    async mutate(_frame: BridgeFrame): Promise<PackEnvelope> {
      return { schemaVersion: '000000000000', data: {}, shapes: {} };
    },
    async readRow(_ref: EdgeRef): Promise<Row | null> {
      return null;
    },
    isReachable(): boolean {
      return reachable;
    },
    dispose(): void {
      reachable = false;
    }
  };
}

describe('MemoryBridgeRegistry', () => {
  it('register + has + get round-trip', () => {
    const reg = new MemoryBridgeRegistry();
    const cal = mkClient('cal');
    reg.register('cal', cal);
    expect(reg.has('cal')).toBe(true);
    expect(reg.get('cal')).toBe(cal);
    expect(reg.has('missing')).toBe(false);
    expect(reg.get('missing')).toBeUndefined();
  });

  it('unregister removes the entry', () => {
    const reg = new MemoryBridgeRegistry();
    reg.register('cal', mkClient('cal'));
    expect(reg.has('cal')).toBe(true);
    reg.unregister('cal');
    expect(reg.has('cal')).toBe(false);
    expect(reg.get('cal')).toBeUndefined();
  });

  it('registering over an existing alias throws DuplicateBridgeRegistration', () => {
    const reg = new MemoryBridgeRegistry();
    reg.register('cal', mkClient('cal'));
    expect(() => reg.register('cal', mkClient('cal-2'))).toThrowError(DuplicateBridgeRegistration);
  });

  it('isUnreachable delegates to BridgeClient.isReachable', () => {
    const reg = new MemoryBridgeRegistry();
    const downClient = mkClient('down', { reachable: false });
    reg.register('down', downClient);
    expect(reg.isUnreachable('down')).toBe(true);

    const upClient = mkClient('up', { reachable: true });
    reg.register('up', upClient);
    expect(reg.isUnreachable('up')).toBe(false);

    // Unregistered alias → not unreachable (nothing to reach).
    expect(reg.isUnreachable('unknown')).toBe(false);
  });

  it('entries returns every (alias, client) pair', () => {
    const reg = new MemoryBridgeRegistry();
    const cal = mkClient('cal');
    const shop = mkClient('shop');
    reg.register('cal', cal);
    reg.register('shop', shop);
    const entries = reg.entries();
    expect(entries).toHaveLength(2);
    const map = new Map(entries);
    expect(map.get('cal')).toBe(cal);
    expect(map.get('shop')).toBe(shop);
  });

  it('dispose tears down every client and clears the registry', () => {
    const reg = new MemoryBridgeRegistry();
    const cal = mkClient('cal');
    reg.register('cal', cal);
    reg.dispose();
    expect(reg.has('cal')).toBe(false);
    // isReachable flipped false as a side-effect of dispose in our stub.
    expect(cal.isReachable()).toBe(false);
    // Calling dispose twice is safe.
    reg.dispose();
  });
});
