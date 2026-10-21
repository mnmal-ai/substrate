/**
 * The substrate core may define the INTERFACE for a capability that needs an
 * external service or a model, but must never ship a DEFAULT IMPLEMENTATION of
 * one. The rule is enforced rather than the individual packages:
 *
 *   - `substrate-nl`       needs an LLM        => plugin, entirely
 *   - `substrate-embedder` interface is core   => backends are undeclared and
 *                                             imported lazily
 *   - `substrate-recall`   recall IS substrate => stays core; only its embedder
 *                                             backend is pluggable
 *
 * A test because the failure is invisible: a provider SDK in a core package
 * breaks no build and shows up only as install weight for consumers.
 *
 * Scope: workspace packages reachable from the umbrella's PRODUCTION
 * dependencies. devDependencies are not walked — they do not travel to
 * consumers.
 *
 * peerDependencies ARE walked, and a model backend is banned there outright
 * rather than allowed with `peerDependenciesMeta.optional`: GitHub Packages'
 * packument omits `peerDependenciesMeta`, so pnpm sees a REQUIRED peer and
 * auto-installs it. Undeclared plus a deferred import plus an actionable error
 * is the only shape that survives this registry.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = new URL('../../..', import.meta.url).pathname;
const WORKSPACE_GROUPS = ['packages', 'plugins', 'apps'];

/**
 * Packages that carry a model or a hosted-inference client. The list IS the
 * test; extend it when a new one appears rather than re-arguing the case.
 */
const MODEL_BACKENDS = new Set([
  '@anthropic-ai/sdk',
  'openai',
  '@google/generative-ai',
  'cohere-ai',
  // Embedding backends. `fastembed` drags onnxruntime-node (520MB); a
  // dependency anywhere in the core closure would put it on every consumer.
  'fastembed',
  'onnxruntime-node'
]);

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  substrate?: { tier?: string };
}

function readManifest(dir: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

/** Every workspace package, indexed by the name other manifests refer to it by. */
function indexWorkspace(): Map<string, Manifest> {
  const byName = new Map<string, Manifest>();
  for (const group of WORKSPACE_GROUPS) {
    for (const entry of readdirSync(join(REPO_ROOT, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = readManifest(join(REPO_ROOT, group, entry.name));
      if (manifest?.name !== undefined) byName.set(manifest.name, manifest);
    }
  }
  return byName;
}

describe('the core ships no default implementation of a model-backed capability', () => {
  const workspace = indexWorkspace();

  it('indexed the workspace', () => {
    expect(workspace.has('@mnmal-ai/substrate')).toBe(true);
  });

  it('no package in the umbrella production closure declares a model backend', () => {
    const seen = new Set<string>();
    const offenders: string[] = [];

    const walk = (name: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      const manifest = workspace.get(name);
      // Not a workspace package — a published third-party dep, not ours to police.
      if (manifest === undefined) return;
      for (const dep of Object.keys(manifest.dependencies ?? {})) {
        if (MODEL_BACKENDS.has(dep)) offenders.push(`${name} -> ${dep} (dependencies)`);
        walk(dep);
      }
      // Not walked for transitives — a peer is the consumer's to resolve — but
      // a model backend named here is auto-installed by pnpm's default
      // auto-install-peers. See the header.
      for (const dep of Object.keys(manifest.peerDependencies ?? {})) {
        if (MODEL_BACKENDS.has(dep)) offenders.push(`${name} -> ${dep} (peerDependencies)`);
      }
    };
    walk('@mnmal-ai/substrate');

    expect(
      offenders.sort(),
      'a model backend reached the umbrella. The core may define the interface for a ' +
        'model-backed capability but must not ship an implementation. Do NOT reach for ' +
        'peerDependenciesMeta.optional — GitHub Packages drops it from the packument, so ' +
        'pnpm auto-installs the backend anyway. Leave it undeclared, defer the import, ' +
        'and throw an error naming the install command.'
    ).toEqual([]);
  });

  it('substrate-nl is a kernel plugin, not a core package', () => {
    const manifest = readManifest(join(REPO_ROOT, 'plugins', 'substrate-nl'));
    expect(manifest?.name).toBe('@mnmal-ai/substrate-nl');
    // Substrate tier: it claims a kernel route and owns no namespace.
    expect(manifest?.substrate?.tier).toBe('kernel');
  });
});
