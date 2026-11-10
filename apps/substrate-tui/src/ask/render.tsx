import type { NlOutcome } from '@mnmal-ai/substrate/sdk';
import { type Chip, type Renderer, sanitise } from '@mnmal-ai/surface-core';
import { cellWidth, padCells, truncateCells } from '@mnmal-ai/surface-kit';
import type { ListRow, ListSpec } from '@mnmal-ai/surface-kit/list';
import { Box, Text } from 'ink';
import {
  type Entry,
  formatValue,
  isNumericFormat,
  own,
  type RowView,
  type TypeView
} from './present.js';

export const KIND = {
  line: 'substrate.line',
  rows: 'substrate.rows',
  recall: 'substrate.recall',
  clarify: 'substrate.clarify',
  refuse: 'substrate.refuse',
  unknown: 'substrate.unknown',
  error: 'substrate.error'
} as const;

type Rows = Extract<NlOutcome, { kind: 'rows' }>;
/** A rows outcome as the ask module replies it: with the frame type's `annotations.tui` view, when declared. */
export type RowsReply = Rows & { tui?: TypeView };
type Recall = Extract<NlOutcome, { kind: 'recall' }>;
type Clarify = Extract<NlOutcome, { kind: 'clarify' }>;
type Refuse = Extract<NlOutcome, { kind: 'refuse' }>;
type Unknown = Extract<NlOutcome, { kind: 'unknown' }>;

// Renderers own their output: everything server-derived is stripped of terminal escapes here.
const str = (v: unknown) => (v === undefined || v === null ? '' : sanitise(String(v)));
const frameKey = (o: Rows) => sanitise(Object.keys(o.frame)[0] ?? '?');
const errorLines = (errors: unknown[] | undefined) =>
  (errors ?? []).map((e) => {
    const x = e as { code?: string; message?: string };
    return sanitise(`${x.code ?? 'error'}${x.message !== undefined ? `: ${x.message}` : ''}`);
  });

// `?? []`: a server from before the confidence rule sends no `dropped`.
const droppedLines = (dropped: Rows['dropped'] | undefined) =>
  (dropped ?? []).map((d) => sanitise(`dropped "${d.span}": ${d.reason}`));

export function outcomeChips(o: NlOutcome): Chip[] {
  if (o.kind !== 'rows') return [];
  const rejected = o.data === undefined;
  return [
    { label: `▸ ${frameKey(o)}`, tone: 'query' },
    {
      label: o.handoff !== undefined ? `${o.source} (${sanitise(o.handoff)})` : o.source,
      tone: o.source === 'handoff' ? 'warn' : 'dim'
    },
    {
      label: rejected
        ? 'rejected'
        : o.aggregate !== undefined
          ? 'aggregate'
          : typeof o.count === 'number'
            ? `count ${o.count}`
            : `${Array.isArray(o.data) ? o.data.length : 0} rows`,
      tone: rejected ? 'error' : 'dim'
    }
  ];
}

/** The first label-like field a row has: the usual handles, then any `…Name` / `…Title` string. */
const LABELS = ['title', 'synopsis', 'name', 'topic', 'subject'];
export function labelField(r: Record<string, unknown>): string | undefined {
  const own = LABELS.find((k) => typeof r[k] === 'string' && r[k] !== '');
  if (own !== undefined) return own;
  return Object.keys(r).find(
    (k) => /(Name|Title)$/.test(k) && typeof r[k] === 'string' && r[k] !== ''
  );
}

/** Fields the question filtered or ordered on, in the order they appear in the frame. */
function askedFields(frame: Rows['frame']): string[] {
  const params =
    (Object.values(frame)[0] as { params?: Record<string, unknown> } | undefined)?.params ?? {};
  const out: string[] = [];
  const add = (k: string) => {
    if (!out.includes(k)) out.push(k);
  };
  const walk = (w: unknown) => {
    if (w === null || typeof w !== 'object') return;
    for (const [k, v] of Object.entries(w as Record<string, unknown>)) {
      if (k === 'AND' || k === 'OR' || k === 'NOT') {
        for (const c of Array.isArray(v) ? v : [v]) walk(c);
      } else if (!k.startsWith('_')) add(k);
    }
  };
  // An orderBy key may be a select name, which shows as its `_agg` value.
  for (const o of (params.orderBy as Array<Record<string, unknown>> | undefined) ?? [])
    for (const k of Object.keys(o)) add(k);
  walk(params.where);
  return out;
}

