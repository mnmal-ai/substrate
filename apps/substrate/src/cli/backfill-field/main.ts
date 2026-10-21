/**
 * `substrate backfill-field <namespace> <Type> <field> --values <file.json> [--apply] [--overwrite] [--json]`
 *
 * Writes per-row values of one field (`{ "<row id>": value, ... }` in the
 * file) through the admin route `POST /substrate/v1/_system/backfill-field`, with
 * row metadata preserved. Dry run unless `--apply`; fills only empty values
 * unless `--overwrite`. Chunking lives in `client.admin.backfill`.
 *
 * Env: SUBSTRATE_URL, SUBSTRATE_ADMIN_TOKEN (admin Bearer token). Exit 0 on success,
 * 1 when the server refuses the values, 2 on usage or transport errors.
 */

import { readFileSync } from 'node:fs';
import {
  AdminBackfillError,
  type AdminBackfillSummary,
  AuthError,
  NetworkError,
  noRedirectFetch,
  SubstrateClient,
  tokenAudience
} from '@mnmal-ai/substrate-client';
import { trimTrailingSlashes } from '@mnmal-ai/substrate-types';

export interface BackfillFieldOptions {
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  write?: (text: string) => void;
  readFile?: (path: string) => string;
}

interface Summary {
  write?: number;
  counts?: Record<string, number>;
  missing?: string[];
  kept?: number;
  unchanged?: number;
  code?: string;
  message?: string;
  invalid?: Array<{ id: string; value: unknown; reason: string }>;
}

export async function runBackfillField(
  argv: string[],
  options: BackfillFieldOptions = {}
): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--values');
  const [namespace, type, field] = positional;
  const valuesAt = argv.indexOf('--values');
  const file = valuesAt >= 0 ? argv[valuesAt + 1] : undefined;
  if (namespace === undefined || type === undefined || field === undefined || file === undefined) {
    write(
      'usage: substrate backfill-field <namespace> <Type> <field> --values <file.json> [--apply] [--overwrite] [--json]\n'
    );
    return 2;
  }
  const baseUrl = trimTrailingSlashes(options.baseUrl ?? process.env.SUBSTRATE_URL ?? '');
  if (baseUrl === '') {
    write('SUBSTRATE_URL is required (e.g. https://substrate.example.com:3100)\n');
    return 2;
  }
  let values: Record<string, unknown>;
  try {
    values = JSON.parse((options.readFile ?? ((p) => readFileSync(p, 'utf8')))(file));
  } catch (err) {
    write(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    write(`${file} must hold an object of row id -> value\n`);
    return 2;
  }
  const token = options.token ?? process.env.SUBSTRATE_ADMIN_TOKEN;
  const apply = argv.includes('--apply');
  const overwrite = argv.includes('--overwrite');
  const entries = Object.entries(values);
  const json = argv.includes('--json');

  if (token !== undefined && token.length > 0) {
    try {
      tokenAudience(baseUrl);
    } catch (err) {
      write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }
  const client = new SubstrateClient({
    endpoint: baseUrl,
    ...(token !== undefined && token.length > 0 ? { token } : {}),
    fetch: noRedirectFetch(options.fetchImpl)
  });
  let total: AdminBackfillSummary;
  try {
    total = await client.admin.backfill(
      { namespace, type, field, values, apply, overwrite },
      {
        onChunk: (c) => {
          if (json) write(`${JSON.stringify(c.body)}\n`);
        }
      }
    );
  } catch (err) {
    const cause = err instanceof AdminBackfillError ? err.cause : err;
    const refusal = cause instanceof NetworkError || cause instanceof AuthError ? cause : undefined;
    const body = (refusal?.body ?? {}) as Summary;
    const transport =
      refusal instanceof NetworkError && refusal.status === undefined
        ? refusal.cause instanceof Error
          ? refusal.cause.message
          : refusal.message
        : undefined;
    if (json)
      write(`${JSON.stringify(refusal?.body ?? { message: transport ?? String(cause) })}\n`);
    else if (refusal !== undefined && refusal.status !== undefined) {
      write(`HTTP ${refusal.status}: ${refusal.code ?? ''} ${refusal.serverMessage ?? ''}\n`);
      for (const v of body.invalid ?? []) write(`  ${v.id}: ${String(v.value)} (${v.reason})\n`);
    } else
      write(
        `request failed: ${transport ?? (cause instanceof Error ? cause.message : String(cause))}\n`
      );
    if (!json && err instanceof AdminBackfillError && apply) {
      if (err.chunksDone > 0)
        write(`${err.chunksDone} of ${err.chunks} chunk(s) were written before the refusal\n`);
      const status = refusal?.status;
      if (status === undefined || status < 400 || status >= 500)
        write(
          "the failing chunk's own state is unknown — re-running is safe (written rows come back unchanged)\n"
        );
    }
    return refusal?.status === 400 ? 1 : 2;
  }
  if (json) return 0;

  write(
    `${namespace}/${type}.${field}: ${entries.length} requested — ${apply ? 'wrote' : 'would write (dry run; pass --apply)'} ${total.write}\n`
  );
  for (const [k, n] of Object.entries(total.counts).sort((a, b) => b[1] - a[1]))
    write(`  ${k}  ${n}\n`);
  if (total.kept > 0)
    write(
      `kept ${total.kept} existing value(s)${overwrite ? '' : ' (pass --overwrite to replace)'}\n`
    );
  if (total.unchanged > 0) write(`unchanged ${total.unchanged}\n`);
  if (total.missing.length > 0) write(`missing ${total.missing.length} id(s)\n`);
  return 0;
}
