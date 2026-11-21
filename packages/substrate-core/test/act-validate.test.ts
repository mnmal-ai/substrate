/**
 * `assertActionGraph` over core `Registry` instances. Core cannot import the
 * SDK, so the entries are registered directly; `defineNamespace` checks the
 * per-type rules in substrate-sdk/test/namespace-actions.test.ts.
 */

import type { ActionDecl, ActionParamDecl, FieldDef } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { assertActionGraph, type NamespaceConfig, Registry } from '../src/index.js';

const str: FieldDef = { kind: 'scalar', type: 'string' };

function graph(spec: Record<string, Record<string, Record<string, ActionDecl>>>) {
  const namespaces = new Map<string, NamespaceConfig>();
  for (const [ns, types] of Object.entries(spec)) {
    const registry = new Registry();
    for (const [type, actions] of Object.entries(types)) {
      registry.register(type, { resolver: async () => [], fields: { title: str }, actions });
    }
    namespaces.set(ns, { registry });
  }
  return namespaces;
}

// Helpers build `then` in one place; the key is the declaration's own name.
const forEach = (params: Record<string, ActionParamDecl>, action: string): ActionDecl => ({
  params,
  // biome-ignore lint/suspicious/noThenProperty: `then` is the action declaration's key
  then: [{ action, each: { param: 'items' } }]
});
const forEachTodo = (action: string) => forEach({ items: { list: 'work/Todo' } }, action);
const forEachOptional = (list: string, action: string) =>
  forEach({ items: { list, optional: true } }, action);
const close: ActionDecl = { set: { title: 'closed' } };

describe('assertActionGraph', () => {
  it('passes a valid two-namespace graph', () => {
    const g = graph({
      journal: {
        SessionLog: { log: forEachTodo('work/Todo.close') }
      },
      work: { Todo: { close } }
    });
    expect(() => assertActionGraph(g)).not.toThrow();
  });

  it('refuses a then target that does not exist', () => {
    const g = graph({
      journal: {
        SessionLog: { log: forEachTodo('work/Todo.shut') }
      },
      work: { Todo: { close } }
    });
    expect(() => assertActionGraph(g)).toThrow('then target work/Todo.shut does not exist');
  });

  it('refuses a then target that is a create action', () => {
    const g = graph({
      journal: {
        SessionLog: { log: forEachTodo('work/Todo.add') }
      },
      work: { Todo: { add: { kind: 'create', set: { title: 'x' } } } }
    });
    expect(() => assertActionGraph(g)).toThrow('then target work/Todo.add is a create action');
  });

  it('refuses a then target with a param that has no default', () => {
    const g = graph({
      journal: {
        SessionLog: { log: forEachTodo('work/Todo.close') }
      },
      work: {
        Todo: { close: { params: { why: { type: str } }, set: { title: { param: 'why' } } } }
      }
    });
    expect(() => assertActionGraph(g)).toThrow(
      "then target work/Todo.close needs param 'why', which has no default"
    );
  });

  it('accepts a then target whose params are optional or defaulted', () => {
    const g = graph({
      journal: {
        SessionLog: { log: forEachTodo('work/Todo.close') }
      },
      work: {
        Todo: {
          close: {
            params: { why: { type: str, optional: true }, how: { type: str, default: 'x' } },
            set: { title: { param: 'why' }, notes: { param: 'how' } }
          }
        }
      }
    });
    expect(() => assertActionGraph(g)).not.toThrow();
  });

  it('refuses an action cycle', () => {
    const g = graph({
      work: {
        A: { x: forEachOptional('work/B', 'work/B.y') },
        B: { y: forEachOptional('work/A', 'work/A.x') }
      }
    });
    expect(() => assertActionGraph(g)).toThrow('action cycle: work/A.x -> work/B.y -> work/A.x');
  });
});
