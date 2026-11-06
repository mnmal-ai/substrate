import { EventEmitter } from 'node:events';
import type { NlOutcome } from '@mnmal-ai/substrate/sdk';
import { cellWidth } from '@mnmal-ai/surface-kit';
import { marathon } from '@mnmal-ai/surface-theme';
import { Box, render as inkRender } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { TypeView } from '../src/ask/present.js';
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
  it('unknown renders with its dropped list', () => {
    const f = show(KIND.unknown, {
      kind: 'unknown',
      question: 'how many cards with island size in the past 2 days',
      dropped: [{ span: 'past 2 days', reason: 'it windows Island', kind: 'filter' }],
      plan: []
    });
    expect(f).toMatch(/unknown/);
    expect(f).toMatch(/dropped "past 2 days": it windows Island/);
  });
  it('rows show what was dropped; a server count shows the number', () => {
    const lost = [{ span: 'latest', reason: 'conflicts', kind: 'order' as const }];
    expect(show(KIND.rows, rows({ dropped: lost }))).toMatch(/dropped "latest": conflicts/);
    const n = rows({ answer: 'count', data: { count: 42 }, count: 42 });
    expect(show(KIND.rows, n)).toMatch(/42/);
    expect(show(KIND.rows, n)).not.toMatch(/rejected/);
    expect(outcomeChips(n).map((c) => c.label)).toContain('count 42');
  });
  it('an aggregate shows "fn field = value", and groups as a two-column list, sanitised', () => {
    const one = rows({
      answer: 'aggregate',
      data: { groups: [{ value: 123.45 }] },
      aggregate: { fn: 'avg', field: 'price', value: 123.45 }
    });
    expect(show(KIND.rows, one)).toMatch(/average price = 123\.45/);
    expect(outcomeChips(one).map((c) => c.label)[2]).toBe('aggregate');
    const grouped = show(
      KIND.rows,
      rows({
        answer: 'aggregate',
        data: { groups: [] },
        aggregate: {
          fn: 'sum',
          field: 'price',
          by: 'condition',
          groups: [
            { key: 'new\u001b[31m', value: 15 },
            { key: false, value: null }
          ]
        }
      })
    );
    expect(grouped).toMatch(/total price by condition/);
    expect(grouped).toMatch(/new\s+15/);
    // A group with no value is hidden; the no-key group is the server's to omit.
    expect(grouped).not.toMatch(/false/);
    expect(grouped).not.toContain('\u001b[31m');
  });
  it('an aggregate shows the no-value group as (none), rounds floats, and shows errors', () => {
    const f = show(
      KIND.rows,
      rows({
        answer: 'aggregate',
        data: { groups: [] },
        aggregate: {
          fn: 'avg',
          field: 'price',
          by: 'condition',
          groups: [
            { key: 'new', value: 12.333333333333334 },
            { key: null, value: 4 }
          ]
        }
      })
    );
    expect(f).toMatch(/new\s+12\.33\b/);
    expect(f).not.toMatch(/12\.333/);
    expect(f).toMatch(/\(none\)\s+4/);
    const odd = show(
      KIND.rows,
      rows({
        answer: 'aggregate',
        data: { groups: [] },
        errors: [{ code: 'partial', message: 'one group failed' }],
        aggregate: { fn: 'constructor' as 'avg', field: 'price', value: 1 }
      })
    );
    expect(odd).toMatch(/constructor price = 1/);
    expect(odd).not.toMatch(/function/);
    expect(odd).toMatch(/partial: one group failed/);
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

const ITEM_VIEW: TypeView = {
  currency: 'USD',
  formats: { price: 'money', ask: 'money', margin: 'pct', stock: 'int' },
  row: {
    title: { field: 'name' },
    tags: [{ field: 'grade', template: 'G{}' }],
    value: { field: 'price' },
    details: [{ field: 'ask', label: 'ask' }, { field: 'stock' }, { field: 'seller' }]
  }
};
const items = (data: unknown[], view: TypeView = ITEM_VIEW) =>
  ({ ...rows({ frame: { 'shop/Item': { params: {}, fields: {} } }, data }), tui: view }) as unknown;

describe('a walked ordering value (_agg)', () => {
  const ordered = {
    params: {
      derive: { maxItemPrice: { value: '_agg.maxItemPrice' } },
      orderBy: [{ $maxItemPrice: 'desc' }]
    },
    fields: {}
  };
  const data = [
    { id: 's1', name: 'Acme', rating: 4, _agg: { maxItemPrice: 40 } },
    { id: 's2', name: 'Bolt\u001b[2J', rating: 2, _agg: { maxItemPrice: null } }
  ];
  it('the generic view shows it first, as name=value, sanitised', () => {
    const f = show(KIND.rows, rows({ frame: { 'shop/Supplier': ordered }, data }));
    expect(f).toMatch(/Acme\s+maxItemPrice=40 {2}rating=4/);
    expect(f).toMatch(/Bolt\s+rating=2/);
    expect(f).not.toContain('\u001b');
  });
  it('the declared view adds it to the details line', () => {
    const view: TypeView = {
      currency: 'USD',
      formats: {},
      row: { title: { field: 'name' }, tags: [], details: [{ field: 'rating', label: 'rating' }] }
    };
    const f = show(
      KIND.rows,
      { ...(rows({ frame: { 'shop/Supplier': ordered }, data }) as object), tui: view },
      80
    );
    expect(f.split('\n')).toEqual([
      expect.stringMatching(/^ 1 {2}Acme/),
      '      maxItemPrice 40 · rating 4',
      expect.stringMatching(/^ 2 {2}Bolt/),
      '      rating 2'
    ]);
  });
});

describe('declared rows (annotations.tui)', () => {
  it('line 1: dim ordinal, title, tag chips, value right-aligned; line 2: details', () => {
    const f = show(
      KIND.rows,
      items([
        {
          id: 'a',
          name: 'Blue Kettle',
          grade: 9,
          price: 84,
          ask: 412,
          stock: 1200,
          seller: 'Acme'
        },
        { id: 'b', name: 'Red Mug', grade: 10, price: 1234.5, ask: null, stock: 3, seller: '' }
      ]),
      80
    );
    const lines = f.split('\n');
    expect(lines[0]).toMatch(/^ 1 {2}Blue Kettle {2}G9 +\$84\.00$/);
    expect(lines[1]).toBe('      ask $412.00 · stock 1,200 · Acme');
    expect(lines[2]).toMatch(/^ 2 {2}Red Mug {2}G10 +\$1,234\.50$/);
    expect(lines[3]).toBe('      stock 3');
    // Values end in one column, at the right edge.
    expect(lines[0]?.length).toBe(80);
    expect(lines[2]?.length).toBe(80);
  });
  it('an empty title or value shows —; rows without details take one line', () => {
    const view: TypeView = {
      ...ITEM_VIEW,
      row: { title: { field: 'name' }, tags: [], value: { field: 'price' }, details: [] }
    };
    const f = show(KIND.rows, items([{ id: 'a', name: null, price: null }], view), 40);
    expect(f.split('\n')).toEqual([expect.stringMatching(/^ 1 {2}— +—$/)]);
  });
  it('a long title truncates instead of wrapping', () => {
    const f = show(
      KIND.rows,
      items([{ id: 'a', name: 'x'.repeat(200), price: 1, ask: 'y'.repeat(200) }]),
      50
    );
    expect(f.split('\n').every((l) => l.length <= 50)).toBe(true);
    expect(f.split('\n').length).toBe(2);
  });
  it('templates, labels and values are sanitised', () => {
    const view: TypeView = {
      currency: 'USD',
      formats: {},
      row: {
        title: { field: 'name' },
        tags: [{ field: 'g', template: '\u001b[31m{}' }],
        details: [{ field: 'n', label: 'l\u001b[2J' }]
      }
    };
    const f = show(KIND.rows, items([{ id: 'a', name: 'n\u001b[0m', g: 1, n: 2 }], view));
    expect(f).not.toContain('\u001b[31m');
    expect(f).not.toContain('\u001b[2J');
    expect(f).not.toContain('\u001b[0m');
  });
  it('a type with formats but no row declaration keeps the generic view, formatted', () => {
    const f = show(
      KIND.rows,
      items([{ id: 'a', name: 'Blue Kettle', price: 1234.5, margin: 12.5 }], {
        currency: 'USD',
        formats: ITEM_VIEW.formats
      })
    );
    expect(f).toMatch(/Blue Kettle\s+price=\$1,234\.50 {2}margin=12\.5%/);
  });
  it('an aggregate formats its value and its groups by the field format', () => {
    const view: TypeView = { currency: 'USD', formats: { ask: 'money' } };
    const one = {
      ...rows({
        answer: 'aggregate',
        data: { groups: [] },
        aggregate: { fn: 'avg', field: 'ask', value: 909.8666 }
      }),
      tui: view
    };
    expect(show(KIND.rows, one)).toMatch(/average ask = \$909\.87/);
    const grouped = {
      ...rows({
        answer: 'aggregate',
        data: { groups: [] },
        aggregate: {
          fn: 'sum',
          field: 'ask',
          by: 'seller',
          groups: [
            { key: 'Acme', value: 1500 },
            { key: 'Other', value: null },
            { key: null, value: 2 }
          ]
        }
      }),
      tui: view
    };
    const g = show(KIND.rows, grouped);
    expect(g).toMatch(/Acme\s+\$1,500\.00/);
    expect(g).toMatch(/\(none\)\s+\$2\.00/);
    expect(g).not.toMatch(/Other/);
  });
  it('one long value is capped at a third of the width, so titles survive', () => {
    const f = show(
      KIND.rows,
      items([
        {
          id: 'a',
          name: 'Teapot',
          price: 'call for price — ask the supplier about bulk discounts please'
        },
        { id: 'b', name: 'Red Mug', price: 3 }
      ]),
      60
    );
    const lines = f.split('\n');
    expect(lines.every((l) => cellWidth(l) <= 60)).toBe(true);
    expect(lines[0]).toMatch(/^ 1 {2}Teapot +call for price.*…$/);
    expect(lines.find((l) => l.startsWith(' 2'))).toMatch(/^ 2 {2}Red Mug +\$3\.00$/);
  });
  it('a $ pattern in a value is not a replacement pattern in the template', () => {
    const view: TypeView = {
      currency: 'USD',
      formats: {},
      row: { title: { field: 'name' }, tags: [{ field: 'g', template: '{}!' }], details: [] }
    };
    expect(show(KIND.rows, items([{ id: 'a', name: 'x', g: 'a$&b$$c' }], view))).toContain(
      'a$&b$$c!'
    );
  });
  it('an entry naming a list or object field is treated as empty', () => {
    const view: TypeView = {
      currency: 'USD',
      formats: {},
      row: { title: { field: 'name' }, tags: [], value: { field: 'v' }, details: [{ field: 'l' }] }
    };
    const f = show(
      KIND.rows,
      items([{ id: 'a', name: 'x', v: { a: 1 }, l: ['p', 'q'] }], view),
      40
    );
    expect(f).not.toMatch(/object|p,q/);
    expect(f.split('\n')).toEqual([expect.stringMatching(/^ 1 {2}x +—$/)]);
  });
  it('a non-numeric value under a numeric format shows raw in the declared view', () => {
    expect(show(KIND.rows, items([{ id: 'a', name: 'x', price: 'n/a' }]), 40)).toMatch(/x +n\/a$/);
  });
  it('a wide-character title at 40 columns keeps every line within the width', () => {
    const f = show(
      KIND.rows,
      items([{ id: 'a', name: '青い急須'.repeat(8), grade: 1, price: 84, ask: 1 }]),
      40
    );
    expect(f.split('\n').every((l) => cellWidth(l) <= 40)).toBe(true);
    expect(f).toMatch(/\$84\.00/);
  });
  it('grouped values are right-aligned; all-null groups say no groups', () => {
    const agg = (groups: { key: string | null; value: number | null }[]) => ({
      ...rows({
        answer: 'aggregate',
        data: { groups: [] },
        aggregate: { fn: 'sum', field: 'ask', by: 'seller', groups }
      }),
      tui: { currency: 'USD', formats: { ask: 'money' } }
    });
    const lines = show(
      KIND.rows,
      agg([
        { key: 'Acme', value: 1500 },
        { key: 'Globex', value: 2 }
      ])
    )
      .split('\n')
      .slice(1);
    expect((lines[0]?.indexOf('$1,500.00') ?? 0) + '$1,500.00'.length).toBe(
      (lines[1]?.indexOf('$2.00') ?? 0) + '$2.00'.length
    );
    expect(show(KIND.rows, agg([{ key: 'Acme', value: null }]))).toMatch(/no groups/);
  });
});

/** ink-testing-library's stdout is fixed at 100 columns; this one is `columns` wide and can be resized. */
function renderAt(columns: number, node: (columns: number) => ReactElement) {
  let last = '';
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    write: (f: string) => {
      last = f;
    }
  });
  const ink = inkRender(node(columns), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false
  });
  return {
    unmount: () => ink.unmount(),
    lastFrame: () => last,
    resize(c: number) {
      stdout.columns = c;
      ink.rerender(node(c));
    }
  };
}

