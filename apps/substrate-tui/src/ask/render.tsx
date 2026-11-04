import type { NlOutcome } from '@mnmal-ai/substrate/sdk';
import { type Chip, type Renderer, sanitise } from '@mnmal-ai/surface-core';
import { padCells } from '@mnmal-ai/surface-kit';
import { Box, Text } from 'ink';

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
        : `${o.count ?? (Array.isArray(o.data) ? o.data.length : 0)} rows`,
      tone: rejected ? 'error' : 'dim'
    }
  ];
}

// id + status + project + the three two-cell gaps; the title takes what is left of the width.
const COLS = { id: 6, status: 10, project: 14, gaps: 6, minTitle: 12 };
const titleWidth = (columns: number) =>
  Math.max(COLS.minTitle, columns - (COLS.id + COLS.status + COLS.project + COLS.gaps));

const rows: Renderer = ({ data, theme, size }) => {
  const titleCols = titleWidth(size.columns);
  const o = data as Rows;
  const lost = droppedLines(o.dropped).map((l, i) => (
    <Text key={`d${i}`} color={theme.color.warn}>{`  ${l}`}</Text>
  ));
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
