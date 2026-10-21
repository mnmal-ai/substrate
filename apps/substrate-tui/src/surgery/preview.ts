/** Previews: what each surgery op would do, computed against the admin client before the operator types the target. */

import { resolve } from 'node:path';
import type { AdminApi } from '@mnmal-ai/substrate/client';
import { sanitise } from '@mnmal-ai/surface-core';
import { type Refusal, refusalOf } from '../admin/refusal.js';
import { isKeyRejection } from '../admin/session.js';
import { expandHome } from '../keys/pubkey.js';
import type { Line } from '../lines.js';
import { type SurgeryOp, type TypeRef, targetOf } from './args.js';

export type ApplyPlan =
  | { readonly kind: 'drop-namespace' | 'drop-type' }
  | { readonly kind: 'backfill'; readonly values: Readonly<Record<string, unknown>> }
  | { readonly kind: 'normalise' }
  | { readonly kind: 'reindex'; readonly types: readonly TypeRef[] };

export type Preview =
  /** `ready`: apply is live once the target is typed. `apply` carries what the apply step needs. */
  | { readonly kind: 'ready'; readonly lines: readonly Line[]; readonly apply: ApplyPlan }
  /** The server (or a local check) refused: apply is dead. */
  | { readonly kind: 'refused'; readonly lines: readonly Line[]; readonly refusal: Refusal };

/** The admin client surface previews use — `AdminApi` satisfies it; tests pass a fake. */
export type PreviewClient = Pick<
  AdminApi,
  'dropNamespace' | 'dropType' | 'backfill' | 'normalise' | 'embedStats'
>;

export interface PreviewEnv {
  readonly readFile: (path: string) => string;
  readonly home?: string;
  readonly signal?: AbortSignal;
}

const line = (text: string, tone?: Line['tone']): Line => ({
  text: sanitise(text),
  ...(tone !== undefined ? { tone } : {})
});

const ready = (lines: Line[], apply: ApplyPlan): Preview => ({ kind: 'ready', lines, apply });

function refused(refusal: Refusal, extra: Line[] = []): Preview {
  return {
    kind: 'refused',
    refusal,
    lines: [line(`${refusal.code}: ${refusal.message}`, 'error'), ...extra]
  };
}

const local = (code: string, message: string): Preview =>
  refused({ code, message: sanitise(message) });

const sig = (env: PreviewEnv) => (env.signal !== undefined ? { signal: env.signal } : {});

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));

export async function previewOf(
  op: SurgeryOp,
  admin: PreviewClient,
  env: PreviewEnv
): Promise<Preview> {
  try {
    switch (op.kind) {
      case 'drop-namespace':
      case 'drop-type':
        return await dropPreview(op, admin, env);
      case 'backfill':
        return await backfillPreview(op, admin, env);
      case 'normalise':
        return await normalisePreview(op, admin, env);
      case 'reindex':
        return await reindexPreview(op, admin, env);
    }
  } catch (err) {
    // A rejected key is not this op's refusal: rethrown, so `admin.run` locks the session.
    if (isKeyRejection(err)) throw err;
    return refusedFrom(err, op);
  }
}

function refusedFrom(err: unknown, op: SurgeryOp): Preview {
  const refusal = refusalOf(err);
  return refused(refusal, refusalDetail(refusal, op));
}

/** The route-specific detail of a server refusal, sanitised: the preview and the apply both show it. */
export function refusalDetail(refusal: Refusal, op: SurgeryOp): Line[] {
  const extra: Line[] = [];
  const body = refusal.body;
  if (refusal.code === 'dangling_edges' && body !== undefined) {
    extra.push(
      line(`${num(body.edgeCount)} dangling edges — pass --cascade to delete them`, 'warn')
    );
    const samples = Array.isArray(body.sampleEdges) ? body.sampleEdges.slice(0, 5) : [];
    for (const s of samples) {
      const id = (s as { id?: unknown } | null)?.id;
      if (id !== undefined) extra.push(line(`  ${String(id)}`, 'dim'));
    }
  } else if (refusal.code === 'destructive_ops_disabled') {
    extra.push(
      line('this deployment refuses destructive operations (SUBSTRATE_HARD_DELETE=refuse)', 'warn')
    );
  } else if (op.kind === 'backfill' && body !== undefined && Array.isArray(body.invalid)) {
    for (const i of body.invalid.slice(0, 8)) {
      const e = i as { id?: unknown; value?: unknown; reason?: unknown };
      extra.push(line(`${String(e.id)}: ${String(e.value)} (${String(e.reason)})`, 'dim'));
    }
  } else if (op.kind === 'normalise' && body !== undefined && Array.isArray(body.unmapped)) {
    for (const u of body.unmapped.slice(0, 8)) {
      const e = u as { value?: unknown; count?: unknown };
      extra.push(line(`${String(e.value)} · ${num(e.count)}`, 'warn'));
    }
    if (body.unmapped.length > 8) {
      extra.push(line(`… ${body.unmapped.length - 8} more values`, 'dim'));
    }
  }
  return extra;
}

