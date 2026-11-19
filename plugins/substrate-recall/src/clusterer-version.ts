import { createRequire } from 'node:module';

/**
 * Which clusterer produced a clustering. Recorded in every cluster's
 * provenance, because two backends produce different assignments on
 * identical input — and, decisively, so does the same backend on
 * differently-rounded input.
 *
 * The version is read at runtime from the installed package's manifest
 * (exported as `./package.json`), so it names the clusterer that actually ran.
 */

export const CLUSTERER_BACKEND = 'wasm';
export const CLUSTERER_BACKEND_VERSION: string = (
  createRequire(import.meta.url)('@mnmal-ai/holomap-clusterer/package.json') as {
    version: string;
  }
).version;
