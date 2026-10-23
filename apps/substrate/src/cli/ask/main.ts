import { basename } from 'node:path';
import {
  createClientFromEnv,
  NetworkError,
  type SubstrateClient
} from '@mnmal-ai/substrate-client';
import type { NlOutcome } from '@mnmal-ai/substrate-types';

export interface AskCliOptions {
  write?: (s: string) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetchImpl?: typeof fetch;
}

const USAGE = 'usage: substrate ask [--ns <namespace>] [--project <name>] [--json] <question…>\n';

export async function runAsk(argv: string[], options: AskCliOptions = {}): Promise<number> {
  const write = options.write ?? ((s: string) => process.stdout.write(s));
  const env = options.env ?? process.env;
  let ns =
    env.SUBSTRATE_NAMESPACE !== undefined && env.SUBSTRATE_NAMESPACE !== ''
      ? env.SUBSTRATE_NAMESPACE
      : undefined;
  let project = basename(options.cwd ?? process.cwd());
  let json = false;
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (a === '--json') json = true;
    else if (a === '--ns' || a === '--project') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        write(USAGE);
        return 2;
      }
      if (a === '--ns') ns = v;
      else project = v;
    } else words.push(a);
  }
  if ((env.SUBSTRATE_URL ?? '') === '') {
    write('SUBSTRATE_URL is required (e.g. https://substrate.example.com:3100)\n');
    return 2;
  }
  const question = words.join(' ').trim();
  if (question === '') {
    write(USAGE);
    return 2;
  }
  if (ns === undefined) {
    write('substrate ask: name the namespace with --ns or SUBSTRATE_NAMESPACE\n');
    return 2;
  }

  // A set-but-broken key is a config error, not a stack trace.
  let client: SubstrateClient;
  try {
    ({ client } = createClientFromEnv({
      env,
      allowAnonymous: true,
      ...(options.fetchImpl !== undefined ? { fetch: options.fetchImpl } : {})
    }));
  } catch (err) {
    write(`substrate ask: agent identity: ${messageOf(err)}\n`);
    return 2;
  }
  let result: Awaited<ReturnType<typeof client.nl.askJson>>;
  try {
    result = await client.nl.askJson({ namespace: ns, question, project });
  } catch (err) {
    // Only the message: never the cause chain, which can carry request detail.
    // substrate-nl tags its own 404 (unknown namespace); any other 404 — including the
    // server framework's default JSON "Not Found" — means the route itself is absent.
    if (err instanceof NetworkError && err.status === 404 && err.code !== 'nl_unknown_namespace')
      write('substrate ask: the server has no NL route (is @mnmal-ai/substrate-nl installed?)\n');
    else if (err instanceof NetworkError && err.serverMessage !== undefined)
      write(`substrate ask: ${err.serverMessage}\n`);
    else write(`substrate ask: ${messageOf(err)}\n`);
    return 1;
  }
  const outcome = result.outcome;
  if (json) write(`${JSON.stringify(result, null, 2)}\n`);
  else write(render(outcome));
  if (outcome === null) return 0;
  if (outcome.kind === 'refuse') return 1;
  if (outcome.kind === 'rows' && Array.isArray(outcome.errors) && outcome.errors.length > 0)
    return 1;
  return 0;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function render(o: NlOutcome | null): string {
  if (o === null) return '{}\n';
  switch (o.kind) {
    case 'rows': {
      const key = Object.keys(o.frame)[0] ?? '?';
      // A rejected frame arrives with no `data` key at all; that is not zero rows.
      const rows = Array.isArray(o.data) ? (o.data as Record<string, unknown>[]) : undefined;
      const tail = rows === undefined ? 'rejected' : `${rows.length} rows`;
      const head = `▸ ${key} · ${o.source}${o.handoff !== undefined ? ` (${o.handoff})` : ''} · ${tail}\n`;
      const errs = (o.errors ?? []).map((e) => `  ✗ ${JSON.stringify(e)}\n`).join('');
      const body = (rows ?? [])
        .map(
          (r) =>
            `  ${String(r.shortId ?? r.id ?? '')}  ${String(r.title ?? r.synopsis ?? r.name ?? '')}\n`
        )
        .join('');
      return head + errs + body;
    }
    case 'recall': {
      const errs = (o.errors ?? []).map((e) => `  ✗ ${JSON.stringify(e)}\n`).join('');
      if (!Array.isArray(o.hits)) return `▸ recall · rejected\n${errs}`;
      const hits = o.hits as Record<string, unknown>[];
      return `▸ recall · ${hits.length} hits\n${errs}${hits.map((h) => `  ${String(h.type)} ${String(h.id)}  ${Number(h.score).toFixed(2)}\n`).join('')}`;
    }
    case 'clarify': {
      const opts = Array.isArray(o.options) ? o.options : [];
      return `? ${o.reason}\n${opts.map((x, i) => `  ${i + 1}. ${x.label}\n`).join('')}`;
    }
    case 'refuse':
      return `✗ ${o.reason}\n`;
  }
}
