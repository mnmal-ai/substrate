/**
 * `substrate normalise-vocab <namespace> <Type> <field> [--apply] [--reject a,b] [--json]`
 *
 * Rewrites stored aliases of a governed vocabulary field to their canonical
 * value, through the admin route `POST /substrate/v1/_system/normalise-vocab`. Dry
 * run unless `--apply`. Values no alias explains must be listed in `--reject`
 * (left as they are) before an apply goes ahead. Row metadata is preserved.
 *
 * Env: SUBSTRATE_URL, SUBSTRATE_ADMIN_TOKEN (admin Bearer token). Exit 0 on success,
 * 1 when the server refuses unmapped values, 2 on usage or transport errors.
 */

import { noRedirectFetch, tokenAudience } from '@mnmal-ai/substrate-client';

export interface NormaliseVocabOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  write?: (text: string) => void;
}

interface Summary {
  applied?: boolean;
  plan?: Array<{ from: string; to: string; count: number }>;
  unmapped?: Array<{ value: string; count: number }>;
  migrated?: Array<{ from: string; to: string; count: number }>;
  stranded?: Array<{ value: string; count: number }>;
  scanned?: number;
  truncated?: boolean;
  code?: string;
  message?: string;
}

export async function runNormaliseVocab(
  argv: string[],
  options: NormaliseVocabOptions = {}
): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--reject');
  const [namespace, type, field] = positional;
  if (namespace === undefined || type === undefined || field === undefined) {
    write(
      'usage: substrate normalise-vocab <namespace> <Type> <field> [--apply] [--reject a,b] [--json]\n'
    );
    return 2;
  }
  const baseUrl = (options.baseUrl ?? process.env.SUBSTRATE_URL ?? '').replace(/\/+$/, '');
  if (baseUrl === '') {
    write('SUBSTRATE_URL is required (e.g. https://substrate.example.com:3100)\n');
    return 2;
  }
  const token = options.token ?? process.env.SUBSTRATE_ADMIN_TOKEN;
  const rejectAt = argv.indexOf('--reject');
  const reject =
    rejectAt >= 0 ? (argv[rejectAt + 1] ?? '').split(',').filter((v) => v.length > 0) : [];
  const apply = argv.includes('--apply');

  if (token !== undefined && token.length > 0) {
    try {
      tokenAudience(baseUrl);
    } catch (err) {
      write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }
  let res: Response;
  try {
    res = await noRedirectFetch(options.fetchImpl)(
      `${baseUrl}/substrate/v1/_system/normalise-vocab`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token !== undefined && token.length > 0 ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ namespace, type, field, apply, reject })
      }
    );
  } catch (err) {
    write(`request failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const body = (await res.json().catch(() => ({}))) as Summary;
  if (argv.includes('--json')) write(`${JSON.stringify(body, null, 2)}\n`);

  if (res.status === 409) {
    if (!argv.includes('--json')) {
      write(`refused: ${body.message ?? 'unmapped values'}\n`);
      for (const u of body.unmapped ?? []) write(`  ${u.value}  ${u.count}\n`);
    }
    return 1;
  }
  if (!res.ok) {
    if (!argv.includes('--json'))
      write(`HTTP ${res.status}: ${body.code ?? ''} ${body.message ?? ''}\n`);
    return 2;
  }
  if (argv.includes('--json')) return 0;

  write(
    `${namespace}/${type}.${field}: ${body.scanned ?? '?'} rows scanned${body.truncated ? ' (TRUNCATED)' : ''}\n`
  );
  const rows = body.applied ? (body.migrated ?? []) : (body.plan ?? []);
  write(body.applied ? 'rewritten:\n' : 'would rewrite (dry run; pass --apply):\n');
  for (const p of rows) write(`  ${p.from} -> ${p.to}  ${p.count}\n`);
  if (rows.length === 0) write('  (nothing)\n');
  const left = body.applied ? (body.stranded ?? []) : (body.unmapped ?? []);
  if (left.length > 0) {
    write(
      body.applied
        ? 'left as they are (rejected):\n'
        : 'no alias explains (add one, widen the vocabulary, or --reject):\n'
    );
    for (const u of left) write(`  ${u.value}  ${u.count}\n`);
  }
  return 0;
}