/** A row's walked values (`_agg.<name>`, such as a hop ordering's) as fields beside its own. */
const withWalked = (r: Record<string, unknown>): Record<string, unknown> => {
  const a = own(r, '_agg');
  return a !== null && typeof a === 'object' && !Array.isArray(a)
    ? { ...(a as Record<string, unknown>), ...r }
    : r;
};
/** `name value` for each walked value a row carries. */
const walkedDetails = (r: Record<string, unknown>): string[] => {
  const a = own(r, '_agg');
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return [];
  return Object.entries(a)
    .filter(([, v]) => !empty(v))
    .map(([k, v]) => `${sanitise(k)} ${str(v)}`);
};
// A list or json value has no one-cell form, so it shows as empty.
const empty = (v: unknown) => v === null || v === undefined || v === '' || typeof v === 'object';
/** A row's own field as the view formats it, sanitised; '' when empty. */
const shown = (r: Record<string, unknown>, field: string, view: TypeView | undefined) => {
  const v = own(r, field);
  return empty(v)
    ? ''
    : view === undefined
      ? str(v)
      : sanitise(formatValue(v, own(view.formats, field), view.currency));
};
/** An entry's cell: its template around the formatted value; '' when the value is empty. */
const cell = (r: Record<string, unknown>, e: Entry, view: TypeView) => {
  const v = shown(r, e.field, view);
  // A function replacer, so `$&` and `$$` in a value stay literal.
  return v === '' || e.template === undefined ? v : sanitise(e.template.replaceAll('{}', () => v));
};
/** Width of a right-aligned value column: the widest value, capped at a third of the line. */
const valueWidth = (values: string[], columns: number) =>
  Math.min(Math.max(0, ...values.map(cellWidth)), Math.max(8, Math.floor(columns / 3)));

const SKIP = new Set(['id', 'shortId']);
/** `field=value` for a row's scalar fields: the asked-about ones first, then the rest. */
function detailList(
  r: Record<string, unknown>,
  asked: string[],
  label: string | undefined,
  view: TypeView | undefined
): string[] {
  const scalar = (k: string) => {
    const v = r[k];
    return v !== null && v !== undefined && v !== '' && typeof v !== 'object';
  };
  const keys = [
    ...asked.filter((k) => k in r),
    ...Object.keys(r).filter((k) => !asked.includes(k))
  ];
  return keys
    .filter((k) => !SKIP.has(k) && k !== label && scalar(k))
    .map((k) => `${sanitise(k)}=${shown(r, k, view)}`);
}

// id + status + project + the three two-cell gaps; the title takes what is left of the width.
const COLS = { id: 6, status: 10, project: 14, gaps: 6, minTitle: 12 };
const titleWidth = (columns: number) =>
  Math.max(COLS.minTitle, columns - (COLS.id + COLS.status + COLS.project + COLS.gaps));

const FN_LABEL = { avg: 'average', sum: 'total', min: 'min', max: 'max' } as const;
// Two decimals for a float; a tiny one keeps three significant digits rather than reading 0.
const aggValue = (v: unknown, view?: TypeView, field?: string) =>
  v === null || v === undefined
    ? '—'
    : view !== undefined && field !== undefined && own(view.formats, field) !== undefined
      ? sanitise(formatValue(v, own(view.formats, field), view.currency))
      : typeof v === 'number' && !Number.isInteger(v)
        ? String(Math.abs(v) >= 0.01 ? Math.round(v * 100) / 100 : Number(v.toPrecision(3)))
        : str(v);

type Theme = Parameters<Renderer>[0]['theme'];

/**
 * A declared type's list. Wide: per row a dim ordinal, the bold title, dim tag chips and the value
 * right-aligned in one column down the list, then an optional dim `·`-joined details line.
 * Stacked, when the title would get less than max(20, 40%) of line 1: the title alone, then
 * `tags · value`, then details. One layout for the whole list, so it stays aligned. Rows truncate.
 */
