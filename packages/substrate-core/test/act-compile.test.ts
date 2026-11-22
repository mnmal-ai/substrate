/**
 * `compileSketch` over a schema published from core `Registry` instances, as
 * the engine publishes it. Core cannot import the SDK, so the fixture writes
 * its `FieldDef`s and autoCRUD mutation entries by hand.
 */

import type { ActHelp, ActionDecl, ActStep, FieldDef, Schema } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { type CompileOptions, compileSketch, publishSchema, Registry } from '../src/index.js';
import { withInboundRefs } from '../src/schema-publisher.js';

const str: FieldDef = { kind: 'scalar', type: 'string' };
const optStr: FieldDef = { kind: 'scalar', type: 'string', nullable: true };
const shortId: FieldDef = { kind: 'scalar', type: 'number', readonly: true };
const resolution: FieldDef = {
  kind: 'scalar',
  type: 'string',
  enum: ['completed', 'wont_do', 'superseded']
};

const todoFields: Record<string, FieldDef> = {
  title: str,
  status: {
    kind: 'scalar',
    type: 'string',
    enum: ['open', 'closed', 'deferred'],
    aliases: { done: 'closed', shut: 'closed' },
    implies: { done: { resolution: 'completed' } }
  },
  resolution: { ...resolution, nullable: true },
  archived: { kind: 'scalar', type: 'boolean', default: false },
  revisitWhen: optStr,
  notes: optStr,
  priority: { kind: 'scalar', type: 'string', enum: ['low', 'medium', 'high'], default: 'medium' },
  big: { kind: 'scalar', type: 'int64', nullable: true },
  shortId
};

const close: ActionDecl = {
  past: 'closed',
  params: { resolution: { type: resolution, default: 'completed' } },
  set: { status: 'closed', resolution: { param: 'resolution' }, archived: true }
};
const defer: ActionDecl = {
  past: 'deferred',
  params: { revisitWhen: { type: str } },
  set: { status: 'deferred', revisitWhen: { param: 'revisitWhen' } }
};
const log: ActionDecl = {
  kind: 'create',
  past: 'logged',
  params: {
    summary: { type: str },
    branch: { type: str },
    packages: { type: str, default: '' },
    body: { type: str, optional: true },
    closes: { list: 'work/Todo', optional: true }
  },
  set: {
    summary: { param: 'summary' },
    branch: { param: 'branch' },
    packages: { param: 'packages' },
    body: { param: 'body' },
    startedAt: { now: true },
    decisionsCount: 0,
    archived: false
  },
  // biome-ignore lint/suspicious/noThenProperty: `then` is the action declaration's key
  then: [{ action: 'work/Todo.close', each: { param: 'closes' } }]
};

type TypeSpec = { fields: Record<string, FieldDef>; actions?: Record<string, ActionDecl> };

function publish(ns: string, types: Record<string, TypeSpec>): Schema {
  const registry = new Registry();
  for (const [name, t] of Object.entries(types)) {
    registry.register(name, {
      kind: 'type',
      resolver: async () => [],
      fields: t.fields,
      ...(t.actions !== undefined ? { actions: t.actions } : {})
    });
    registry.register(`create${name}`, { kind: 'mutation', resolver: async () => [] });
    registry.register(`update${name}`, { kind: 'mutation', resolver: async () => [] });
  }
  return withInboundRefs(publishSchema(registry), ns);
}

function fixture(todoActions: Record<string, ActionDecl> = { close, defer }) {
  return {
    work: publish('work', {
      Todo: { fields: todoFields, actions: todoActions },
      Note: {
        fields: {
          title: str,
          todo: { kind: 'crossRef', ns: 'work', type: 'Todo', onDelete: 'set_null' },
          related: {
            kind: 'list',
            of: { kind: 'crossRef', ns: 'work', type: 'Todo', onDelete: 'set_null' },
            nullable: true
          }
        }
      }
    }),
    journal: publish('journal', {
      SessionLog: {
        fields: {
          summary: str,
          branch: str,
          startedAt: { kind: 'scalar', type: 'date' },
          decisionsCount: { kind: 'scalar', type: 'number' },
          packages: str,
          body: optStr,
          archived: { kind: 'scalar', type: 'boolean', default: false },
          shortId
        },
        actions: { log }
      }
    }),
    other: publish('other', { Todo: { fields: { title: str } } })
  };
}

