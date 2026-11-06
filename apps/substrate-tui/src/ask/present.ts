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
/** Why a block, type or entry was ignored; `type` names the type it is about, absent for the whole block. */
export interface Problem {
  type?: string;
  text: string;
}
export interface Presentation {
  /** Null-prototype: look up with `Object.hasOwn`. */
  types: Record<string, TypeView>;
  problems: Problem[];
}

/** Keys that would reach or shadow Object.prototype; refused as type and field names. */
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
/** `m[k]` when `k` is m's own key. */
export const own = <T>(m: Record<string, T>, k: string): T | undefined =>
  Object.hasOwn(m, k) ? m[k] : undefined;

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

/** Why a field cannot be shown, or undefined when it can. A crossRef walk (`card.cardName`) is not carried by NL answer rows. */
const unusable = (field: string) =>
  RESERVED.has(field)
    ? 'is a reserved name'
    : field.includes('.')
      ? 'crosses a reference'
      : undefined;

/** The entry, or undefined (noted) when its field cannot be shown. */
function usable(e: Entry, t: string, where: string, problems: Problem[]): Entry | undefined {
  const why = unusable(e.field);
  if (why === undefined) return e;
  problems.push({ type: t, text: `${where}: ${e.field} ${why}; left out` });
  return undefined;
}

function rowView(t: string, v: unknown, problems: Problem[]): RowView {
  if (!isObj(v)) throw new Bad(`rows.${t} is not an object`);
  const at = (k: string) => `rows.${t}.${k}`;
  const list = (k: 'tags' | 'details') => {
    const raw = v[k];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new Bad(`${at(k)} is not a list`);
    return raw
      .map((x, i) => usable(entry(x, `${at(k)}[${i}]`), t, at(k), problems))
      .filter((x): x is Entry => x !== undefined);
  };
  const one = (k: 'title' | 'value') =>
    v[k] === undefined ? undefined : usable(entry(v[k], at(k)), t, at(k), problems);
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
  const problems: Problem[] = [];
  const types = dict<TypeView>();
  if (raw === undefined) return { types, problems };
  const whole = (why: string): Presentation => ({
    types,
    problems: [{ text: `tui ignored: ${why}` }]
  });
  if (!isObj(raw)) return whole('not an object');
  const currency = raw.currency ?? 'USD';
  if (typeof currency !== 'string' || !validCurrency(currency))
    return whole(`currency ${JSON.stringify(currency)} is not an ISO 4217 code`);
  if (raw.formats !== undefined && !isObj(raw.formats)) return whole('formats is not an object');
  if (raw.rows !== undefined && !isObj(raw.rows)) return whole('rows is not an object');

  const dead = new Set<string>();
  const view = (t: string): TypeView => {
    if (!Object.hasOwn(types, t)) types[t] = { currency, formats: dict<string>() };
    return types[t] as TypeView;
  };
  for (const [key, fmt] of Object.entries(raw.formats ?? {})) {
    const dot = key.indexOf('.');
    const t = key.slice(0, dot);
    if (dot <= 0 || dot === key.length - 1 || RESERVED.has(t)) {
      problems.push({ text: `formats.${key}: key is not '<Type>.<field>'; left out` });
      continue;
    }
    const field = key.slice(dot + 1);
    const why = unusable(field);
    if (why !== undefined) {
      problems.push({ type: t, text: `formats.${key}: ${field} ${why}; left out` });
      continue;
    }
    if (typeof fmt !== 'string') {
      problems.push({ type: t, text: `${t} ignored: formats.${key} is not a string` });
      dead.add(t);
      continue;
    }
    view(t).formats[field] = fmt;
  }
  for (const [t, spec] of Object.entries(raw.rows ?? {})) {
    if (RESERVED.has(t)) {
      problems.push({ text: `rows.${t}: ${t} is a reserved name; left out` });
      continue;
    }
    try {
      view(t).row = rowView(t, spec, problems);
    } catch (e) {
      if (!(e instanceof Bad)) throw e;
      problems.push({ type: t, text: `${t} ignored: ${e.message}` });
      dead.add(t);
    }
  }
  for (const t of dead) delete types[t];
  return { types, problems };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const DECIMAL = /^\s*-?\d+(\.\d+)?\s*$/;
const NUMERIC = new Set(['money', 'int', 'number', 'pct']);

/** Whether a format reads its value as a number. */
export const isNumericFormat = (fmt: string | undefined) => fmt !== undefined && NUMERIC.has(fmt);

/** `v` under `fmt`, unsanitised; raw `String(v)` when the format is unknown or does not fit the value. */
export function formatValue(v: unknown, fmt: string | undefined, currency: string): string {
  const raw = String(v);
  if (fmt === undefined) return raw;
  if (NUMERIC.has(fmt)) {
    const n =
      typeof v === 'number' ? v : typeof v === 'string' && DECIMAL.test(v) ? Number(v) : NaN;
    if (!Number.isFinite(n)) return raw;
    if (fmt === 'money')
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        signDisplay: 'negative'
      }).format(n);
    if (fmt === 'int')
      return new Intl.NumberFormat('en-US', {
        maximumFractionDigits: 0,
        signDisplay: 'negative'
      }).format(n);
    const num = new Intl.NumberFormat('en-US', {
      maximumFractionDigits: 2,
      signDisplay: 'negative'
    }).format(n);
    return fmt === 'pct' ? `${num}%` : num;
  }
  if (fmt === 'date' || fmt === 'datetime') {
    if (typeof v !== 'string' && typeof v !== 'number') return raw;
    // A bare calendar date has no zone to convert from.
    if (fmt === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return raw;
    // A date-only value stored as an instant comes back as UTC midnight; keep its calendar day.
    if (fmt === 'date' && d.getTime() % 86_400_000 === 0) return d.toISOString().slice(0, 10);
    return fmt === 'date'
      ? localDay(d)
      : `${localDay(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  return raw;
}
