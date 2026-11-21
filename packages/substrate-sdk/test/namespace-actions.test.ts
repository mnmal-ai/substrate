import type {
  ActionDecl,
  ActionParamDecl,
  ActionThenDecl,
  FieldDef
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { defineNamespace, field, type TypeInput } from '../src/index.js';

const todoFields: Record<string, FieldDef> = {
  title: field.string(),
  status: field.enum(['open', 'closed', 'deferred']),
  resolution: field.enum(['completed', 'wont_do'], { nullable: true }),
  archived: field.boolean({ default: false }),
  revisitWhen: field.string({ nullable: true }),
  notes: field.string({ nullable: true })
};

const close: ActionDecl = {
  kind: 'update',
  past: 'closed',
  params: { why: { type: field.string({ nullable: true }), optional: true } },
  set: { status: 'closed', resolution: 'completed', archived: true, notes: { param: 'why' } }
};
const defer: ActionDecl = {
  params: { until: { type: field.string() } },
  set: { status: 'deferred', revisitWhen: { param: 'until' } }
};

function define(actions: Record<string, ActionDecl>, extra: Partial<TypeInput> = {}): unknown {
  return defineNamespace('work', {
    Todo: { fields: todoFields, actions, ...extra },
    Note: { fields: { text: field.string() } }
  });
}

const rejects = (
  actions: Record<string, ActionDecl>,
  fragment: string,
  extra?: Partial<TypeInput>
) => expect(() => define(actions, extra)).toThrow(fragment);

describe('defineNamespace actions', () => {
  it('accepts a valid definition', () => {
    expect(() => define({ close, defer })).not.toThrow();
  });

  it('refuses a set field the type does not have', () => {
    rejects({ close: { set: { nope: 'x' } } }, "close: set field 'nope' is not a field of Todo");
  });

  it('refuses a literal the field cannot hold', () => {
    rejects({ close: { set: { status: 'shut' } } }, "'shut' is not a value of Todo.status");
    rejects({ close: { set: { archived: 'yes' } } }, "'yes' is not a value of Todo.archived");
    rejects({ close: { set: { title: null } } }, "'null' is not a value of Todo.title");
  });

  it('refuses a server-set field', () => {
    rejects({ close: { set: { shortId: 1 } } }, 'Todo.shortId is server-set');
  });

  it('refuses a param without a field type', () => {
    const bad = { x: { type: 'string' } } as unknown as Record<string, ActionParamDecl>;
    rejects(
      { close: { params: bad, set: { notes: { param: 'x' } } } },
      "param 'x' has no field type"
    );
  });

  it('refuses a set from an undeclared param', () => {
    rejects({ close: { set: { notes: { param: 'y' } } } }, "set uses undeclared param 'y'");
  });

  it('refuses a param nothing uses', () => {
    rejects(
      { close: { params: { x: { type: field.string() } }, set: { status: 'closed' } } },
      "param 'x' is never used"
    );
  });

  it('refuses now on a field that is not a date', () => {
    rejects({ close: { set: { notes: { now: true } } } }, '{ now: true } needs a date field');
  });

  it('refuses a create action that leaves a required field unset', () => {
    rejects(
      { add: { kind: 'create', set: { status: 'open' } } },
      "create action 'add' leaves required field 'title' unset"
    );
    rejects(
      {
        add: {
          kind: 'create',
          params: { t: { type: field.string(), optional: true } },
          set: { title: { param: 't' }, status: 'open' }
        }
      },
      "create action 'add' leaves required field 'title' unset"
    );
  });

  it('accepts a create action whose required fields are set or defaulted', () => {
    expect(() =>
      define({
        add: {
          kind: 'create',
          params: { t: { type: field.string() } },
          set: { title: { param: 't' }, status: 'open' }
        }
      })
    ).not.toThrow();
  });

  it('refuses then without each', () => {
    const then = [{ action: 'work/Todo.close' }] as unknown as ActionThenDecl[];
    rejects({ all: { then } }, 'then entries need each');
  });

  it('refuses each over a param that is not a list', () => {
    rejects(
      {
        all: {
          params: { x: { type: field.string() } },
          // biome-ignore lint/suspicious/noThenProperty: `then` is the action declaration's key
          then: [{ action: 'work/Todo.close', each: { param: 'x' } }]
        }
      },
      'each needs a list param'
    );
  });

  it('refuses a then target of another type than the list', () => {
    rejects(
      {
        all: {
          params: { items: { list: 'work/Todo' } },
          // biome-ignore lint/suspicious/noThenProperty: `then` is the action declaration's key
          then: [{ action: 'work/Note.close', each: { param: 'items' } }]
        }
      },
      'then target work/Note.close does not match list type work/Todo'
    );
  });

  it('refuses a built-in action name', () => {
    rejects({ find: { set: { status: 'closed' } } }, "'find' is a built-in action");
  });

  it('refuses actions on an autoCrud: false type', () => {
    rejects({ close }, 'actions need autoCRUD', { autoCrud: false });
  });

  it('refuses an update action that does nothing', () => {
    rejects({ noop: {} }, "action 'noop' does nothing");
  });
});
