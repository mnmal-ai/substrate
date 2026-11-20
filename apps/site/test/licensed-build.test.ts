import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest exports BASE_URL, MODE and friends, which a nested astro build would read as its own.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(BASE_URL|MODE|DEV|PROD|SSR|VITEST.*)$/.test(k))
);
const root = new URL('../', import.meta.url).pathname;

const licensedDir = join(root, 'public', 'fonts', 'licensed');

describe('licensed build', () => {
  // A machine that already has the directory may hold the real fonts; the test never touches it.
  it.runIf(!existsSync(licensedDir))(
    'emits the Berkeley Mono face and preload when both files are present',
    () => {
      const outDir = mkdtempSync(join(tmpdir(), 'site-licensed-'));
      mkdirSync(licensedDir, { recursive: true });
      try {
        for (const f of ['Regular', 'Bold']) {
          writeFileSync(join(licensedDir, `BerkeleyMono-${f}.woff2`), 'dummy');
        }
        execFileSync('pnpm', ['exec', 'astro', 'build', '--outDir', outDir], {
          cwd: root,
          env,
          stdio: 'pipe'
        });
        const html = readFileSync(join(outDir, 'index.html'), 'utf8');
        const css = readdirSync(outDir, { recursive: true, encoding: 'utf8' })
          .filter((f) => f.endsWith('.css'))
          .map((f) => readFileSync(join(outDir, f), 'utf8'))
          .join('\n');
        const all = html + css;
        for (const f of ['Regular', 'Bold']) {
          const url = `/substrate/fonts/licensed/BerkeleyMono-${f}.woff2`;
          expect(all).toContain(`url(${url})`);
          expect(html).toContain(`<link rel="preload" href="${url}"`);
        }
        expect(all).toContain("font-family:'Berkeley Mono Site'");
        expect(all).not.toMatch(/data:(font|application\/font)/);
      } finally {
        rmSync(licensedDir, { recursive: true, force: true });
        rmSync(outDir, { recursive: true, force: true });
      }
    }
  );
});
