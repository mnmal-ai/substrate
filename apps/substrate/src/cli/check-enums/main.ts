/**
 * `substrate check-enums` — report stored values that fall outside a field's
 * declared `enum` vocabulary.
 *
 * Write-time validation does not cover rows that predate an enum declaration,
 * nor fields absent from an update patch, so stored values can drift from
 * the published vocabulary.
 *
 * Read-only by default and runs over HTTP, so it needs no database
 * credential. `--record` writes `_system/EnumCheckVerdict` rows and needs a
 * credential with `_system` mutate via SUBSTRATE_ENUM_CHECK_TOKEN.
 */

import { createHash } from 'node:crypto';
import { tokenAudience } from '@mnmal-ai/substrate-client';

/**
 * Structural subset of `FieldDef` — only what drift detection reads. Kept
 * local rather than importing from substrate-types so the command tolerates a
 * server running a different schema version than the CLI: unknown `kind`s and
 * extra keys are ignored rather than failing to parse.
 */
interface FieldDefLike {
  kind?: string;
  type?: string;
  enum?: readonly string[];
  aliases?: Readonly<Record<string, string>>;
  strict?: boolean;
  [extra: string]: unknown;
}

interface SchemaLike {
  types?: Record<string, { fields?: Record<string, FieldDefLike> }>;
}

/** The shape of `GET /substrate/v1/federated-schema`, as much of it as this reads. */
export type FederatedSchemaLike = Record<string, SchemaLike>;

/** One enum-declared field somewhere in the federated schema. */
export interface EnumField {
  namespace: string;
  type: string;
  field: string;
  vocabulary: readonly string[];
  aliases?: Readonly<Record<string, string>>;
  /** `false` admits free values; only stored aliases are then offenders. */
  strict?: boolean;
}

/** What the scan found for one enum field. */
export interface EnumFieldReport extends EnumField {
  rowsScanned: number;
  /** Distinct stored values outside `vocabulary`, with occurrence counts. */
  offenders: Array<{ value: string; count: number }>;
  /** True when pagination stopped before the table was exhausted. */
  truncated: boolean;
}

export interface CheckEnumsResult {
  fieldsChecked: number;
  reports: EnumFieldReport[];
  /** Reports carrying at least one offender — the actionable subset. */
  drifted: EnumFieldReport[];
}

/**
 * Walk a federated schema and collect every scalar field declaring an `enum`.
 * Exported so the scan and the reporting can be tested without a server.
 */
export function collectEnumFields(federated: FederatedSchemaLike): EnumField[] {
  const out: EnumField[] = [];
  for (const [namespace, schema] of Object.entries(federated)) {
    for (const [type, entry] of Object.entries(schema.types ?? {})) {
      for (const [field, def] of Object.entries(entry.fields ?? {})) {
        if (def.kind === 'scalar' && def.enum !== undefined && def.enum.length > 0) {
          out.push({
            namespace,
            type,
            field,
            vocabulary: def.enum,
            ...(def.aliases !== undefined ? { aliases: def.aliases } : {}),
            ...(def.strict === false ? { strict: false } : {})
          });
        }
      }
    }
  }
  return out;
}

/**
 * Tally values outside the vocabulary. `null`/`undefined` are skipped rather
 * than reported: a nullable enum legitimately holds null, and
 * `assertEnumValues` skips them on write for the same reason — flagging them
 * here would contradict the writer and bury the real offenders.
 */
