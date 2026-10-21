import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const BIN = join(import.meta.dirname, '..', 'bin', 'toolchain-check.mjs');
const fleet = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'toolchain.json'), 'utf8'));
const checkout = fleet.actions['actions/checkout'];

/** A throwaway repo; every file is optional, as in real repos. */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'toolchain-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}
const run = (dir: string, ...flags: string[]) =>
  spawnSync(process.execPath, [BIN, '--root', dir, '--json', ...flags], { encoding: 'utf8' });

const aligned = () =>
  repo({
    'package.json': JSON.stringify({
      engines: { node: fleet.node.engines },
      packageManager: `pnpm@${fleet.pnpm}`
    }),
    'pnpm-workspace.yaml': `catalog:\n  vitest: "${fleet.catalog.vitest}"\n  left-pad: "^1.0.0"\n`,
    '.github/workflows/ci.yml': `steps:\n  - uses: actions/checkout@${checkout.sha}  # ${checkout.version}\n`
  });

describe('substrate-toolchain-check', () => {
  it('passes an aligned repo, ignoring packages the fleet does not track', () => {
    const r = run(aligned(), '--strict');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.aligned).toBe(true);
    expect(out.rows.map((x: { item: string }) => x.item)).not.toContain('catalog left-pad');
  });

  it('reports drift, and fails only with --strict', () => {
    const dir = repo({
      'package.json': JSON.stringify({ engines: { node: '>=22' }, packageManager: 'pnpm@11.0.0' }),
      'pnpm-workspace.yaml': 'catalog:\n  vitest: "^4.0.0"\n'
    });
    expect(run(dir).status).toBe(0);
    const strict = run(dir, '--strict');
    expect(strict.status).toBe(1);
    const drift = JSON.parse(strict.stdout).rows.filter((x: { ok: boolean }) => !x.ok);
    expect(drift.map((x: { item: string }) => x.item).sort()).toEqual([
      'catalog vitest',
      'engines.node',
      'packageManager pnpm'
    ]);
  });

  it('checks a repo with no package.json on its workflow pins alone', () => {
    const dir = repo({
      '.github/workflows/ci.yml':
        'steps:\n  - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10  # v6.0.3\n'
    });
    const out = JSON.parse(run(dir).stdout);
    expect(out.rows).toEqual([
      expect.objectContaining({ item: 'action actions/checkout (ci.yml)', ok: false })
    ]);
  });

  it('--fix rewrites drift in place, keeps formatting, and leaves the repo aligned', () => {
    const dir = repo({
      'package.json': `{\n  "name": "x",\n  "engines": { "node": ">=22" },\n  "packageManager": "pnpm@11.0.0"\n}\n`,
      'mise.toml': '[tools]\nnode = "latest"\npnpm = "11.0.0"\n',
      'pnpm-workspace.yaml': 'catalog:\n  vitest: "^4.0.0" # pinned\n  left-pad: "^1.0.0"\n',
      '.github/workflows/ci.yml':
        'steps:\n  - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10  # v6.0.3\n'
    });
    const r = run(dir, '--fix', '--strict');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).fixed.sort()).toEqual([
      '.github/workflows/ci.yml',
      'mise.toml',
      'package.json',
      'pnpm-workspace.yaml'
    ]);
    const ws = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8');
    expect(ws).toBe(
      `catalog:\n  vitest: "${fleet.catalog.vitest}" # pinned\n  left-pad: "^1.0.0"\n`
    );
    expect(readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8')).toContain(
      `actions/checkout@${checkout.sha}  # ${checkout.version}`
    );
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toMatchObject({
      engines: { node: fleet.node.engines },
      packageManager: `pnpm@${fleet.pnpm}`
    });
  });

  it('--fix never adds a field the repo does not have', () => {
    const dir = repo({ 'package.json': '{ "name": "x" }\n' });
    run(dir, '--fix');
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe('{ "name": "x" }\n');
  });
});
