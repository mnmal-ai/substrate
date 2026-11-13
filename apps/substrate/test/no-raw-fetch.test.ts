/**
 * Every call to a Substrate server goes through `SubstrateClient` or
 * `substrateFetch`, so the transport (HTTP/2 in Node and Bun) is chosen in one
 * place. This fails on raw network or streaming code anywhere else in the
 * shipped sources. Comments are ignored.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = new URL('../../..', import.meta.url).pathname;

const RAW: Array<[string, RegExp]> = [
  ['bare fetch(', /(?<![\w.#$])fetch\s*\(/],
  ['window/self.fetch', /\b(?:window|self)\.fetch\b/],
  ['globalThis.fetch', /globalThis\.fetch\b/],
  ['fetch as a default', /(?:\?\?|[^=!<>]=)\s*fetch\b/],
  ["from 'ws'", /from ['"]ws['"]/],
  ['new WebSocket', /new WebSocket\(/],
  ['EventSource', /new EventSource\(/],
  ['@fastify/websocket', /['"]@fastify\/websocket['"]/],
  ['text/event-stream', /text\/event-stream/]
];

/** Files allowed a match, and why. Task 8 entries go when WS and SSE are retired. */
const ALLOWED: Record<string, string> = {
  'packages/substrate-embedder/src/ollama.ts': 'calls Ollama, not Substrate',
  'plugins/substrate-nl/src/judge/ollama.ts': 'calls Ollama, not Substrate',
  'plugins/substrate-recall/src/row-visibility.ts': 'a parameter named fetch',
  'plugins/substrate-recall/src/pg-embeddings-store.ts': 'a local function named fetch',
  'packages/substrate-compose/src/routes/sse-frame.ts': 'Task 8',
  'packages/substrate-server-fastify/src/fastify-server.ts': 'Task 8',
  'plugins/substrate-nl/src/ask/encode.ts': 'Task 8',
  'plugins/substrate-nl/src/routes.ts': 'Task 8'
};

function sources(): string[] {
  const out = execFileSync('git', ['ls-files', 'apps', 'packages', 'plugins'], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
  return out
    .split('\n')
    .filter(
      (f) =>
        f.endsWith('.ts') &&
        !f.endsWith('.d.ts') &&
        !f.endsWith('.test.ts') &&
        !f.endsWith('.config.ts') &&
        !/(^|\/)(test|__tests__|dist)\//.test(f) &&
        !f.startsWith('packages/substrate-client/src/transport/')
    );
}

/**
 * The source with block comments and whole-line `//` comments blanked, so prose
 * naming an API is not a call. Trailing comments stay: stripping them needs a
 * tokenizer, and a false alarm is safer than a hidden call.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('no raw transport outside substrate-client', () => {
  it('routes every caller through the seam', () => {
    const offenders: string[] = [];
    for (const file of sources()) {
      if (file in ALLOWED) continue;
      const body = code(readFileSync(join(REPO_ROOT, file), 'utf8'));
      for (const [label, re] of RAW) if (re.test(body)) offenders.push(`${file}: ${label}`);
    }
    expect(offenders).toEqual([]);
  });

  it('allowlists only files that still match', () => {
    const stale = Object.keys(ALLOWED).filter((file) => {
      let body: string;
      try {
        body = code(readFileSync(join(REPO_ROOT, file), 'utf8'));
      } catch {
        return true;
      }
      return !RAW.some(([, re]) => re.test(body));
    });
    expect(stale).toEqual([]);
  });
});
