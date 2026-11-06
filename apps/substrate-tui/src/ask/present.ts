/**
 * A namespace's `annotations.tui`: how its plugin wants rows shown. Read here only; the server
 * passes it through untouched, so everything is checked by hand and a bad part is dropped, never thrown.
 */

/** A field name, or a field with a `{}` template and a label. */
export type TuiEntry = string | { field: string; template?: string; label?: string };

/** The declaration, as a plugin writes it in `defineNamespace(..., { annotations: { tui } })`. */
export interface TuiAnnotation {
  /** ISO 4217 code for `money`; default `USD`. */
  currency?: string;
  /** `'<Type>.<field>'` → `money` | `int` | `number` | `pct` | `date` | `datetime`. */
  formats?: Record<string, string>;
  rows?: Record<
    string,
    { title?: TuiEntry; tags?: TuiEntry[]; value?: TuiEntry; details?: TuiEntry[] }
  >;
}

export interface Entry {
  field: string;
  template?: string;
  label?: string;
}
export interface RowView {
  title?: Entry;
  tags: Entry[];
  value?: Entry;
  details: Entry[];
}
/** One type's presentation: what the rows renderer receives. */
export interface TypeView {
  currency: string;
  /** field → format. */
  formats: Record<string, string>;
  row?: RowView;
}
export interface Presentation {
  types: Record<string, TypeView>;
  /** Why a block, type or entry was ignored. */
  problems: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const validCurrency = (c: string) => {
  try {
    new Intl.NumberFormat('en-US', { style: 'currency', currency: c });
    return true;
  } catch {
    return false;
  }
};

class Bad extends Error {}

function entry(v: unknown, where: string): Entry {
  if (typeof v === 'string' && v !== '') return { field: v };
  if (
    isObj(v) &&
    typeof v.field === 'string' &&
    v.field !== '' &&
    (v.template === undefined || typeof v.template === 'string') &&
    (v.label === undefined || typeof v.label === 'string')
  )
    return {
      field: v.field,
      ...(v.template !== undefined ? { template: v.template as string } : {}),
      ...(v.label !== undefined ? { label: v.label as string } : {})
    };
  throw new Bad(`${where} is not a field name or { field, template?, label? }`);
}

/** A crossRef walk (`card.cardName`) is not carried by NL answer rows, so it is noted and left out. */
function own(e: Entry, where: string, problems: string[]): Entry | undefined {
  if (!e.field.includes('.')) return e;
  problems.push(`${where}: ${e.field} crosses a reference; left out`);
  return undefined;
}

function rowView(t: string, v: unknown, problems: string[]): RowView {
  if (!isObj(v)) throw new Bad(`rows.${t} is not an object`);
  const at = (k: string) => `rows.${t}.${k}`;
  const list = (k: 'tags' | 'details') => {
    const raw = v[k];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new Bad(`${at(k)} is not a list`);
    return raw
      .map((x, i) => own(entry(x, `${at(k)}[${i}]`), at(k), problems))
      .filter((x): x is Entry => x !== undefined);
  };
  const one = (k: 'title' | 'value') =>
    v[k] === undefined ? undefined : own(entry(v[k], at(k)), at(k), problems);
  const title = one('title');
  const value = one('value');
  return {
    ...(title !== undefined ? { title } : {}),
    tags: list('tags'),
    ...(value !== undefined ? { value } : {}),
    details: list('details')
  };
}

export function parseTui(raw: unknown): Presentation {
  const problems: string[] = [];
  if (raw === undefined) return { types: {}, problems };
  const whole = (why: string): Presentation => ({ types: {}, problems: [`tui ignored: ${why}`] });
  if (!isObj(raw)) return whole('not an object');
  const currency = raw.currency ?? 'USD';
  if (typeof currency !== 'string' || !validCurrency(currency))
    return whole(`currency ${JSON.stringify(currency)} is not an ISO 4217 code`);
  if (raw.formats !== undefined && !isObj(raw.formats)) return whole('formats is not an object');
  if (raw.rows !== undefined && !isObj(raw.rows)) return whole('rows is not an object');

  const types: Record<string, TypeView> = {};
  const dead = new Set<string>();
  const view = (t: string) => {
    types[t] ??= { currency, formats: {} };
    return types[t];
  };
  for (const [key, fmt] of Object.entries(raw.formats ?? {})) {
    const dot = key.indexOf('.');
    if (dot <= 0 || dot === key.length - 1) {
      problems.push(`formats.${key}: key is not '<Type>.<field>'; left out`);
      continue;
    }
    const t = key.slice(0, dot);
    if (typeof fmt !== 'string') {
      problems.push(`${t} ignored: formats.${key} is not a string`);
      dead.add(t);
      continue;
    }
    view(t).formats[key.slice(dot + 1)] = fmt;
  }
  for (const [t, spec] of Object.entries(raw.rows ?? {})) {
    try {
      view(t).row = rowView(t, spec, problems);
    } catch (e) {
      if (!(e instanceof Bad)) throw e;
      problems.push(`${t} ignored: ${e.message}`);
      dead.add(t);
    }
  }
  for (const t of dead) delete types[t];
  return { types, problems };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const NUMERIC = new Set(['money', 'int', 'number', 'pct']);

/** Whether a format reads its value as a number. */
export const isNumericFormat = (fmt: string | undefined) => fmt !== undefined && NUMERIC.has(fmt);

/** `v` under `fmt`, unsanitised; raw `String(v)` when the format is unknown or does not fit the value. */
export function formatValue(v: unknown, fmt: string | undefined, currency: string): string {
  const raw = String(v);
  if (fmt === undefined) return raw;
  if (NUMERIC.has(fmt)) {
    const n =
      typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return raw;
    if (fmt === 'money')
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(n);
    if (fmt === 'int')
      return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
    const num = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);
    return fmt === 'pct' ? `${num}%` : num;
  }
  if (fmt === 'date' || fmt === 'datetime') {
    if (typeof v !== 'string' && typeof v !== 'number') return raw;
    // A bare calendar date has no zone to convert from.
    if (fmt === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return raw;
    return fmt === 'date'
      ? localDay(d)
      : `${localDay(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  return raw;
}