const schema = fixture();
const opts: CompileOptions = {
  localNamespaces: new Set(['work', 'journal', 'other']),
  defaultNamespace: 'work'
};
const compile = (sketch: string | ActStep[], o: CompileOptions = opts, s = schema) =>
  compileSketch(sketch, s, o);

const todoWrite = { type: 'work/Todo', operation: 'mutate', fields: { id: true, shortId: true } };
const closeStep = (step: number, source: number, id: string, res = 'completed') => ({
  step,
  source,
  action: 'close',
  key: 'work/updateTodo',
  ...todoWrite,
  params: { id, status: 'closed', resolution: res, archived: true },
  past: 'closed'
});
const refusal = (step: number, token: string, problem: string, choices: string[] = []) => ({
  refusal: {
    code: 'sketch_unresolved',
    step,
    token,
    problem,
    choices,
    nearest: null as string | null
  }
});
const near = (r: ReturnType<typeof refusal>, nearest: string) => ({
  refusal: { ...r.refusal, nearest }
});

describe('compileSketch plans', () => {
  it('compiles a declared update action', () => {
    expect(compile('close Todo #2014')).toEqual({
      plan: {
        steps: [
          {
            step: 1,
            source: 1,
            action: 'close',
            type: 'work/Todo',
            key: 'work/updateTodo',
            operation: 'mutate',
            params: { id: '2014', status: 'closed', resolution: 'completed', archived: true },
            fields: { id: true, shortId: true },
            past: 'closed'
          }
        ]
      }
    });
  });

  it('makes one step per reference, with the param applied', () => {
    expect(compile('close Todo #1 #2 resolution=wont_do')).toEqual({
      plan: { steps: [closeStep(1, 1, '1', 'wont_do'), closeStep(2, 1, '2', 'wont_do')] }
    });
  });

  it('expands then across namespaces after a create action', () => {
    expect(compile('log SessionLog summary=s branch=b closes=#1,#2')).toEqual({
      plan: {
        steps: [
          {
            step: 1,
            source: 1,
            action: 'log',
            type: 'journal/SessionLog',
            key: 'journal/createSessionLog',
            operation: 'mutate',
            params: { summary: 's', branch: 'b', packages: '', decisionsCount: 0, archived: false },
            late: { startedAt: { now: true } },
            fields: { id: true, shortId: true },
            past: 'logged'
          },
          closeStep(2, 1, '1'),
          closeStep(3, 1, '2')
        ]
      }
    });
  });

  it('reads a bracketed list param as a comma list', () => {
    expect(compile('log SessionLog summary=s branch=b closes=[#1,#2]')).toEqual(
      compile('log SessionLog summary=s branch=b closes=#1,#2')
    );
    const one = compile('log SessionLog summary=s branch=b closes=[#1]');
    expect('plan' in one && one.plan.steps.slice(1)).toEqual([closeStep(2, 1, '1')]);
  });

  it('binds a record and late-binds its id in a later step', () => {
    expect(compile('create Todo title=x as $t; update Todo $t priority=high')).toEqual({
      plan: {
        steps: [
          {
            step: 1,
            source: 1,
            action: 'create',
            key: 'work/createTodo',
            ...todoWrite,
            params: { title: 'x' },
            bind: 't'
          },
          {
            step: 2,
            source: 2,
            action: 'update',
            key: 'work/updateTodo',
            ...todoWrite,
            params: { priority: 'high' },
            late: { id: { bind: 't' } }
          }
        ]
      }
    });
  });

  it('takes a binding, a shortId or a full id for a crossRef field', () => {
    const noteWrite = { type: 'work/Note', operation: 'mutate', fields: { id: true } };
    const result = compile(
      'create Todo title=x as $t; create Note title=n todo=$t; create Note title=m todo=#7; update Note n1 todo=abc-123'
    );
    expect(result).toEqual({
      plan: {
        steps: [
          {
            step: 1,
            source: 1,
            action: 'create',
            key: 'work/createTodo',
            ...todoWrite,
            params: { title: 'x' },
            bind: 't'
          },
          {
            step: 2,
            source: 2,
            action: 'create',
            key: 'work/createNote',
            ...noteWrite,
            params: { title: 'n' },
            late: { todo: { bind: 't' } }
          },
          {
            step: 3,
            source: 3,
            action: 'create',
            key: 'work/createNote',
            ...noteWrite,
            params: { title: 'm' },
            late: { todo: { ref: { type: 'work/Todo', shortId: 7 } } }
          },
          {
            step: 4,
            source: 4,
            action: 'update',
            key: 'work/updateNote',
            ...noteWrite,
            params: { id: 'n1', todo: 'abc-123' }
          }
        ]
      }
    });
  });

  it('compiles find with eq, in and a field selection', () => {
    expect(compile('find Todo status=open,closed priority=high fields=title')).toEqual({
      plan: {
        steps: [
          {
            step: 1,
            source: 1,
            action: 'find',
            type: 'work/Todo',
            key: 'work/Todo',
            operation: 'query',
            params: {
              where: { status: { in: ['open', 'closed'] }, priority: { eq: 'high' } },
              limit: 1000
            },
            fields: { id: true, shortId: true, title: true }
          }
        ]
      }
    });
  });

  it('compiles find references as a shortId or id filter', () => {
    const where = (sketch: string) => {
      const r = compile(sketch);
      return 'plan' in r ? r.plan.steps[0]?.params.where : r;
    };
    expect(where('find Todo #1 fields=title')).toEqual({ shortId: { eq: 1 } });
    expect(where('find Todo #1 #2 status=open')).toEqual({
      shortId: { in: [1, 2] },
      status: { eq: 'open' }
    });
    expect(where('find Note 3f2a-uuid')).toEqual({ id: { eq: '3f2a-uuid' } });
    expect(where('count Todo #3')).toEqual({ shortId: { eq: 3 } });
  });

  it('refuses find references it cannot turn into one filter', () => {
    expect(compile('find Todo #1 3f2a')).toEqual(
      refusal(1, '3f2a', 'find takes shortIds or ids, not both')
    );
    expect(compile('create Todo title=x as $t; find Todo $t')).toEqual(
      refusal(2, '$t', 'find takes no binding')
    );
    expect(compile('find Note #1')).toEqual(refusal(1, '#1', 'work/Note has no shortId'));
    expect(compile('find Todo #1 shortId=2')).toEqual(refusal(1, '#1', 'shortId is given twice'));
  });

  it('compiles count', () => {
    expect(compile('count Todo status=open')).toEqual({
      plan: {
        steps: [
          {
            step: 1,
            source: 1,
            action: 'count',
            type: 'work/Todo',
            key: 'work/Todo',
            operation: 'query',
            params: { where: { status: { eq: 'open' } }, count: true },
            fields: { id: true }
          }
        ]
      }
    });
  });

  it('keeps an int64 exact as a bigint', () => {
    const result = compile('update Todo #1 big=9007199254740993');
    expect(result).toEqual({
      plan: {
        steps: [
          {
            step: 1,
            source: 1,
            action: 'update',
            key: 'work/updateTodo',
            ...todoWrite,
            params: { id: '1', big: 9007199254740993n }
          }
        ]
      }
    });
    expect('plan' in result && result.plan.steps[0]?.params.big).toBe(9007199254740993n);
  });

  // The write path and the list resolver normalise an alias and read its implications from the raw value.
  it('keeps a vocabulary alias raw', () => {
    expect(compile('update Todo #1 status=Shut')).toEqual({
      plan: {
        steps: [
          {
            step: 1,
            source: 1,
            action: 'update',
            key: 'work/updateTodo',
            ...todoWrite,
            params: { id: '1', status: 'Shut' }
          }
        ]
      }
    });
  });

  it('leaves an alias implication to the write path and the list resolver', () => {
    expect(compile('update Todo #1 status=done; find Todo status=done')).toEqual({
      plan: {
        steps: [
          {
            step: 1,
            source: 1,
            action: 'update',
            key: 'work/updateTodo',
            ...todoWrite,
            params: { id: '1', status: 'done' }
          },
          {
            step: 2,
            source: 2,
            action: 'find',
            type: 'work/Todo',
            key: 'work/Todo',
            operation: 'query',
            params: { where: { status: { eq: 'done' } }, limit: 1000 },
            fields: { id: true, shortId: true }
          }
        ]
      }
    });
  });

  it('is byte-stable', () => {
    const sketch =
      'log SessionLog summary=s branch=b closes=#1,#2; update Todo #3 big=9007199254740993 notes=n; find Todo status=open';
    expect('plan' in compile(sketch)).toBe(true);
    const json = () =>
      JSON.stringify(compile(sketch), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(json()).toBe(json());
  });

  it('compiles the AST form as the text form', () => {
    const ast: ActStep[] = [
      { action: 'close', type: 'Todo', refs: ['#2014'], args: { resolution: 'wont_do' } }
    ];
    const r = compile(ast);
    expect('plan' in r).toBe(true);
    expect(r).toEqual(compile('close Todo #2014 resolution=wont_do'));
  });
});

describe('compileSketch refusals', () => {
  it('passes a parser refusal through', () => {
    expect(compile('close Todo "open')).toEqual(refusal(1, '"open', 'unterminated quote'));
  });

  it('refuses an ambiguous bare type', () => {
    expect(compile('close Todo #1', { localNamespaces: opts.localNamespaces })).toEqual(
      near(
        refusal(1, 'Todo', "ambiguous type 'Todo'", ['other/Todo', 'work/Todo']),
        'close other/Todo #1'
      )
    );
  });

  it('refuses an unknown type', () => {
    expect(compile('close Tdo #1')).toEqual(
      near(refusal(1, 'Tdo', "unknown type 'Tdo'", ['Note', 'SessionLog', 'Todo']), 'close Todo #1')
    );
  });

  it('refuses a field the action fixes', () => {
    expect(compile('close Todo #1 archived=false')).toEqual(
      refusal(1, 'archived', 'archived is fixed by close')
    );
  });

  it('refuses an update action with no reference', () => {
    expect(compile('close Todo')).toEqual(refusal(1, 'close', 'close needs a reference'));
  });

  it('refuses a create action with a reference', () => {
    expect(compile('create Todo #1 title=x')).toEqual(
      refusal(1, '#1', 'create takes no reference')
    );
  });

  it('refuses a missing required param', () => {
    expect(compile('defer Todo #1')).toEqual(
      refusal(1, 'defer', "missing param 'revisitWhen'", ['revisitWhen'])
    );
  });

  it('refuses an unknown binding', () => {
    expect(compile('update Todo $nope priority=high')).toEqual(
      refusal(1, '$nope', "unknown binding '$nope'")
    );
  });

  it('refuses a value outside the enum', () => {
    expect(compile('update Todo #1 priority=urgent')).toEqual(
      near(
        refusal(1, 'urgent', "priority: 'urgent' is not one of low|medium|high", [
          'high',
          'low',
          'medium'
        ]),
        'update Todo #1 priority=high'
      )
    );
  });

  it('refuses an unknown action', () => {
    expect(compile('delete Todo #1')).toEqual(
      near(
        refusal(1, 'delete', "unknown action 'delete' on work/Todo", [
          'close',
          'count',
          'create',
          'defer',
          'find',
          'update'
        ]),
        'defer Todo #1'
      )
    );
  });

  it('refuses more write steps than the cap', () => {
    const refs = Array.from({ length: 51 }, (_, i) => `#${i + 1}`).join(' ');
    expect(compile(`close Todo ${refs}`)).toEqual(
      refusal(1, '', '51 write steps exceed the cap of 50')
    );
  });

  it('refuses at the cap while expanding, before building the whole plan', () => {
    const sweep: ActionDecl = {
      params: { items: { list: 'work/Todo' } },
      // biome-ignore lint/suspicious/noThenProperty: `then` is the action declaration's key
      then: [{ action: 'work/Todo.close', each: { param: 'items' } }]
    };
    const s = fixture({ close, defer, sweep });
    const refs = (n: number) => Array.from({ length: n }, (_, i) => `#${i + 1}`);
    // 200 refs, each followed by 1000 closes: 200,200 write steps if fully expanded.
    const sketch = `sweep Todo ${refs(200).join(' ')} items=${refs(1000).join(',')}`;
    expect(compile(sketch, opts, s)).toEqual(refusal(1, '', '51 write steps exceed the cap of 50'));
  });

  it('refuses a shortId in a crossRef filter', () => {
    expect(compile('find Note todo=#7')).toEqual(
      refusal(1, '#7', "#7 cannot filter todo; use the record's id")
    );
  });

  it('refuses a shortId or a binding in a list of crossRefs', () => {
    expect(compile('update Note n1 related=abc,#7')).toEqual(
      refusal(1, '#7', 'related takes full ids only')
    );
    expect(compile('create Todo title=x as $t; update Note n1 related=$t')).toEqual(
      refusal(2, '$t', 'related takes full ids only')
    );
  });

  it('refuses a namespace that is not local', () => {
    const local = { localNamespaces: new Set(['work', 'journal']), defaultNamespace: 'work' };
    expect(compile('update other/Todo #1 title=x', local)).toEqual(
      refusal(1, 'other/Todo', 'other is bridged or virtual; act runs on local stores only')
    );
  });

  it('refuses a write whose mutation is missing', () => {
    const { updateNote: _, ...mutations } = schema.work.mutations;
    const s = { ...schema, work: { ...schema.work, mutations } };
    expect(compile('update Note #1 title=x', opts, s)).toEqual(
      refusal(1, 'update', 'work/Note has no updateNote mutation')
    );
  });

  it('refuses an empty reference in a list param', () => {
    expect(compile('log SessionLog summary=s branch=b closes=#1,')).toEqual(
      refusal(1, '', 'empty reference')
    );
  });

  it('refuses a list element that is not a reference', () => {
    expect(compile('log SessionLog summary=s branch=b closes=null')).toEqual(
      refusal(1, 'null', 'not a reference')
    );
  });

  it('refuses a quoted list element that is not a reference', () => {
    expect(compile('log SessionLog summary=s branch=b closes="[#1]"')).toEqual(
      refusal(1, '[#1]', 'not a reference')
    );
  });

  it('refuses a then target that does not exist', () => {
    const s = fixture({ defer });
    expect(compile('log SessionLog summary=s branch=b closes=#1', opts, s)).toEqual(
      refusal(1, 'log', 'then target work/Todo.close does not exist')
    );
  });

  it('refuses as on a step with several records', () => {
    expect(compile('close Todo #1 #2 as $t')).toEqual(refusal(1, '$t', 'as needs a single record'));
  });

  it('echoes a long token clipped and skips its nearest search', () => {
    const many = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`Type${i}`, { fields: { title: str } }])
    );
    const s = { ...schema, wide: publish('wide', many) };
    const r = compile(`find ${'X'.repeat(900_000)}`, opts, s);
    if (!('refusal' in r)) throw new Error('expected a refusal');
    expect(r.refusal.nearest).toBeNull();
    expect(r.refusal.choices).toContain('Type0');
    expect(r.refusal.token).toBe(`${'X'.repeat(64)}…`);
    expect(r.refusal.problem.length).toBeLessThan(200);
  });

  it('refuses a crossRef shortId into a namespace that is not local', () => {
    const link = publish('work', {
      Link: {
        fields: {
          title: str,
          todo: { kind: 'crossRef', ns: 'other', type: 'Todo', onDelete: 'set_null' }
        }
      }
    });
    const s = { ...schema, work: link };
    const local = { localNamespaces: new Set(['work']), defaultNamespace: 'work' };
    expect(compile('create Link title=x todo=#7', local, s)).toEqual(
      refusal(1, '#7', 'other is bridged or virtual; act runs on local stores only')
    );
    // A full id is a literal, written as `mutate` writes it.
    const plan = compile('create Link title=x todo=t_1', local, s);
    expect(plan).toMatchObject({ plan: { steps: [{ params: { title: 'x', todo: 't_1' } }] } });
  });

  it('refuses an id arg on a write', () => {
    for (const sketch of [
      'update Todo #1 id=x',
      'create Todo title=t id=x',
      'close Todo #1 id=x'
    ]) {
      expect(compile(sketch)).toEqual(refusal(1, 'id', 'id comes from the reference'));
    }
  });

  it('refuses a malformed AST step', () => {
    const bad = [{ action: 'close', type: 'Todo', refs: 5 }] as unknown as ActStep[];
    expect(compile(bad)).toEqual(refusal(1, '', 'malformed step'));
  });
});

