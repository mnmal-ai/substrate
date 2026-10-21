import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import pkg from '../../../package.json' with { type: 'json' };
import { type InitConfig, parseArgs } from './config.js';
import {
  dockerComposeTemplate,
  envBinaryTemplate,
  envDockerTemplate,
  pgInitSqlTemplate,
  pnpmWorkspaceTemplate,
  readmeTemplate,
  recallConfigTemplate,
  runtimePackageJsonTemplate,
  type TemplateContext
} from './templates.js';

function normalizeComposeName(targetDir: string): string {
  const base = basename(targetDir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `substrate-${base || 'runtime'}`;
}

/** Both env files carry the postgres password. chmod too: `mode` is ignored when --force overwrites. */
function writeSecret(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export async function runInit(argv: string[]): Promise<number> {
  let config: InitConfig;
  try {
    config = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`substrate init: ${(err as Error).message}\n`);
    return 1;
  }

  if (!config.yes) {
    try {
      // Lazy-load the REPL module so the --yes path doesn't pay for inquirer's import cost.
      const { runRepl } = await import('./repl.js');
      const resolved = await runRepl(config);
      config = resolved;
    } catch (err) {
      // @inquirer/prompts throws this exact message on Ctrl-C / SIGINT.
      if ((err as Error).message?.includes('User force closed')) return 130;
      throw err;
    }
  }
  if (config.targetDir === undefined) {
    process.stderr.write('substrate init: --yes requires a target directory positional arg\n');
    return 1;
  }

  const target = resolve(config.targetDir);
  if (existsSync(target) && !config.force) {
    process.stderr.write(
      `substrate init: ${target} already exists — pass --force to scaffold anyway\n`
    );
    return 1;
  }
  // A new random password in .env cannot log in to a cluster initialised with the old one.
  const pgData = join(target, 'data', 'pg');
  if (existsSync(pgData) && readdirSync(pgData).length > 0) {
    process.stderr.write(
      `substrate init: ${pgData} already holds a postgres cluster — refusing to overwrite its credentials. Remove it first to start fresh.\n`
    );
    return 1;
  }
  mkdirSync(target, { recursive: true });

  const substrateVersion =
    typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0';

  const ctx: TemplateContext = {
    store: config.store ?? 'postgres',
    port: config.port ?? 3100,
    pgPort: config.pgPort ?? 5433,
    plugins: [...(config.plugins ?? [])],
    embedder: config.embedder ?? 'minilm',
    substrateUrl:
      config.substrateUrl ?? `${config.tls ? 'https' : 'http'}://localhost:${config.port ?? 3100}`,
    tls: config.tls,
    tlsCertPath: config.tlsCertPath,
    tlsKeyPath: config.tlsKeyPath,
    pgPassword: randomBytes(32).toString('hex'),
    dbName: 'substrate_prod',
    composeName: normalizeComposeName(target),
    substrateVersion
  };

  writeSecret(join(target, '.env'), envBinaryTemplate(ctx));
  writeFileSync(join(target, 'README.md'), readmeTemplate(ctx));
  writeFileSync(join(target, 'pnpm-workspace.yaml'), pnpmWorkspaceTemplate());
  writeFileSync(join(target, 'package.json'), runtimePackageJsonTemplate(ctx));
  const recallConfig = recallConfigTemplate(ctx.embedder, target);
  if (recallConfig !== null) {
    writeFileSync(join(target, 'substrate-recall.config.json'), recallConfig);
  }

  if (ctx.store === 'postgres') {
    writeSecret(join(target, '.env.docker'), envDockerTemplate(ctx));
    writeFileSync(join(target, 'docker-compose.yml'), dockerComposeTemplate(ctx));
    mkdirSync(join(target, 'postgres-init'), { recursive: true });
    writeFileSync(join(target, 'postgres-init', '01-create-database.sql'), pgInitSqlTemplate(ctx));
    mkdirSync(join(target, 'data', 'pg'), { recursive: true });
  }

  process.stdout.write(`substrate init: wrote runtime to ${target}\n`);
  if (ctx.store === 'postgres') {
    process.stdout.write('\nNext steps:\n');
    process.stdout.write(`  cd ${config.targetDir}\n`);
    process.stdout.write('  docker compose --env-file .env.docker up -d\n');
    process.stdout.write('  pnpm install\n');
    process.stdout.write(
      '  set -a && source .env && set +a && ./node_modules/.bin/substrate serve\n'
    );
    // The scaffold ships with the backup sidecar commented out, so say so.
    process.stdout.write('  No backups are configured — see README "Backups" to opt in.\n');
  } else {
    process.stdout.write('\nNext steps:\n');
    process.stdout.write(`  cd ${config.targetDir}\n`);
    process.stdout.write('  pnpm install\n');
    process.stdout.write(
      '  set -a && source .env && set +a && ./node_modules/.bin/substrate serve\n'
    );
  }
  return 0;
}
