import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// `substrate mcp` never settles and ends when the host closes stdin and the
// loop drains. Behind a top-level await that drain exits 13 with "Detected
// unsettled top-level await" (checked by hand against dist: `: | substrate mcp`).
it('the substrate bin does not top-level-await runCli', () => {
  const src = readFileSync(new URL('../src/bin/substrate.ts', import.meta.url), 'utf8');
  expect(src).not.toMatch(/^(?:const|let)?[^/\n]*\bawait\b/m);
});