describe('responsive declared rows', () => {
  const view: TypeView = {
    currency: 'USD',
    formats: { price: 'money', ask: 'money' },
    row: {
      title: { field: 'name' },
      tags: [{ field: 'grade', template: 'G{}' }, { field: 'cond' }],
      value: { field: 'price' },
      details: [{ field: 'ask', label: 'ask' }]
    }
  };
  const data = [
    {
      id: 'a',
      name: 'Blue Kettle with a Long Name',
      grade: 10,
      cond: 'Near Mint',
      price: 1234.5,
      ask: 412
    },
    { id: 'b', name: 'Red Mug', grade: 9, cond: 'Used', price: 84, ask: null }
  ];
  const frame = (columns: number) => (
    <Box>
      {renderers[KIND.rows]?.({ data: items(data, view), theme: marathon, size: { columns } })}
    </Box>
  );
  const WIDE = [
    /^ 1 {2}Blue Kettle with a Long Name {2}G10 {2}Near Mint +\$1,234\.50$/,
    /^ {6}ask \$412\.00$/,
    /^ 2 {2}Red Mug {2}G9 {2}Used +\$84\.00$/
  ];
  const STACKED = [
    ' 1  Blue Kettle with a Long Name',
    '      G10 · Near Mint · $1,234.50',
    '      ask $412.00',
    ' 2  Red Mug',
    '      G9 · Used · $84.00'
  ];
  it('lays the list out wide at 120 columns', () => {
    const r = renderAt(120, frame);
    const lines = r.lastFrame().split('\n');
    r.unmount();
    expect(lines).toHaveLength(3);
    for (const [i, re] of WIDE.entries()) expect(lines[i]).toMatch(re);
  });
  it('stacks every row at 50 columns: title, then tags · value, then details', () => {
    expect(show(KIND.rows, items(data, view), 50).split('\n')).toEqual(STACKED);
  });
  it('re-lays out when the terminal narrows', () => {
    const r = renderAt(120, frame);
    expect(r.lastFrame()?.split('\n')[0]).toMatch(WIDE[0] as RegExp);
    r.resize(50);
    expect(r.lastFrame()?.split('\n')).toEqual(STACKED);
    r.unmount();
  });
  it('a grouped aggregate at 40 columns puts each value under its key', () => {
    const f = show(
      KIND.rows,
      {
        ...rows({
          answer: 'aggregate',
          data: { groups: [] },
          aggregate: {
            fn: 'sum',
            field: 'ask',
            by: 'seller',
            groups: [
              { key: 'Acme', value: 1500 },
              { key: null, value: 2 }
            ]
          }
        }),
        tui: { currency: 'USD', formats: { ask: 'money' } }
      },
      40
    );
    expect(f.split('\n')).toEqual([
      'total ask by seller',
      '  Acme',
      '    $1,500.00',
      '  (none)',
      '    $2.00'
    ]);
  });
});
