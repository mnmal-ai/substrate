import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { surfaces } from '../src/data/surfaces.ts';

const root = new URL('../../../', import.meta.url).pathname;
const NPM = 'https://www.npmjs.com/package/';
// The one link outside this repo and npm: cortext lives in synoptic.
const ALLOWED = ['https://github.com/mnmal-ai/synoptic'];

// Every workspace package that publishes, by name. A private one has no npm page.
const published = new Set(
  ['apps', 'packages', 'plugins'].flatMap((dir) =>
    readdirSync(join(root, dir))
      .map((d) => join(root, dir, d, 'package.json'))
      .filter(existsSync)
      .map((f) => JSON.parse(readFileSync(f, 'utf8')) as { name: string; private?: boolean })
      .filter((p) => p.private !== true)
      .map((p) => p.name)
  )
);

describe('surfaces', () => {
  it('links only to things that exist', () => {
    expect(surfaces.length).toBeGreaterThan(0);
    for (const { name, href } of surfaces) {
      if (href.startsWith(NPM)) {
        expect(published.has(href.slice(NPM.length)), name).toBe(true);
      } else if (/^[a-z]+:/.test(href)) {
        expect(ALLOWED, name).toContain(href);
      } else {
        expect(existsSync(join(root, href)), `${name}: ${href}`).toBe(true);
      }
    }
  });
});
