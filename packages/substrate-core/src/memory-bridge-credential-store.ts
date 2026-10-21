/**
 * Map-backed {@link BridgeCredentialStore}. Sibling of
 * `MemoryBridgeRegistry` — the registry answers "is this namespace bridged",
 * this answers "may we bridge to this coordinator at all".
 */

import type { BridgeCredential, BridgeCredentialStore } from '@mnmal-ai/substrate-types';

export class MemoryBridgeCredentialStore implements BridgeCredentialStore {
  readonly #creds = new Map<string, BridgeCredential>();

  constructor(entries: Record<string, BridgeCredential> = {}) {
    for (const [name, cred] of Object.entries(entries)) this.#creds.set(name, cred);
  }

  get(bridgeName: string): BridgeCredential | undefined {
    return this.#creds.get(bridgeName);
  }

  set(bridgeName: string, cred: BridgeCredential): void {
    this.#creds.set(bridgeName, cred);
  }
}