describe('compileSketch help', () => {
  it('lists types and their actions', () => {
    expect(compile('?')).toEqual({
      help: {
        types: {
          journal: { SessionLog: ['log'] },
          other: { Todo: [] },
          work: { Note: [], Todo: ['close', 'defer'] }
        }
      }
    });
  });

  it("describes a type's actions and fields", () => {
    expect(compile('? Todo')).toEqual({
      help: {
        type: 'work/Todo',
        actions: {
          close: {
            kind: 'update',
            params: { resolution: { type: 'completed|wont_do|superseded', required: false } }
          },
          defer: { kind: 'update', params: { revisitWhen: { type: 'string', required: true } } }
        },
        fields: {
          title: { type: 'string', required: true },
          status: { type: 'open|closed|deferred', required: true },
          resolution: { type: '(completed|wont_do|superseded)?', required: false },
          archived: { type: 'boolean', required: false },
          revisitWhen: { type: 'string?', required: false },
          notes: { type: 'string?', required: false },
          priority: { type: 'low|medium|high', required: false },
          big: { type: 'int64?', required: false },
          shortId: { type: 'number [readonly]', required: false }
        }
      }
    });
  });

  it('answers several help steps in order', () => {
    const one = (sketch: string) => {
      const r = compile(sketch);
      return 'help' in r ? r.help : r;
    };
    expect(compile('?; ? Todo; ? journal/SessionLog')).toEqual({
      help: [one('?'), one('? Todo'), one('? journal/SessionLog')]
    });
  });

  it('refuses help beside an action', () => {
    expect(compile('close Todo #1; ? Todo')).toEqual(refusal(2, '?', 'help stands alone'));
  });

  it('refuses more than 10 help steps', () => {
    expect(compile(Array(11).fill('?').join('; '))).toEqual(
      refusal(11, '?', 'at most 10 help steps')
    );
  });

  it('spells references and list params', () => {
    const help = compile('? journal/SessionLog');
    expect('help' in help && (help.help as ActHelp).actions?.log?.params.closes).toEqual({
      type: '→work/Todo[]',
      required: false
    });
    const note = compile('? Note');
    expect('help' in note && (note.help as ActHelp).fields?.todo).toEqual({
      type: '→work/Todo',
      required: false
    });
  });
});