export function tallyOffenders(
  values: unknown[],
  vocabulary: readonly string[],
  opts: { aliases?: Readonly<Record<string, string>>; strict?: boolean } = {}
): Array<{ value: string; count: number }> {
  const allowed = new Set(vocabulary);
  // A non-strict field admits free values; what is still worth reporting is a
  // value the server would canonicalise, since normalise-vocab can rewrite it.
  const normalisable = new Set([
    ...vocabulary.map((v) => v.toLowerCase()),
    ...Object.keys(opts.aliases ?? {}).map((a) => a.toLowerCase())
  ]);
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const asString = typeof value === 'string' ? value : String(value);
    if (allowed.has(asString)) continue;
    if (opts.strict === false && !normalisable.has(asString.toLowerCase())) continue;
    counts.set(asString, (counts.get(asString) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

interface ScanOptions {
  baseUrl: string;
  fetchImpl: Fetcher;
  /** Rows per request. */
  pageSize: number;
  /** Stop after this many rows per field; `truncated` records that we did. */
  maxRows: number;
  /** `Authorization` header value, or undefined to send none. */
  authorization: string | undefined;
}

/**
 * Project a single field across one type, following `_pagination.nextCursor`.
 *
 * Projecting ONE field keeps the response small, and it is also the only
 * projection guaranteed safe: any other field name could itself be undeclared,
 * which would land in `_diagnostics.unknownProjectionFields` and come back null
 * on every row.
 */
async function scanField(field: EnumField, opts: ScanOptions): Promise<EnumFieldReport> {
  const key = `${field.namespace}/${field.type}`;
  const values: unknown[] = [];
  let cursor: string | undefined;
  let truncated = false;

  for (;;) {
    const params: Record<string, unknown> = { limit: opts.pageSize };
    if (cursor !== undefined) params.cursor = cursor;

    const res = await opts.fetchImpl(`${opts.baseUrl}/substrate/v1/query`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(opts.authorization !== undefined ? { authorization: opts.authorization } : {})
      },
      body: JSON.stringify({ [key]: { params, fields: { [field.field]: true } } })
    });
    if (!res.ok) {
      throw new Error(`query ${key} failed: HTTP ${res.status}`);
    }

    const envelope = (await res.json()) as {
      data?: Record<string, unknown>;
      errors?: Array<{ message?: string; code?: string }>;
      _pagination?: Record<string, { nextCursor?: string; hasMore?: boolean }>;
    };
    const failure = envelope.errors?.[0];
    if (failure !== undefined) {
      throw new Error(`query ${key} rejected: ${failure.code ?? 'error'} ${failure.message ?? ''}`);
    }

    const rows = envelope.data?.[key];
    if (Array.isArray(rows)) {
      for (const row of rows) {
        values.push((row as Record<string, unknown> | null)?.[field.field]);
      }
    }

    if (values.length >= opts.maxRows) {
      truncated = true;
      break;
    }
    const page = envelope._pagination?.[key];
    if (page?.hasMore !== true || page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }

  return {
    ...field,
    rowsScanned: values.length,
    offenders: tallyOffenders(values, field.vocabulary, field),
    truncated
  };
}

export interface CheckEnumsOptions {
  baseUrl?: string;
  fetchImpl?: Fetcher;
  pageSize?: number;
  maxRows?: number;
  /**
   * Bearer token for the scan. Defaults to SUBSTRATE_ENUM_CHECK_TOKEN. Schema discovery
   * and /substrate/v1/query both need a key once auth is on.
   */
  token?: string;
  /** Sink for human-readable output. Defaults to stdout. */
  write?: (text: string) => void;
}

/**
 * Returns 0 when every enum-declared field agrees with its stored rows, 1 when
 * any drift is found — usable as a CI or cron gate.
 */
export async function runCheckEnums(
  argv: string[] = [],
  options: CheckEnumsOptions = {}
): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const asJson = argv.includes('--json');
  const baseUrl = (options.baseUrl ?? process.env.SUBSTRATE_URL ?? '').replace(/\/+$/, '');
  if (baseUrl === '') {
    write('SUBSTRATE_URL is required (e.g. https://substrate.example.com:3100)\n');
    return 2;
  }

  const baseFetch = options.fetchImpl ?? fetch;
  // A redirect would carry the token to wherever it points.
  const fetchImpl: Fetcher = (url, init) => baseFetch(url, { ...init, redirect: 'error' });
  const pageSize = options.pageSize ?? 500;
  const maxRows = options.maxRows ?? 50_000;

  const token = options.token ?? process.env.SUBSTRATE_ENUM_CHECK_TOKEN;
  const authorization = token !== undefined && token.length > 0 ? `Bearer ${token}` : undefined;
  if (authorization !== undefined) {
    try {
      tokenAudience(baseUrl);
    } catch (err) {
      write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }

  const schemaRes = await fetchImpl(`${baseUrl}/substrate/v1/federated-schema`, {
    headers: authorization !== undefined ? { authorization } : {}
  });
  if (!schemaRes.ok) {
    const hint =
      schemaRes.status === 401
        ? ' — the server needs a key: set SUBSTRATE_ENUM_CHECK_TOKEN to a Bearer token with read'
        : '';
    write(`federated-schema failed: HTTP ${schemaRes.status}${hint}\n`);
    return 2;
  }
  const federated = (await schemaRes.json()) as FederatedSchemaLike;
  const fields = collectEnumFields(federated);

  const reports: EnumFieldReport[] = [];
  for (const field of fields) {
    reports.push(await scanField(field, { baseUrl, fetchImpl, pageSize, maxRows, authorization }));
  }
  const drifted = reports.filter((r) => r.offenders.length > 0);
  const result: CheckEnumsResult = { fieldsChecked: fields.length, reports, drifted };

  if (argv.includes('--record')) {
    const recordCode = await recordVerdicts(baseUrl, fetchImpl, reports);
    if (recordCode !== 0) return recordCode;
  }

  if (asJson) {
    write(`${JSON.stringify(result, null, 2)}\n`);
    return drifted.length > 0 ? 1 : 0;
  }

  write(`Checked ${fields.length} enum-declared field(s).\n`);
  for (const report of drifted) {
    write(`\n  DRIFT  ${report.namespace}/${report.type}.${report.field}\n`);
    write(`         declared: ${report.vocabulary.join(', ')}\n`);
    for (const { value, count } of report.offenders) {
      write(`         stored:   '${value}' x${count}  (not declared)\n`);
    }
    if (report.truncated) {
      write(`         NOTE: stopped at ${report.rowsScanned} rows — counts are a floor.\n`);
    }
  }
  // A truncated scan that found nothing is NOT a clean result: the offender may
  // sit past the cut. Say so rather than letting silence read as health.
  for (const report of reports) {
    if (report.offenders.length === 0 && report.truncated) {
      write(
        `\n  PARTIAL ${report.namespace}/${report.type}.${report.field} — clean over the first ${report.rowsScanned} rows, table not exhausted.\n`
      );
    }
  }
  if (drifted.length === 0) {
    write('\nNo drift found.\n');
  }
  return drifted.length > 0 ? 1 : 0;
}

/**
 * sha256 of the vocabulary JSON — a vocab edit invalidates the verdict
 * structurally. Aliases and strictness change what counts as an offender, so
 * they join the hash when declared; a plain enum hashes exactly as before.
 */
export function vocabHash(
  vocabulary: readonly string[],
  opts: { aliases?: Readonly<Record<string, string>>; strict?: boolean } = {}
): string {
  const plain = opts.aliases === undefined && opts.strict !== false;
  const subject = plain
    ? [...vocabulary]
    : { vocabulary: [...vocabulary], aliases: opts.aliases ?? {}, strict: opts.strict !== false };
  return createHash('sha256').update(JSON.stringify(subject)).digest('hex');
}

/** Deterministic verdict-row id: one live verdict per (namespace, type, field). */
export function verdictId(report: EnumFieldReport): string {
  return `${report.namespace}/${report.type}/${report.field}`;
}

/**
 * Write one `_system/EnumCheckVerdict` row per scanned field.
 *
 * Upsert by deterministic id: `updateEnumCheckVerdict` when the row exists,
 * `createEnumCheckVerdict` when it does not (distinguished by a get, not by
 * catching — a failed create must stay a failure, not a silent update).
 * A run that found drift still records: the verdict carries the outlier
 * count, and "checked with drift" is a different fact from "unchecked".
 *
 * Returns a process exit code: 3 when the credential is absent or refused
 * (recording needs `_system` mutate; the scan itself already succeeded, so
 * this is neither a 1 (drift) nor a 2 (usage/transport)).
 */
export async function recordVerdicts(
  baseUrl: string,
  fetchImpl: Fetcher,
  reports: EnumFieldReport[],
  opts: { token?: string; now?: () => string } = {}
): Promise<number> {
  const token = opts.token ?? process.env.SUBSTRATE_ENUM_CHECK_TOKEN;
  if (token === undefined || token.length === 0) {
    process.stderr.write(
      'check-enums --record needs SUBSTRATE_ENUM_CHECK_TOKEN (Bearer token with _system mutate) — ' +
        'recording a verdict is a claim about the deployment, and anonymous callers must not mint one.\n'
    );
    return 3;
  }
  try {
    tokenAudience(baseUrl);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const now = opts.now ?? (() => new Date().toISOString());
  const checkedAt = now();
  for (const report of reports) {
    const id = verdictId(report);
    const params = {
      id,
      namespace: report.namespace,
      type: report.type,
      field: report.field,
      vocabHash: vocabHash(report.vocabulary, report),
      checkedAt,
      rowsScanned: report.rowsScanned,
      outlierCount: report.offenders.reduce((n, o) => n + o.count, 0),
      truncated: report.truncated,
      verdictKey: id
    };
    const getRes = await fetchImpl(`${baseUrl}/substrate/v1/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        '_system/EnumCheckVerdict': { params: { id }, fields: { id: true } }
      })
    });
    if (!getRes.ok) {
      process.stderr.write(`verdict lookup for ${id} failed: HTTP ${getRes.status}\n`);
      return 3;
    }
    const envelope = (await getRes.json()) as {
      data?: Record<string, unknown>;
      errors?: Array<{ message?: string; code?: string }>;
    };
    if (envelope.errors?.[0] !== undefined) {
      process.stderr.write(
        `verdict lookup for ${id} refused: ${envelope.errors[0].code ?? 'error'} ${envelope.errors[0].message ?? ''}\n`
      );
      return 3;
    }
    const existing = envelope.data?.['_system/EnumCheckVerdict'];
    const mutation = Array.isArray(existing) && existing.length > 0 ? 'update' : 'create';
    const mutRes = await fetchImpl(`${baseUrl}/substrate/v1/mutate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        [`_system/${mutation}EnumCheckVerdict`]: { params, fields: { id: true } }
      })
    });
    if (!mutRes.ok) {
      process.stderr.write(`verdict write for ${id} failed: HTTP ${mutRes.status}\n`);
      return 3;
    }
    const mutEnvelope = (await mutRes.json()) as {
      data?: Record<string, unknown>;
      errors?: Array<{ message?: string; code?: string }>;
    };
    const mutFailure = mutEnvelope.errors?.[0];
    if (mutFailure !== undefined) {
      process.stderr.write(
        `verdict write for ${id} refused: ${mutFailure.code ?? 'error'} ${mutFailure.message ?? ''}\n`
      );
      return 3;
    }
  }
  return 0;
}
