import type { FieldDef, PackEnvelope } from '@mnmal-ai/substrate/sdk';
import type { ListDetail, ListHooks } from '@mnmal-ai/surface-core';
import type { ListRow, ListSpec } from '@mnmal-ai/surface-kit/list';
import type { TuiDeps } from '../deps.js';
import { labelField } from './render.js';

/** Rows `r` lists: recall's hits about the same idea, the row itself left out. */
export const RELATED_K = 20;
const META = ['status', 'area', 'project'] as const;

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const scalar = (v: unknown) => v !== null && v !== undefined && v !== '' && typeof v !== 'object';
const nameOf = (row: ListRow) =>
  typeof row.name === 'string' ? row.name : row.name.map((s) => s.text).join('');

/** A frame's rows; a refused frame throws the server's reason rather than reading as empty. */
async function rowsOf(
  deps: TuiDeps,
  key: string,
  frame: Record<string, unknown>,
  signal: AbortSignal | undefined
): Promise<Record<string, unknown>[]> {
  const env: PackEnvelope = await deps.query({ [key]: frame }, signal);
  if (!Object.hasOwn(env.data, key))
    throw new Error(env.errors?.[0]?.message ?? `${key} was refused`);
  const v = env.data[key];
  return (Array.isArray(v) ? v : [v]).filter(
    (x): x is Record<string, unknown> => x !== null && typeof x === 'object'
  );
}

/**
 * Enter and `r` on an NL answer's rows. `open` reads the row's record whole (every scalar field
 * the schema has, else the fields the answer carried); `related` asks recall, over the same type
 * and namespace, for rows about the same idea as the record's label and body.
 */
export function listHooks(
  deps: TuiDeps,
  ns: string,
  type: string,
  fields: Record<string, FieldDef> | undefined,
  answered: ReadonlyMap<string, Record<string, unknown>>,
  signal?: AbortSignal
): ListHooks {
  const records = new Map<string, Promise<Record<string, unknown>>>();
  const record = (row: ListRow) => {
    const known = records.get(row.key);
    if (known !== undefined) return known;
    const seen = answered.get(row.key) ?? {};
    // A row the answer carried without an id has no record to read; it is shown as it came.
    if (typeof seen.id !== 'string') return Promise.resolve(seen);
    const names =
      fields !== undefined
        ? Object.entries(fields)
            .filter(([, f]) => f.kind === 'scalar' && f.type !== 'json')
            .map(([k]) => k)
        : Object.keys(seen).filter((k) => scalar(seen[k]));
    const read = rowsOf(
      deps,
      `${ns}/${type}`,
      {
        params: { where: { id: { eq: row.key } }, limit: 1 },
        fields: Object.fromEntries(['id', ...names].map((k) => [k, true]))
      },
      signal
    ).then((rows) => {
      const r = rows[0];
      if (r === undefined) throw new Error(`${type} ${row.key} is gone`);
      return r;
    });
    // A failed read is not cached, so Enter again retries it.
    read.catch(() => records.delete(row.key));
    records.set(row.key, read);
    return read;
  };

  return {
    async open(row): Promise<ListDetail> {
      const r = await record(row);
      const label = labelField(r);
      const meta = META.map((k) => text(r[k])).filter((v) => v !== '');
      const prose = [text(r.body), text(r.notes)].filter((v) => v !== '');
      // A type with no prose shows its other fields instead.
      const body =
        prose.length > 0
          ? prose.join('\n\n')
          : Object.keys(r)
              .filter(
                (k) => k !== 'id' && k !== label && !META.some((m) => m === k) && scalar(r[k])
              )
              .map((k) => `${k}: ${String(r[k])}`)
              .join('\n');
      return {
        title: label !== undefined ? text(r[label]) : nameOf(row),
        ...(meta.length > 0 ? { meta: meta.join(' · ') } : {}),
        ...(body !== '' ? { body } : {})
      };
    },
    async related(row): Promise<ListSpec> {
      const r = await record(row);
      const label = labelField(r);
      const title = label !== undefined ? text(r[label]) : nameOf(row);
      const to = [title, text(r.body)].filter((v) => v !== '').join('\n') || nameOf(row);
      // One more than shown, so leaving out the row itself still fills the list.
      const hits = await rowsOf(
        deps,
        'recall/Hit',
        {
          params: { to, namespace: ns, type, k: RELATED_K + 1 },
          fields: { id: true, score: true, row: true }
        },
        signal
      );
      const rows: ListRow[] = hits
        .filter((h) => h.id !== row.key)
        .slice(0, RELATED_K)
        .map((h) => {
          const hr = (h.row !== null && typeof h.row === 'object' ? h.row : {}) as Record<
            string,
            unknown
          >;
          const l = labelField(hr);
          return {
            key: String(h.id),
            name: (l !== undefined ? text(hr[l]) : '') || String(h.id),
            ...(typeof h.score === 'number' ? { value: h.score.toFixed(2) } : {})
          };
        });
      return { heading: `related to ${title}`, rows };
    }
  };
}