function declaredRows(
  list: Record<string, unknown>[],
  row: RowView,
  view: TypeView,
  theme: Theme,
  columns: number
) {
  const ordW = String(list.length).length;
  const prefixW = 1 + ordW + 2;
  const indent = ' '.repeat(prefixW + 2);
  const detailW = Math.max(1, columns - indent.length);
  const values = list.map((r) => (row.value === undefined ? '' : cell(r, row.value, view)));
  const valW =
    row.value === undefined
      ? 0
      : valueWidth(
          values.map((v) => v || '—'),
          columns
        );
  const leftW = Math.max(1, columns - prefixW - (valW > 0 ? valW + 2 : 0));
  const items = list.map((r) => {
    const f = row.title?.field ?? labelField(r);
    const title = (f === undefined ? '' : cell(r, row.title ?? { field: f }, view)) || '—';
    const tags = row.tags.map((e) => cell(r, e, view)).filter((t) => t !== '');
    const det = declaredDetails(r, row, view);
    return { title, tags, det };
  });
  const tagsW = Math.max(
    0,
    ...items.map((x) => (x.tags.length > 0 ? cellWidth(`  ${x.tags.join('  ')}`) : 0))
  );
  const wide = leftW - tagsW >= Math.max(20, Math.ceil(columns * 0.4));
  const ordinal = (i: number) => (
    <Text color={theme.color.dim}>{` ${padCells(String(i + 1), ordW, true)}  `}</Text>
  );
  const details = (det: string[]) =>
    det.length > 0 ? (
      <Text wrap="truncate" color={theme.color.dim}>
        {indent + truncateCells(det.join(' · '), detailW)}
      </Text>
    ) : null;

  return items.map(({ title, tags, det }, i) => {
    const value = values[i] ?? '';
    if (!wide) {
      const second = [...tags, value].filter((x) => x !== '');
      return (
        <Box key={i} flexDirection="column">
          <Text wrap="truncate">
            {ordinal(i)}
            <Text bold color={theme.color.text}>
              {truncateCells(title, Math.max(1, columns - prefixW))}
            </Text>
          </Text>
          {second.length > 0 ? (
            <Text wrap="truncate" color={theme.color.dim}>
              {indent + truncateCells(second.join(' · '), detailW)}
            </Text>
          ) : null}
          {details(det)}
        </Box>
      );
    }
    const titleCell = truncateCells(title, leftW);
    const room = leftW - cellWidth(titleCell);
    const rest = tags.length > 0 && room > 0 ? `  ${tags.join('  ')}` : '';
    const pad = valW > 0;
    // With a value column, the left part is padded so values line up down the list.
    const restCell = pad ? padCells(rest, room) : truncateCells(rest, room);
    return (
      <Box key={i} flexDirection="column">
        <Text wrap="truncate">
          {ordinal(i)}
          <Text bold color={theme.color.text}>
            {titleCell}
          </Text>
          <Text color={theme.color.dim}>{restCell}</Text>
          {pad ? (
            <Text color={theme.color.text}>
              {`  ${padCells(truncateCells(value || '—', valW), valW, true)}`}
            </Text>
          ) : null}
        </Text>
        {details(det)}
      </Box>
    );
  });
}

/** Below this width a grouped aggregate puts each value on the line under its key. */
const STACK_GROUPS_AT = 40;