async function dropPreview(
  op: Extract<SurgeryOp, { kind: 'drop-namespace' | 'drop-type' }>,
  admin: PreviewClient,
  env: PreviewEnv
): Promise<Preview> {
  const base = {
    confirm: targetOf(op),
    cascade: op.cascade ? ('delete' as const) : ('refuse' as const),
    dryRun: true
  };
  const r =
    op.kind === 'drop-namespace'
      ? await admin.dropNamespace({ namespace: op.namespace, ...base }, sig(env))
      : await admin.dropType({ namespace: op.namespace, type: op.type, ...base }, sig(env));
  const lines = [
    line(
      `would delete ${r.rowsDeleted} rows · ${r.edgesDeleted} edges · ${r.shortIdsDeleted} shortIds`
    ),
    line(`cascade: ${base.cascade}`, 'dim')
  ];
  if (op.kind === 'drop-type') {
    lines.push(line('drops data only — a type still declared reappears on the next boot', 'warn'));
  }
  return ready(lines, { kind: op.kind });
}

async function backfillPreview(
  op: Extract<SurgeryOp, { kind: 'backfill' }>,
  admin: PreviewClient,
  env: PreviewEnv
): Promise<Preview> {
  const p = expandHome(op.valuesPath, env.home);
  if ('error' in p) return local('bad_path', p.error);
  let raw: string;
  try {
    raw = env.readFile(p.path);
  } catch (err) {
    return local(
      'unreadable',
      `cannot read ${p.path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return local('not_json', `${p.path} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return local('not_an_object', `${p.path} must hold a JSON object of row id → value`);
  }
  const values = parsed as Record<string, unknown>;
  const r = await admin.backfill(
    {
      namespace: op.namespace,
      type: op.type,
      field: op.field,
      values,
      overwrite: op.overwrite
    },
    sig(env)
  );
  const lines = [
    line(`values: ${resolve(p.path)} · ${Object.keys(values).length} entries`),
    line(`${r.requested} requested · would write ${r.write}`)
  ];
  const counts = Object.entries(r.counts).sort((a, b) => b[1] - a[1]);
  for (const [value, n] of counts.slice(0, 8)) lines.push(line(`  ${value} · ${n}`, 'dim'));
  if (counts.length > 8) lines.push(line(`  … ${counts.length - 8} more values`, 'dim'));
  if (r.kept > 0 && !op.overwrite) {
    lines.push(line(`kept ${r.kept} existing (pass --overwrite to replace)`));
  }
  if (r.unchanged > 0) lines.push(line(`unchanged ${r.unchanged}`));
  if (r.missing.length > 0) lines.push(line(`missing ${r.missing.length} id(s)`, 'warn'));
  if (r.chunks > 1) {
    lines.push(
      line(
        `${r.chunks} requests of up to 5000 rows — apply is NOT atomic: a refusal part-way leaves earlier chunks written`,
        'warn'
      )
    );
  }
  return ready(lines, { kind: 'backfill', values });
}

async function normalisePreview(
  op: Extract<SurgeryOp, { kind: 'normalise' }>,
  admin: PreviewClient,
  env: PreviewEnv
): Promise<Preview> {
  const r = await admin.normalise(
    { namespace: op.namespace, type: op.type, field: op.field, reject: op.reject },
    sig(env)
  );
  const lines = [line(`scanned ${r.scanned}`)];
  if (r.truncated) lines.push(line('scan stopped at its row cap — counts are partial', 'warn'));
  for (const p of r.plan) lines.push(line(`${p.from} → ${p.to} · ${p.count}`));
  for (const u of r.unmapped) lines.push(line(`${u.value} · ${u.count}`, 'warn'));
  const unlisted = r.unmapped.filter((u) => !op.reject.includes(String(u.value)));
  if (r.strict && unlisted.length > 0) {
    return refused(
      {
        code: 'unmapped_values',
        message: 'strict field: values no alias explains must be listed in --reject'
      },
      [...lines, line(`not in --reject: ${unlisted.map((u) => u.value).join(', ')}`, 'warn')]
    );
  }
  if (r.plan.length === 0 && r.unmapped.length === 0) lines.push(line('nothing to normalise'));
  return ready(lines, { kind: 'normalise' });
}

async function reindexPreview(
  op: Extract<SurgeryOp, { kind: 'reindex' }>,
  admin: PreviewClient,
  env: PreviewEnv
): Promise<Preview> {
  const s = await admin.embedStats(sig(env));
  if (s.enabled !== true) return local('embedder_disabled', 'the server has no embedder enabled');
  if (s.embeddedTypes === undefined) {
    return local('no_embedded_types', 'the server did not report its embedded types');
  }
  const embedded = s.embeddedTypes;
  const name = (t: TypeRef) => `${t.namespace}/${t.type}`;
  const has = (t: TypeRef) =>
    embedded.some((e) => e.namespace === t.namespace && e.type === t.type);
  const missing = op.targets.filter((t) => !has(t));
  if (missing.length > 0) {
    return refused(
      {
        code: 'not_embedded',
        message: `not embedded: ${missing.map(name).join(', ')}`
      },
      [line(`embedded types: ${embedded.map(name).join(', ') || '(none)'}`, 'dim')]
    );
  }
  const types = op.targets.length === 0 ? embedded : op.targets;
  return ready(
    [
      line(`will re-embed ${types.length} type(s): ${types.map(name).join(', ')}`),
      line('row counts are not known until it runs — this re-embeds for real', 'warn'),
      line('esc stops between pages', 'warn')
    ],
    { kind: 'reindex', types }
  );
}
