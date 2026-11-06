import type { NlOutcome } from '@mnmal-ai/substrate/sdk';
import { type Chip, type Renderer, sanitise } from '@mnmal-ai/surface-core';
import { cellWidth, padCells, truncateCells } from '@mnmal-ai/surface-kit';
import { Box, Text } from 'ink';
import {
  type Entry,
  formatValue,
  isNumericFormat,
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
function labelField(r: Record<string, unknown>): string | undefined {
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
  for (const o of (params.orderBy as Array<Record<string, unknown>> | undefined) ?? [])
    Object.keys(o).forEach(add);
  walk(params.where);
  return out;
}

const empty = (v: unknown) => v === null || v === undefined || v === '';
/** A row's field as the view formats it, sanitised; '' when empty. */
const shown = (r: Record<string, unknown>, field: string, view: TypeView | undefined) =>
  empty(r[field])
    ? ''
    : view === undefined
      ? str(r[field])
      : sanitise(formatValue(r[field], view.formats[field], view.currency));
/** An entry's cell: its template around the formatted value; '' when the value is empty. */
const cell = (r: Record<string, unknown>, e: Entry, view: TypeView) => {
  const v = shown(r, e.field, view);
  return v === '' || e.template === undefined ? v : sanitise(e.template.replaceAll('{}', v));
};

const SKIP = new Set(['id', 'shortId']);
/** `field=value` for a row's scalar fields: the asked-about ones first, then the rest. */
function details(
  r: Record<string, unknown>,
  asked: string[],
  label: string | undefined,
  view: TypeView | undefined
): string {
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
    .map((k) => `${sanitise(k)}=${shown(r, k, view)}`)
    .join('  ');
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
    : view !== undefined && field !== undefined && view.formats[field] !== undefined
      ? sanitise(formatValue(v, view.formats[field], view.currency))
      : typeof v === 'number' && !Number.isInteger(v)
        ? String(Math.abs(v) >= 0.01 ? Math.round(v * 100) / 100 : Number(v.toPrecision(3)))
        : str(v);

type Theme = Parameters<Renderer>[0]['theme'];

/**
 * A declared type's list: per row a dim ordinal, the bold title, dim tag chips and the value
 * right-aligned in one column down the list, then an optional dim `·`-joined details line.
 * Rows truncate rather than wrap.
 */
function declaredRows(
  list: Record<string, unknown>[],
  row: RowView,
  view: TypeView,
  theme: Theme,
  columns: number
) {
  const ordW = String(list.length).length;
  const indent = ' '.repeat(1 + ordW + 2 + 2);
  const values = list.map((r) => (row.value === undefined ? '' : cell(r, row.value, view) || '—'));
  const valW = row.value === undefined ? 0 : Math.max(...values.map(cellWidth));
  const leftW = Math.max(1, columns - (1 + ordW + 2) - (valW > 0 ? valW + 2 : 0));
  const titleOf = (r: Record<string, unknown>) => {
    const f = row.title?.field ?? labelField(r);
    return (f === undefined ? '' : cell(r, row.title ?? { field: f }, view)) || '—';
  };
  return list.map((r, i) => {
    const title = titleOf(r);
    const tags = row.tags.map((e) => cell(r, e, view)).filter((t) => t !== '');
    const titleCell = truncateCells(title, leftW);
    const room = leftW - cellWidth(titleCell);
    const rest = tags.length > 0 && room > 0 ? `  ${tags.join('  ')}` : '';
    const pad = valW > 0;
    // With a value column, the left part is padded so values line up down the list.
    const restCell = pad ? padCells(rest, room) : truncateCells(rest, room);
    const det = row.details
      .map((e) => {
        const v = cell(r, e, view);
        if (v === '') return '';
        const label =
          e.label ??
          (typeof r[e.field] === 'number' || isNumericFormat(view.formats[e.field])
            ? e.field
            : undefined);
        return label === undefined ? v : `${sanitise(label)} ${v}`;
      })
      .filter((d) => d !== '');
    return (
      <Box key={i} flexDirection="column">
        <Text wrap="truncate">
          <Text color={theme.color.dim}>{` ${padCells(String(i + 1), ordW, true)}  `}</Text>
          <Text bold color={theme.color.text}>
            {titleCell}
          </Text>
          <Text color={theme.color.dim}>{restCell}</Text>
          {pad ? (
            <Text color={theme.color.text}>{`  ${padCells(values[i] ?? '', valW, true)}`}</Text>
          ) : null}
        </Text>
        {det.length > 0 ? (
          <Text wrap="truncate" color={theme.color.dim}>
            {indent + truncateCells(det.join(' · '), Math.max(1, columns - indent.length))}
          </Text>
        ) : null}
      </Box>
    );
  });
}

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
    return (
      <Box flexDirection="column">
        <Text color={theme.color.dim}>{`${head} by ${str(agg.by)}`}</Text>
        {agg.groups
          .filter((g) => g.key === null || g.value !== null)
          .map((g, i) => (
            <Text key={i}>
              {'  '}
              <Text color={theme.color.dimMid}>
                {padCells(g.key === null ? '(none)' : str(g.key), keyCols)}
              </Text>
              {'  '}
              <Text color={theme.color.text}>{aggValue(g.value, view, agg.field)}</Text>
            </Text>
          ))}
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
        {list.map((r, i) => {
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
                {padCells(details(r, asked, label, view), detailCols)}
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
