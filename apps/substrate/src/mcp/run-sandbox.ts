/**
 * Runs agent-supplied script text in a sandboxed child process (Decision #642).
 *
 * The child runs under Node's permission model: it may read only its runner and
 * the script, and has no network, child processes, workers or environment. On
 * Linux with bubblewrap it also starts in namespaces of its own (`osJail`). Each
 * ScriptContext call it makes is relayed to a real one from `runScript`, so the
 * read / dry-run / write modes, `maxWrites`, signing and the report are exactly
 * the CLI's.
 */

import { fork, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runScript,
  type ScriptContext,
  type ScriptMode,
  type ScriptReport,
  type SubstrateClient
} from '@mnmal-ai/substrate-client';

export const DEFAULT_RUN_TIMEOUT_MS = 60_000;
/** Heap ceiling for one script's child, in MiB. */
const CHILD_HEAP_MB = 256;

const BWRAP_PATHS = ['/usr/bin/bwrap', '/bin/bwrap'];
/**
 * Fresh pid, network, ipc and uts namespaces over a read-only view of the
 * filesystem: the child sees no process but its own, has no network device and
 * can write nowhere, whatever its JavaScript reaches.
 */
const JAIL_FLAGS = [
  '--unshare-pid',
  '--unshare-net',
  '--unshare-ipc',
  '--unshare-uts',
  '--die-with-parent',
  '--new-session',
  '--ro-bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--proc',
  '/proc'
];
let jail: string | null | undefined;

/**
 * The bubblewrap binary, when this host can start a process in fresh
 * namespaces with it, else null: not Linux, not installed, or unprivileged
 * user namespaces are off. Probed once. The permission model applies either way.
 */
export function osJail(): string | null {
  if (jail !== undefined) return jail;
  jail = null;
  if (process.platform !== 'linux') return jail;
  for (const path of BWRAP_PATHS) {
    if (!existsSync(path)) continue;
    const probe = spawnSync(path, [...JAIL_FLAGS, '--', process.execPath, '-e', ''], {
      env: {},
      stdio: 'ignore',
      timeout: 5000
    });
    if (probe.status === 0) {
      jail = path;
      break;
    }
  }
  return jail;
}

export interface SandboxRunOptions {
  client: SubstrateClient;
  kid: string | null;
  mode?: ScriptMode;
  args?: Record<string, unknown>;
  maxWrites?: number;
  /** Kill the child and fail the run past this. */
  timeoutMs?: number;
  /** Kill the child and fail the run when this fires. */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

type Op = 'query' | 'queryAll' | 'byShortId' | 'recall' | 'schema' | 'mutate' | 'log';
const OPS: ReadonlySet<string> = new Set<Op>([
  'query',
  'queryAll',
  'byShortId',
  'recall',
  'schema',
  'mutate',
  'log'
]);

/** The runner beside this module: `.js` in the built package, `.ts` when run from source. */
function runnerPath(): string {
  const js = fileURLToPath(new URL('./script-runner.js', import.meta.url));
  return existsSync(js) ? js : fileURLToPath(new URL('./script-runner.ts', import.meta.url));
}

export async function runSandboxed(source: string, opts: SandboxRunOptions): Promise<ScriptReport> {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-run-'));
  const script = join(dir, 'script.mts');
  writeFileSync(script, source);
  const runner = runnerPath();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  try {
    return await runScript((s) => inChild(s, runner, script, timeoutMs, opts.signal), {
      client: opts.client,
      kid: opts.kid,
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
      ...(opts.args !== undefined ? { args: opts.args } : {}),
      ...(opts.maxWrites !== undefined ? { maxWrites: opts.maxWrites } : {}),
      ...(opts.log !== undefined ? { log: opts.log } : {})
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function inChild(
  s: ScriptContext,
  runner: string,
  script: string,
  timeoutMs: number,
  signal: AbortSignal | undefined
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const nodeFlags = [
      '--permission',
      `--allow-fs-read=${runner}`,
      `--allow-fs-read=${script}`,
      `--max-old-space-size=${CHILD_HEAP_MB}`
    ];
    const bwrap = osJail();
    const child = fork(runner, [], {
      ...(bwrap === null
        ? { execArgv: nodeFlags }
        : { execPath: bwrap, execArgv: [...JAIL_FLAGS, '--', process.execPath, ...nodeFlags] }),
      env: {},
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      // Structured clone, so a bigint (int64) or a Date survives the hop.
      serialization: 'advanced'
    });
    let settled = false;
    const onAbort = (): void => finish(new Error('script cancelled by the caller'));
    const finish = (err: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.kill('SIGKILL');
      if (err !== null) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`script timed out after ${timeoutMs} ms`)),
      timeoutMs
    );
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => finish(err));
    child.on('exit', (code, signal) =>
      finish(new Error(`script process exited (${signal ?? `code ${code}`}) before finishing`))
    );
    child.on(
      'message',
      (m: {
        type: string;
        id?: number;
        op?: string;
        input?: unknown[];
        ok?: boolean;
        result?: unknown;
        error?: string;
      }) => {
        if (m.type === 'done') {
          if (m.ok === true) finish(null, m.result);
          else finish(new Error(m.error ?? 'script failed'));
          return;
        }
        if (m.type !== 'call' || m.id === undefined) return;
        const id = m.id;
        const reply = (r: { ok: boolean; value?: unknown; error?: string }): void => {
          if (!settled) child.send({ type: 'reply', id, ...r });
        };
        if (m.op === undefined || !OPS.has(m.op)) {
          reply({ ok: false, error: `unknown context call '${String(m.op)}'` });
          return;
        }
        const fn = s[m.op as Op] as (...a: unknown[]) => unknown;
        Promise.resolve()
          .then(() => fn(...(m.input ?? [])))
          .then(
            (value) => reply({ ok: true, value }),
            (err: unknown) =>
              reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
          );
      }
    );
    child.send({ type: 'start', script, kid: s.kid, mode: s.mode, args: { ...s.args } });
  });
}
