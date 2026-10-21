import type { NlOutcome } from '@mnmal-ai/substrate/sdk';
import { marathon } from '@mnmal-ai/surface-theme';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { KIND, outcomeChips, renderers } from '../src/ask/render.js';

const show = (kind: string, data: unknown, columns = 100) => {
  const R = renderers[kind];
  if (R === undefined) throw new Error(`no renderer ${kind}`);
  return render(<Box>{R({ data, theme: marathon, size: { columns } })}</Box>).lastFrame() ?? '';
};
const rows = (o: Partial<Extract<NlOutcome, { kind: 'rows' }>>): NlOutcome =>
  ({
    kind: 'rows',
    frame: { 'journal/Todo': { params: {} } },
    answer: 'rows',
    data: [],
    source: 'parser',
    ...o
  }) as NlOutcome;

describe('renderers', () => {
  it('rows render id, title, status and project', () => {
    const f = show(
      KIND.rows,
      rows({
        data: [{ id: 'u1', shortId: 12, title: 'Ship it', status: 'open', project: 'substrate' }]
      })
    );
    expect(f).toMatch(/12\s+Ship it\s+open\s+substrate/);
  });
  it('a rejected rows outcome (no data key) says rejected and shows errors, never 0 rows', () => {
    const o = rows({ errors: [{ code: 'forbidden', message: 'no read' }] });
    delete (o as { data?: unknown }).data;
    const f = show(KIND.rows, o);
    expect(f).toMatch(/rejected/);
    expect(f).toMatch(/forbidden/);
    expect(f).not.toMatch(/0 rows/);
  });
  it('recall lists hits; rejected recall says rejected', () => {
    expect(
      show(KIND.recall, {
        kind: 'recall',
        query: 'q',
        hits: [{ type: 'Decision', id: 'd1', score: 0.91 }]
      })
    ).toMatch(/Decision\s+d1\s+0\.91/);
    expect(
      show(KIND.recall, { kind: 'recall', query: 'q', hits: undefined, errors: [{ code: 'x' }] })
    ).toMatch(/rejected/);
  });
  it('clarify numbers its options; refuse shows the reason', () => {
    const c = show(KIND.clarify, {
      kind: 'clarify',
      question: 'q',
      reason: 'which?',
      options: [{ label: 'todos (Todo)', question: 'q', type: 'Todo' }]
    });
    expect(c).toMatch(/which\?/);
    expect(c).toMatch(/1\. todos \(Todo\)/);
    expect(show(KIND.refuse, { kind: 'refuse', reason: '"close" is an edit' })).toMatch(
      /"close" is an edit/
    );
  });
  it('chips name the frame, the source and the count', () => {
    expect(outcomeChips(rows({ data: [{}, {}], source: 'judge' })).map((c) => c.label)).toEqual([
      '▸ journal/Todo',
      'judge',
      '2 rows'
    ]);
    expect(
      outcomeChips(rows({ source: 'handoff', handoff: 'judge unavailable' })).map((c) => c.label)[1]
    ).toBe('handoff (judge unavailable)');
  });
  it('a very long title is truncated to its column, never wrapping the row', () => {
    const f = show(KIND.rows, rows({ data: [{ id: 'x', title: 'y'.repeat(300) }] }));
    expect(f.split('\n').every((l) => l.length <= 120)).toBe(true);
  });
  it('the title column takes the width left over', () => {
    const data = rows({
      data: [{ id: 'x', title: 'T'.repeat(64), status: 'open', project: 'substrate' }]
    });
    const narrow = show(KIND.rows, data, 60);
    expect(narrow.split('\n').every((l) => l.length <= 60)).toBe(true);
    const title = (narrow.split('\n')[0] ?? '').match(/T+…\s*/)?.[0] ?? '';
    expect(title.trimEnd()).toBe(`${'T'.repeat(23)}…`);
    expect(show(KIND.rows, data, 120)).toContain('T'.repeat(64));
  });
});