const rows: Renderer = ({ data, theme, size }) => {
  const titleCols = titleWidth(size.columns);
  const o = data as RowsReply;
  const view = o.tui;
  const lost = droppedLines(o.dropped).map((l, i) => (
    <Text key={`d${i}`} color={theme.color.warn}>{`  ${l}`}</Text>
  ));
  const agg = o.aggregate;
  if (agg !== undefined) {
    const head = `${Object.hasOwn(FN_LABEL, agg.fn) ? FN_LABEL[agg.fn] : str(agg.fn)} ${str(agg.field)}`;
    const errs = errorLines(o.errors).map((l, i) => (
      <Text key={`e${i}`} color={theme.color.error}>{`  ${l}`}</Text>
    ));
    if (agg.groups === undefined) {
      return (
        <Box flexDirection="column">
          <Text
            color={theme.color.text}
          >{`${head} = ${aggValue(agg.value, view, agg.field)}`}</Text>
          {errs}
          {lost}
        </Box>
      );
    }
    const keyCols = Math.min(30, Math.max(COLS.minTitle, Math.floor(size.columns / 3)));
    const groups = agg.groups.filter((g) => g.key === null || g.value !== null);
    const values = groups.map((g) => aggValue(g.value, view, agg.field));
    const valW = valueWidth(values, size.columns);
    return (
      <Box flexDirection="column">
        <Text color={theme.color.dim}>{`${head} by ${str(agg.by)}`}</Text>
        {groups.length === 0 ? <Text color={theme.color.dim}>{'  no groups'}</Text> : null}
        {groups.map((g, i) =>
          size.columns <= STACK_GROUPS_AT ? (
            <Box key={i} flexDirection="column">
              <Text wrap="truncate" color={theme.color.dimMid}>
                {`  ${truncateCells(g.key === null ? '(none)' : str(g.key), Math.max(1, size.columns - 2))}`}
              </Text>
              <Text wrap="truncate" color={theme.color.text}>
                {`    ${truncateCells(values[i] ?? '', Math.max(1, size.columns - 4))}`}
              </Text>
            </Box>
          ) : (
            <Text key={i} wrap="truncate">
              {'  '}
              <Text color={theme.color.dimMid}>
                {padCells(g.key === null ? '(none)' : str(g.key), keyCols)}
              </Text>
              {'  '}
              <Text color={theme.color.text}>
                {padCells(truncateCells(values[i] ?? '', valW), valW, true)}
              </Text>
            </Text>
          )
        )}
        {agg.truncated === true ? <Text color={theme.color.dim}>{'  …more groups'}</Text> : null}
        {errs}
        {lost}
      </Box>
    );
  }
  if (!Array.isArray(o.data) && typeof o.count === 'number') {
    return (
      <Box flexDirection="column">
        <Text color={theme.color.text}>{o.count}</Text>
        {lost}
      </Box>
    );
  }
  if (!Array.isArray(o.data)) {
    return (
      <Box flexDirection="column">
        <Text color={theme.color.error}>{theme.glyph.fail} rejected</Text>
        {errorLines(o.errors).map((l, i) => (
          <Text key={i} color={theme.color.error}>{`  ${l}`}</Text>
        ))}
      </Box>
    );
  }
  const list = o.data as Record<string, unknown>[];
  if (list.length === 0 && lost.length === 0) return <Text color={theme.color.dim}>no rows</Text>;
  if (view?.row !== undefined) {
    return (
      <Box flexDirection="column">
        {declaredRows(list, view.row, view, theme, size.columns)}
        {lost}
      </Box>
    );
  }
  // Rows without the context-store columns (status, project) get a label and field=value details.
  if (!list.some((r) => 'status' in r || 'project' in r)) {
    const asked = askedFields(o.frame);
    const labelCols = Math.min(40, Math.max(COLS.minTitle, Math.floor(size.columns / 3)));
    const detailCols = Math.max(COLS.minTitle, size.columns - (COLS.id + labelCols + 4));
    return (
      <Box flexDirection="column">
        {list.map((row, i) => {
          const r = withWalked(row);
          const label = labelField(r);
          return (
            <Text key={i}>
              <Text color={theme.color.dim}>{padCells(str(r.shortId ?? r.id), COLS.id, true)}</Text>
              {'  '}
              <Text color={theme.color.text}>
                {padCells(label !== undefined ? shown(r, label, view) : '', labelCols)}
              </Text>
              {'  '}
              <Text color={theme.color.dimMid}>
                {padCells(detailList(r, asked, label, view).join('  '), detailCols)}
              </Text>
            </Text>
          );
        })}
        {lost}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {list.length === 0 ? <Text color={theme.color.dim}>no rows</Text> : null}
      {list.map((r, i) => (
        <Text key={i}>
          <Text color={theme.color.dim}>{padCells(str(r.shortId ?? r.id), COLS.id, true)}</Text>
          {'  '}
          <Text color={theme.color.text}>
            {padCells(str(r.title ?? r.synopsis ?? r.name ?? r.topic ?? r.subject), titleCols)}
          </Text>
          {'  '}
          <Text color={theme.color.info}>{padCells(str(r.status), COLS.status)}</Text>
          {'  '}
          <Text color={theme.color.dimMid}>{padCells(str(r.project), COLS.project)}</Text>
        </Text>
      ))}
      {lost}
    </Box>
  );
};

const unknown: Renderer = ({ data, theme }) => {
  const o = data as Unknown;
  return (
    <Box flexDirection="column">
      <Text color={theme.color.warn}>? unknown: not answered, because part of it was dropped</Text>
      {droppedLines(o.dropped).map((l, i) => (
        <Text key={i} color={theme.color.warn}>{`  ${l}`}</Text>
      ))}
    </Box>
  );
};

const recall: Renderer = ({ data, theme }) => {
  const o = data as Recall;
  if (o.hits === undefined) {
    return (
      <Box flexDirection="column">
        <Text color={theme.color.error}>{theme.glyph.fail} recall rejected</Text>
        {errorLines(o.errors).map((l, i) => (
          <Text key={i} color={theme.color.error}>{`  ${l}`}</Text>
        ))}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color={theme.color.query}>
        {theme.glyph.query} recall · {o.hits.length} hits
      </Text>
      {(o.hits as Record<string, unknown>[]).map((h, i) => (
        <Text key={i}>
          {'  '}
          {padCells(str(h.type), 14)} {padCells(str(h.id), 38)} {Number(h.score ?? 0).toFixed(2)}
        </Text>
      ))}
    </Box>
  );
};

const clarify: Renderer = ({ data, theme }) => {
  const o = data as Clarify;
  return (
    <Box flexDirection="column">
      <Text color={theme.color.warn}>? {str(o.reason)}</Text>
      {o.options.map((opt, i) => (
        <Text key={i}>
          {'  '}
          {i + 1}. {str(opt.label)}
        </Text>
      ))}
      {o.options.length > 0 ? (
        <Text color={theme.color.dim}>
          {'  '}press 1–{Math.min(9, o.options.length)} to choose
        </Text>
      ) : null}
    </Box>
  );
};

const refuse: Renderer = ({ data, theme }) => (
  <Text color={theme.color.warn}>
    {theme.glyph.fail} {str((data as Refuse).reason)}
  </Text>
);
const line: Renderer = ({ data, theme }) => <Text color={theme.color.dim}>{str(data)}</Text>;
const error: Renderer = ({ data, theme }) => (
  <Text color={theme.color.error}>
    {theme.glyph.fail} {str(data)}
  </Text>
);

export const renderers: Record<string, Renderer> = {
  [KIND.line]: line,
  [KIND.rows]: rows,
  [KIND.recall]: recall,
  [KIND.clarify]: clarify,
  [KIND.refuse]: refuse,
  [KIND.unknown]: unknown,
  [KIND.error]: error
};

/** A declared row's details: its walked values, then each declared detail, labelled when numeric. */
function declaredDetails(r: Record<string, unknown>, row: RowView, view: TypeView): string[] {
  return [
    ...walkedDetails(r),
    ...row.details.map((e) => {
      const v = cell(r, e, view);
      if (v === '') return '';
      const label =
        e.label ??
        (typeof own(r, e.field) === 'number' || isNumericFormat(own(view.formats, e.field))
          ? e.field
          : undefined);
      return label === undefined ? v : `${sanitise(label)} ${v}`;
    })
  ].filter((d) => d !== '');
}

/**
 * A rows answer as a list for the pager, or undefined when it is not a plain list of rows (an
 * aggregate, a count, a rejected frame). Declared rows keep their title, tags, details and value;
 * the rest get a label and the asked-about fields, then the others, as `field=value`.
 */
export function rowsList(o: RowsReply): ListSpec | undefined {
  if (!Array.isArray(o.data) || o.aggregate !== undefined || o.count !== undefined)
    return undefined;
  const view = o.tui;
  const asked = askedFields(o.frame);
  const rows: ListRow[] = (o.data as Record<string, unknown>[]).map((raw, i) => {
    const r = withWalked(raw);
    const key = typeof raw.id === 'string' ? raw.id : String(i);
    const decl = view?.row;
    if (view !== undefined && decl !== undefined) {
      const f = decl.title?.field ?? labelField(r);
      const value = decl.value === undefined ? '' : cell(r, decl.value, view);
      return {
        key,
        name: (f === undefined ? '' : cell(r, decl.title ?? { field: f }, view)) || '—',
        details: [
          ...decl.tags.map((e) => cell(r, e, view)).filter((t) => t !== ''),
          ...declaredDetails(r, decl, view)
        ],
        ...(value !== '' ? { value } : {})
      };
    }
    const label = labelField(r);
    return {
      key,
      name: (label !== undefined ? shown(r, label, view) : '') || str(r.shortId ?? r.id) || '—',
      details: detailList(r, asked, label, view)
    };
  });
  const notes = [...errorLines(o.errors), ...droppedLines(o.dropped)];
  return { heading: frameKey(o), rows, ...(notes.length > 0 ? { notes } : {}) };
}
