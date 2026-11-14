/**
 * Child entry for a sandboxed `run`: imports the script and hands its default
 * export a ScriptContext whose every call goes to the parent over IPC. The
 * child runs under `--permission` with no fs beyond this file and the script,
 * no network, no child processes and no workers, so the store, reached through
 * the parent, is all a script can touch.
 *
 * Imports node builtins only: any other import would need fs access the
 * sandbox does not grant.
 */

import { pathToFileURL } from 'node:url';

interface Start {
  type: 'start';
  script: string;
  kid: string | null;
  mode: string;
  args: Record<string, unknown>;
}
interface Reply {
  type: 'reply';
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

const send = (m: unknown): void => {
  process.send?.(m);
};
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let seq = 0;

function call(op: string, ...input: unknown[]): Promise<unknown> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: 'call', id, op, input });
  });
}

process.on('message', (m: Start | Reply) => {
  if (m.type === 'reply') {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.ok) p?.resolve(m.value);
    else p?.reject(new Error(m.error));
    return;
  }
  if (m.type === 'start') void start(m);
});

async function start(m: Start): Promise<void> {
  const s = Object.freeze({
    kid: m.kid,
    mode: m.mode,
    args: Object.freeze({ ...m.args }),
    query: (frame: unknown) => call('query', frame),
    queryAll: (key: unknown, frame: unknown) => call('queryAll', key, frame),
    byShortId: (key: unknown, n: unknown, fields?: unknown) => call('byShortId', key, n, fields),
    recall: (input: unknown) => call('recall', input),
    schema: (namespace?: unknown, type?: unknown) => call('schema', namespace, type),
    mutate: (frame: unknown) => call('mutate', frame),
    log: (...args: unknown[]) => {
      void call('log', ...args);
    }
  });
  try {
    const mod = (await import(pathToFileURL(m.script).href)) as { default?: unknown };
    if (typeof mod.default !== 'function') {
      throw new Error('the script must default-export a function (s) => result');
    }
    const result = await (mod.default as (ctx: typeof s) => unknown)(s);
    send({ type: 'done', ok: true, result });
  } catch (err) {
    send({ type: 'done', ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