describe('compileSketch define', () => {
  const key = '_system_proposals/propose_action';
  const withKey: CompileOptions = { ...opts, defineKey: key };
  const def = (sketch: string) => compile(sketch, withKey);

  it('compiles define to the propose_action step', () => {
    const r = def('define Todo.reopen reopened status=open notes=$why?');
    expect(r).toEqual({
      plan: {
        steps: [
          {
            step: 1,
            source: 1,
            action: 'define',
            type: 'work/Todo',
            key,
            operation: 'mutate',
            params: {
              namespace: 'work',
              type: 'Todo',
              name: 'reopen',
              decl: {
                kind: 'update',
                past: 'reopened',
                params: { why: { type: optStr, optional: true } },
                set: { status: 'open', notes: { param: 'why' } }
              },
              sketch: 'define work/Todo.reopen reopened status=open notes=$why?'
            },
            fields: { id: true },
            past: 'defined'
          }
        ]
      }
    });
  });

  it('names a param after its field for a bare $, and sets now on a date field', () => {
    const r = compile('define SessionLog.stamp startedAt=now summary=$ branch=$b', withKey);
    expect(r).toMatchObject({
      plan: {
        steps: [
          {
            params: {
              decl: {
                params: { summary: { type: str }, b: { type: str } },
                set: {
                  startedAt: { now: true },
                  summary: { param: 'summary' },
                  branch: { param: 'b' }
                }
              }
            }
          }
        ]
      }
    });
  });

  it('refuses define without an action layer', () => {
    expect(compile('define Todo.xx status=open')).toEqual(
      refusal(1, 'define', 'this server takes no action proposals')
    );
  });

  it.each([
    ['define Todo.Bad status=open', 'name'],
    ['define Todo.find status=open', 'built-in'],
    ['define Todo.xx', 'nothing'],
    ['define Todo.xx nope=1', 'unknown field'],
    ['define Todo.xx title=now', 'date'],
    ['define Todo.xx shortId=$', 'server-set'],
    ['define Todo.xx status=nope', 'one of'],
    ['define Todo.xx Bad status=open', 'name']
  ])('refuses %s', (sketch, problem) => {
    const r = def(sketch);
    expect(r).toHaveProperty('refusal.problem', expect.stringContaining(problem));
  });

  it('offers the nearest valid sketch for a misspelt type', () => {
    expect(def('define Todp.xx status=open')).toMatchObject({
      refusal: { nearest: expect.stringMatching(/^define \w+\.xx status=open$/) }
    });
  });

  it('refuses define beside another step, and a second define', () => {
    const stands = refusal(1, 'define', 'define stands alone');
    expect(def('define Todo.xx status=open; close Todo #1')).toEqual(stands);
    expect(def('define Todo.xx status=open; define Todo.yy status=open')).toEqual(stands);
    expect(def('close Todo #1; define Todo.xx status=open')).toEqual(
      refusal(2, 'define', 'define stands alone')
    );
  });

  it('refuses a binding on define', () => {
    expect(def('define Todo.xx status=open as $x')).toEqual(
      refusal(1, '$x', 'define takes no binding')
    );
  });

  it('refuses one param name over two field types, allows it over one', () => {
    expect(def('define Todo.xx title=$p status=$p')).toHaveProperty(
      'refusal.problem',
      expect.stringContaining("param 'p'")
    );
    expect(def('define SessionLog.xx summary=$p branch=$p')).toHaveProperty('plan');
  });
});
