import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createClientFromEnv,
  DEFAULT_MAX_WRITES,
  runScript,
  type ScriptContext,
  type ScriptMode,
  type SubstrateClient
} from '@mnmal-ai/substrate-client';

export interface RunCliOptions {
  write?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const USAGE =
  'usage: substrate run <script.mts> [--dry-run | --write] [--max-writes <n>] [--out <file>]\n';

/**
 * Runs a script's default export against a signed, guarded client and prints
 * one JSON report: the script's return value, every mutation, warnings, stats.
 */
export async function runRun(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const write = options.write ?? ((s: string) => process.stdout.write(s));
  let script: string | undefined;
  let mode: ScriptMode = 'read';
  let maxWrites = DEFAULT_MAX_WRITES;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--dry-run' || a === '--write') {
      const next: ScriptMode = a === '--write' ? 'write' : 'dry-run';
      if (mode !== 'read' && mode !== next) {
        write('substrate run: --dry-run and --write are exclusive\n');
        return 2;
      }
      mode = next;
    } else if (a === '--max-writes' || a === '--out') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        write(USAGE);
        return 2;
      }
      if (a === '--out') out = v;
      else {
        maxWrites = Number(v);
        if (!Number.isInteger(maxWrites) || maxWrites < 0) {
          write('substrate run: --max-writes takes a non-negative integer\n');
          return 2;
        }
      }
    } else if (script === undefined && !a.startsWith('--')) script = a;
    else {
      write(USAGE);
      return 2;
    }
  }
  if (script === undefined) {
    write(USAGE);
    return 2;
  }

  let entry: unknown;
  try {
    entry = ((await import(pathToFileURL(resolve(script)).href)) as { default?: unknown }).default;
  } catch (err) {
    write(`substrate run: cannot load ${script}: ${messageOf(err)}\n`);
    return 2;
  }
  if (typeof entry !== 'function') {
    write(`substrate run: ${script} must default-export a function (s) => result\n`);
    return 2;
  }

  let client: SubstrateClient;
  let kid: string | null;
  try {
    ({ client, kid } = createClientFromEnv({
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.fetchImpl !== undefined ? { fetch: options.fetchImpl } : {})
    }));
  } catch (err) {
    write(`substrate run: agent identity: ${messageOf(err)}\n`);
    return 2;
  }

  const report = await runScript(entry as (s: ScriptContext) => unknown, {
    client,
    kid,
    mode,
    maxWrites
  });
  await client.close();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (out !== undefined) {
    writeFileSync(out, json);
    write(
      `${report.ok ? 'ok' : `failed: ${report.error}`} · ${report.mutations.length} mutation(s) · ${report.warnings.length} warning(s) · report in ${out}\n`
    );
  } else write(json);
  return report.ok ? 0 : 1;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
