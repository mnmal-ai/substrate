/**
 * §7.1 schema-drift detection. On mismatch, refetch the federated schema once.
 * If the server's reported version still doesn't match our cache after refetch,
 * throw SchemaDriftError — the server has genuinely drifted mid-request.
 *
 * Concurrent verify calls share a single in-flight refetch to avoid refetch
 * stampede when multiple requests hit the mismatch simultaneously.
 */

import { SchemaDriftError } from '../errors.js';

export interface SchemaDriftHandlerOpts {
  refetch: () => Promise<void>;
}

export class SchemaDriftHandler {
  readonly #refetch: () => Promise<void>;
  #cachedVersion: string | null = null;
  #inflightRefetch: Promise<void> | null = null;

  constructor(opts: SchemaDriftHandlerOpts) {
    this.#refetch = opts.refetch;
  }

  setCachedVersion(v: string): void {
    this.#cachedVersion = v;
  }

  getCachedVersion(): string | null {
    return this.#cachedVersion;
  }

  async verify(envelopeVersion: string): Promise<void> {
    if (this.#cachedVersion === envelopeVersion) return;

    if (this.#inflightRefetch === null) {
      this.#inflightRefetch = this.#refetch().finally(() => {
        this.#inflightRefetch = null;
      });
    }
    await this.#inflightRefetch;

    if (this.#cachedVersion !== envelopeVersion) {
      throw new SchemaDriftError(envelopeVersion, this.#cachedVersion ?? '(unset)');
    }
  }
}
