import type { NlApi } from '@mnmal-ai/substrate/client';
import type { NlServedPack, Schema } from '@mnmal-ai/substrate/sdk';
import { assertComposes, createApp } from '@mnmal-ai/surface-core';
import { marathon } from '@mnmal-ai/surface-theme';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { TuiDeps } from '../src/deps.js';
import { schemaModule } from '../src/schema/module.js';
import { noAdmin, noDash } from './_fakes.js';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const ENTER = '\r';
const ESC = '\u001B';
const DOWN = '\u001B[B';
const BACKSPACE = '\u007F';

const sch = (types: Schema['types']): Schema => ({
  schemaVersion: 'v',
  mutations: {},
  types
});
const SCHEMA: Record<string, Schema> = {
  journal: sch({
    Todo: {
      fields: {
        title: { kind: 'scalar', type: 'string', indexed: true },
        status: { kind: 'scalar', type: 'string', enum: ['open', 'closed'] }
      }
    },
    Decision: { fields: { title: { kind: 'scalar', type: 'string' } } }
  }),
  plane: sch({ Note: { fields: { body: { kind: 'scalar', type: 'string' } } } })
};
const PACK: NlServedPack = {
  namespace: 'journal',
  schemaVersion: 'v',
  values: {},
  rulings: {},
  warnings: [],
  types: {
    Todo: {
      name: 'Todo',
      phrases: ['todo'],
      fields: {
        status: {
          name: 'status',
          kind: 'scalar',
          valueType: 'string',
          indexed: true,
          operators: ['eq', 'neq'],
          phrases: ['status'],
          enum: ['open', 'closed']
        }
      }
    }
  }
};

function fake(federated: () => Promise<Record<string, Schema>> = async () => SCHEMA) {
  const nl: NlApi = {
    async *ask() {},
    askJson: async () => ({ outcome: null, trail: [] }),
    pack: async (ns) => {
      if (ns !== 'journal') throw new Error('no substrate-nl');
      return PACK;
    }
  };
  const deps: TuiDeps = {
    endpoint: 'http://h',
    project: 'substrate',
    namespace: 'journal',
    nl,
    federatedSchema: federated,
    ...noDash,
    ...noAdmin(),
    getJson: async () => ({})
  };
  return deps;
}
function start(deps: TuiDeps) {
  const { App } = createApp({ theme: marathon, modules: [schemaModule(deps)] });
  const r = render(<App columns={120} />);
  const frame = () => r.lastFrame() ?? '';
  const run = async (line: string) => {
    r.stdin.write(line);
    await tick();
    r.stdin.write(ENTER);
    // From the palette, Enter runs a command whose arguments are all optional.
    await tick(80);
  };
  return { ...r, frame, run };
}

describe('substrate.schema', () => {
  it('composes', () => {
    expect(() => assertComposes([schemaModule(fake())])).not.toThrow();
  });
  it('/schema lists the namespaces', async () => {
    const app = start(fake());
    await app.run('/schema');
    expect(app.frame()).toContain('journal');
    expect(app.frame()).toContain('plane');
  });
  it('down+enter drills into plane, backspace returns to the list', async () => {
    const app = start(fake());
    await app.run('/schema');
    app.stdin.write(DOWN);
    await tick();
    app.stdin.write(ENTER);
    await tick();
    expect(app.frame()).toContain('plane · types');
    expect(app.frame()).toContain('Note');
    app.stdin.write(BACKSPACE);
    await tick();
    expect(app.frame()).toContain('namespaces');
    expect(app.frame()).toContain('journal');
  });
  it('/schema journal Todo opens on the fields, with enum and pack operators', async () => {
    const app = start(fake());
    await app.run('/schema journal Todo');
    await tick(60);
    const f = app.frame();
    expect(f).toContain('journal/Todo · fields');
    expect(f).toMatch(/status .*enum: open, closed/);
    expect(f).toMatch(/status .*ops: eq neq/);
    expect(f).toMatch(/title .*indexed/);
  });
  it('escape closes the panel', async () => {
    const app = start(fake());
    await app.run('/schema');
    app.stdin.write(ESC);
    await tick();
    expect(app.frame()).not.toContain('namespaces');
  });
  it('an unknown namespace prints a warning and opens no panel', async () => {
    const app = start(fake());
    await app.run('/schema nope');
    expect(app.frame()).toContain("unknown namespace 'nope'");
    expect(app.frame()).not.toContain('types');
  });
  it('an unknown type prints a warning', async () => {
    const app = start(fake());
    await app.run('/schema journal Nope');
    expect(app.frame()).toContain("unknown type 'Nope' in journal");
  });
  it('a rejecting federatedSchema prints schema unavailable and opens no panel', async () => {
    const app = start(
      fake(async () => {
        throw new Error('boom');
      })
    );
    await app.run('/schema');
    expect(app.frame()).toContain('schema unavailable: boom');
    expect(app.frame()).not.toContain('namespaces');
  });
  it('the view strips terminal escapes from server-supplied names', () => {
    const mod = schemaModule(fake());
    const evil = '\x1b]0;x\x07';
    const out = mod.panels?.schema.view({
      state: {
        level: 'field',
        ns: 'journal',
        type: 'Todo',
        cursor: 0,
        schema: {
          journal: sch({
            Todo: { fields: { [`f${evil}`]: { kind: 'scalar', type: 'string', enum: [evil] } } }
          })
        }
      },
      theme: marathon,
      size: { rows: 30, columns: 120 }
    });
    const text = String(out);
    expect(text).toContain('f');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
    expect(text).not.toMatch(/[\x1b\x07]/);
  });
  it('a type named like an Object.prototype member renders its fields, with a pack present', () => {
    const mod = schemaModule(fake());
    const out = mod.panels?.schema.view({
      state: {
        level: 'field',
        ns: 'journal',
        type: 'constructor',
        cursor: 0,
        schema: {
          journal: sch({
            constructor: { fields: { name: { kind: 'scalar' as const, type: 'string' as const } } }
          })
        },
        pack: PACK
      },
      theme: marathon,
      size: { rows: 30, columns: 120 }
    });
    const text = String(out);
    expect(text).not.toMatch(/view failed|Cannot read/);
    expect(text).toContain('name');
  });
  it('windows the list to size.rows - 2 and scrolls to keep the cursor visible', () => {
    const mod = schemaModule(fake());
    const fields = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `f${String(i).padStart(2, '0')}`,
        { kind: 'scalar' as const, type: 'string' as const }
      ])
    );
    const view = (cursor: number, size = { rows: 10, columns: 120 }) =>
      String(
        mod.panels?.schema.view({
          state: {
            level: 'field',
            ns: 'journal',
            type: 'Todo',
            cursor,
            schema: { journal: sch({ Todo: { fields } }) }
          },
          theme: marathon,
          size
        })
      );
    const top = view(0).split('\n');
    expect(top.filter((l) => /f\d\d/.test(l))).toHaveLength(8);
    const down = view(20);
    const items = down.split('\n').filter((l) => /f\d\d/.test(l));
    expect(items).toHaveLength(8);
    expect(items[0]).toContain('f13');
    expect(items.find((l) => l.includes('f20'))).toContain(marathon.glyph.cursor);
    expect(view(39)).toContain('f39');
    const one = view(5, { rows: 2, columns: 120 })
      .split('\n')
      .filter((l) => /f\d\d/.test(l));
    expect(one).toHaveLength(1);
    expect(one[0]).toContain('f05');
    const narrow = view(5, { rows: 10, columns: 30 }).split('\n');
    expect(narrow.every((l) => l.length <= 30)).toBe(true);
  });
});
