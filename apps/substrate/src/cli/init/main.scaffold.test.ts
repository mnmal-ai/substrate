import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runInit } from './main.js';

// Track every temp dir created in this suite so afterAll can sweep them
// regardless of test pass/fail.
const TEMP_DIRS: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-init-test-'));
  TEMP_DIRS.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of TEMP_DIRS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runInit (--yes)', () => {
  it('scaffolds a postgres runtime', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'rt');
    const code = await runInit([
      target,
      '--yes',
      '--store=postgres',
      '--plugins=cortext',
      '--port=3199'
    ]);
    expect(code).toBe(0);
    expect(existsSync(join(target, '.env'))).toBe(true);
    expect(existsSync(join(target, '.env.docker'))).toBe(true);
    expect(existsSync(join(target, 'docker-compose.yml'))).toBe(true);
    expect(existsSync(join(target, 'package.json'))).toBe(true);
    // @mnmal-ai/* is public on npmjs.com, so the scaffold needs no registry config.
    expect(existsSync(join(target, '.npmrc'))).toBe(false);
    expect(existsSync(join(target, 'postgres-init', '01-create-database.sql'))).toBe(true);
    expect(existsSync(join(target, 'README.md'))).toBe(true);
    const env = readFileSync(join(target, '.env'), 'utf8');
    expect(env).toContain('PORT=3199');
    expect(env).toMatch(/SUBSTRATE_DATABASE_URL=postgres:\/\/substrate:[a-f0-9]{32,}@/);
  });

  it('scaffolds a memory runtime (no docker)', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'rt');
    const code = await runInit([target, '--yes', '--store=memory', '--plugins=']);
    expect(code).toBe(0);
    expect(existsSync(join(target, '.env'))).toBe(true);
    expect(existsSync(join(target, 'docker-compose.yml'))).toBe(false);
    expect(existsSync(join(target, '.env.docker'))).toBe(false);
    expect(existsSync(join(target, 'postgres-init'))).toBe(false);
  });

  it('--embedder=ollama writes the recall config the plugin actually reads, and installs it', async () => {
    // The embedder is configured in <runtime>/substrate-recall.config.json, not
    // in .env, which nothing reads for it.
    const dir = makeTempDir();
    const target = join(dir, 'rt');
    const code = await runInit([
      target,
      '--yes',
      '--store=postgres',
      '--plugins=cortext',
      '--embedder=ollama'
    ]);
    expect(code).toBe(0);

    const recall = JSON.parse(readFileSync(join(target, 'substrate-recall.config.json'), 'utf8'));
    expect(recall).toEqual({
      embedder: {
        kind: 'ollama',
        baseUrl: 'http://localhost:11434',
        model: 'bge-m3',
        dimension: 1024
      }
    });
    expect(readFileSync(join(target, '.env'), 'utf8')).not.toMatch(
      /SUBSTRATE_EMBEDDER|SUBSTRATE_OLLAMA/
    );
  });

  it('defaults to minilm in-process: onnx config with an absolute cache dir, and fastembed installed', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'rt');
    const code = await runInit([target, '--yes', '--store=memory', '--plugins=cortext']);
    expect(code).toBe(0);

    const recall = JSON.parse(readFileSync(join(target, 'substrate-recall.config.json'), 'utf8'));
    expect(recall).toEqual({
      embedder: {
        kind: 'onnx',
        model: 'all-MiniLM-L6-v2',
        dimension: 384,
        cacheDir: join(target, 'models')
      }
    });
    const deps = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).dependencies;
    expect(deps.fastembed).toBe('^2.1.1');
  });

  it('--embedder=bge-base writes the 768-dim step-up', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'rt');
    const code = await runInit([target, '--yes', '--store=memory', '--embedder=bge-base']);
    expect(code).toBe(0);
    const recall = JSON.parse(readFileSync(join(target, 'substrate-recall.config.json'), 'utf8'));
    expect(recall.embedder).toMatchObject({
      kind: 'onnx',
      model: 'bge-base-en-v1.5',
      dimension: 768
    });
  });

  it('--embedder=ollama does not install fastembed', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'rt');
    const code = await runInit([target, '--yes', '--store=memory', '--embedder=ollama']);
    expect(code).toBe(0);
    const deps = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).dependencies;
    expect(deps.fastembed).toBeUndefined();
  });

  it('--embedder=none writes no recall config and installs neither recall nor fastembed', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'rt');
    const code = await runInit([
      target,
      '--yes',
      '--store=memory',
      '--plugins=',
      '--embedder=none'
    ]);
    expect(code).toBe(0);
    expect(existsSync(join(target, 'substrate-recall.config.json'))).toBe(false);
    const deps = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).dependencies;
    expect(deps.fastembed).toBeUndefined();
  });

  it('rejects an unknown --embedder', async () => {
    const dir = makeTempDir();
    const code = await runInit([join(dir, 'rt'), '--yes', '--embedder=nomic']);
    expect(code).toBe(1);
  });

  it('refuses pre-existing target without --force', async () => {
    const dir = makeTempDir();
    const code = await runInit([dir, '--yes', '--store=memory']);
    expect(code).toBe(1);
  });

  it('accepts pre-existing target with --force', async () => {
    const dir = makeTempDir();
    const code = await runInit([dir, '--yes', '--force', '--store=memory']);
    expect(code).toBe(0);
  });

  it('writes both env files owner-only, also when --force overwrites a 0644 one', async () => {
    const target = makeTempDir();
    writeFileSync(join(target, '.env'), 'old');
    chmodSync(join(target, '.env'), 0o644);
    const code = await runInit([target, '--yes', '--force', '--store=postgres']);
    expect(code).toBe(0);
    expect(statSync(join(target, '.env')).mode & 0o777).toBe(0o600);
    expect(statSync(join(target, '.env.docker')).mode & 0o777).toBe(0o600);
  });

  it('--force refuses a runtime whose postgres cluster already exists', async () => {
    const target = makeTempDir();
    mkdirSync(join(target, 'data', 'pg'), { recursive: true });
    writeFileSync(join(target, 'data', 'pg', 'PG_VERSION'), '17');
    writeFileSync(join(target, '.env'), 'keep');
    const code = await runInit([target, '--yes', '--force', '--store=postgres']);
    expect(code).toBe(1);
    expect(readFileSync(join(target, '.env'), 'utf8')).toBe('keep');
  });

  it('postgres-mode banner uses single pnpm install + ./node_modules/.bin/substrate serve', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'rt');
    const stdout: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // stdout monkey-patch is the cleanest way to capture banner contents
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runInit([target, '--yes', '--store=postgres', '--plugins=cortext']);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = origWrite;
    }
    const banner = stdout.join('');
    expect(banner).toContain('pnpm install');
    expect(banner).not.toContain('--ignore-workspace');
    expect(banner).toContain('./node_modules/.bin/substrate serve');
    // Postgres banner says backups are not configured.
    expect(banner).toContain('No backups are configured');
  });

  it('memory-mode banner uses pnpm install + ./node_modules/.bin/substrate serve', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'rt');
    const stdout: string[] = [];
    // stdout monkey-patch is the cleanest way to capture banner contents
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runInit([target, '--yes', '--store=memory', '--plugins=', '--port=3198']);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = origWrite;
    }
    const banner = stdout.join('');
    expect(banner).toContain('source .env');
    expect(banner).toContain('pnpm install');
    expect(banner).toContain('./node_modules/.bin/substrate serve');
  });

  it('writes pnpm-workspace.yaml to the runtime root', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'rt');
    const code = await runInit([target, '--yes', '--store=postgres', '--plugins=cortext']);
    expect(code).toBe(0);
    expect(existsSync(join(target, 'pnpm-workspace.yaml'))).toBe(true);
    const ws = readFileSync(join(target, 'pnpm-workspace.yaml'), 'utf8');
    expect(ws).toContain('packages: []');
  });

  it('derives compose project name from target dir basename', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'my-labs-instance');
    const code = await runInit([target, '--yes', '--store=postgres', '--plugins=cortext']);
    expect(code).toBe(0);
    const compose = readFileSync(join(target, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('name: substrate-my-labs-instance');
  });

  it('normalizes basename for compose name (lowercase + hyphens)', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'Labs_Instance.01');
    const code = await runInit([target, '--yes', '--store=postgres', '--plugins=cortext']);
    expect(code).toBe(0);
    const compose = readFileSync(join(target, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('name: substrate-labs-instance-01');
  });

  it('honors --pg-port flag', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'rt');
    const code = await runInit([
      target,
      '--yes',
      '--store=postgres',
      '--plugins=cortext',
      '--pg-port=5443'
    ]);
    expect(code).toBe(0);
    const compose = readFileSync(join(target, 'docker-compose.yml'), 'utf8');
    const env = readFileSync(join(target, '.env'), 'utf8');
    expect(compose).toContain('127.0.0.1:5443:5432');
    expect(env).toContain('@127.0.0.1:5443/substrate_prod');
  });

  it('honors --tls + --tls-cert-path + --tls-key-path', async () => {
    const dir = makeTempDir();
    const target = join(dir, 'rt');
    const code = await runInit([
      target,
      '--yes',
      '--store=memory',
      '--plugins=',
      '--tls',
      '--tls-cert-path=/etc/ssl/cert.pem',
      '--tls-key-path=/etc/ssl/key.pem'
    ]);
    expect(code).toBe(0);
    const env = readFileSync(join(target, '.env'), 'utf8');
    expect(env).toContain('SUBSTRATE_TLS_CERT_PATH=/etc/ssl/cert.pem');
    expect(env).toContain('SUBSTRATE_TLS_KEY_PATH=/etc/ssl/key.pem');
  });
});
