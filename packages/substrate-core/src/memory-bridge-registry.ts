/**
 * `MemoryBridgeRegistry` — in-process `BridgeRegistry` impl. Spec §5.8.
 *
 * Maps a local namespace alias to a `BridgeClient`. Reachability is delegated
 * to the client — the registry does not run its own timers. Re-registering an
 * alias throws (fail-fast: bridge-alias collisions are bugs).
 */

import type { BridgeClient, BridgeRegistry } from '@mnmal-ai/substrate-types';

export class DuplicateBridgeRegistration extends Error {
  override readonly name = 'DuplicateBridgeRegistration';
  constructor(ns: string) {
    super(`bridge already registered under namespace alias '${ns}'`);
  }
}

export class MemoryBridgeRegistry implements BridgeRegistry {
  readonly #bridges = new Map<string, BridgeClient>();

  register(ns: string, client: BridgeClient): void {
    if (this.#bridges.has(ns)) throw new DuplicateBridgeRegistration(ns);
    this.#bridges.set(ns, client);
  }

  unregister(ns: string): void {
    this.#bridges.delete(ns);
  }

  has(ns: string): boolean {
    return this.#bridges.has(ns);
  }

  get(ns: string): BridgeClient | undefined {
    return this.#bridges.get(ns);
  }

  isUnreachable(ns: string): boolean {
    const client = this.#bridges.get(ns);
    if (client === undefined) return false;
    return !client.isReachable();
  }

  entries(): Array<[string, BridgeClient]> {
    return Array.from(this.#bridges.entries());
  }

  /** Dispose every registered bridge and clear the registry. Idempotent. */
  dispose(): void {
    for (const [, client] of this.#bridges) {
      client.dispose();
    }
    this.#bridges.clear();
  }
}
