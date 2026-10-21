/**
 * Which clusterer produced a clustering. Recorded in every cluster's
 * provenance, because two backends produce different assignments on
 * identical input — and, decisively, so does the same backend on
 * differently-rounded input.
 *
 * The version is a hand-maintained constant rather than a read of the
 * dependency's package.json, because `@mnmal-ai/holomap-clusterer` exports
 * only `"."` — there is no `./package.json` subpath to require. Drift is
 * prevented by `test/clusterer-version.test.ts`, which reads the installed
 * package directly and fails if this constant disagrees.
 */

export const CLUSTERER_BACKEND = 'wasm';
export const CLUSTERER_BACKEND_VERSION = '0.2.1';
