import type { NlServedPack, Schema } from '@mnmal-ai/substrate/sdk';
import { defineModule, type ModuleCtx, sanitise, type TuiModule } from '@mnmal-ai/surface-core';
import { truncateCells } from '@mnmal-ai/surface-kit';
import type { TuiDeps } from '../deps.js';

export interface SchemaState {
  level: 'ns' | 'type' | 'field';
  schema: Record<string, Schema>;
  ns?: string;
  type?: string;
  cursor: number;
  /** Field detail from the served pack (operators, phrases, enum, aliases), when the ns has substrate-nl. */
  pack?: NlServedPack;
}
type Panels = { schema: SchemaState };
type Ctx = ModuleCtx<Panels>;

/** `rec[key]` only when `key` is the record's own property: names come from the server and the user. */
const own = <T,>(
  rec: Readonly<Record<string, T>> | undefined,
  key: string | undefined
): T | undefined =>
  rec !== undefined && key !== undefined && Object.hasOwn(rec, key) ? rec[key] : undefined;

const typesOf = (s: SchemaState): Schema['types'] => own(s.schema, s.ns)?.types ?? {};

const items = (s: SchemaState): string[] => {
  if (s.level === 'ns') return Object.keys(s.schema).sort();
  const types = typesOf(s);
  if (s.level === 'type') return Object.keys(types).sort();
  const fields = own(types, s.type)?.fields;
  return Object.keys(fields ?? {}).sort();
};

function fieldLine(s: SchemaState, name: string): string {
  const def = own(own(typesOf(s), s.type)?.fields, name) as Record<string, unknown> | undefined;
  const pf = own(own(s.pack?.types, s.type)?.fields, name);
  const parts = [
    name,
    `${String(def?.kind ?? '?')}${def?.type !== undefined ? `/${String(def.type)}` : ''}`
  ];
  if (def?.indexed === true) parts.push('indexed');
  const en = (def?.enum as string[] | undefined) ?? pf?.enum;
  if (en !== undefined && en.length > 0) parts.push(`enum: ${en.join(', ')}`);
  if (pf?.aliases !== undefined && Object.keys(pf.aliases).length > 0) {
    parts.push(
      `aliases: ${Object.entries(pf.aliases)
        .map(([a, c]) => `${a}→${c}`)
        .join(' ')}`
    );
  }
  if (pf !== undefined && pf.operators.length > 0) parts.push(`ops: ${pf.operators.join(' ')}`);
  return parts.join('  ');
}

export function schemaModule(deps: TuiDeps): TuiModule<Panels> {
  const loadPack = (ns: string, ctx: Ctx) => {
    deps.nl.pack(ns, { signal: ctx.signal }).then(
      (pack) => ctx.update('schema', (s) => (s.ns === ns ? { ...s, pack } : s)),
      () => undefined // no substrate-nl for this namespace: fields still list, without operators
    );
  };
  const move = (d: number) => (s: SchemaState) => ({
    ...s,
    cursor: Math.max(0, Math.min(items(s).length - 1, s.cursor + d))
  });
  const into = (s: SchemaState, ctx: Ctx): SchemaState | undefined => {
    const pick = items(s)[s.cursor];
    if (pick === undefined) return undefined;
    if (s.level === 'ns') {
      loadPack(pick, ctx);
      const { pack: _drop, ...rest } = s;
      return { ...rest, level: 'type', ns: pick, cursor: 0 };
    }
    if (s.level === 'type') return { ...s, level: 'field', type: pick, cursor: 0 };
    return undefined;
  };
  const out = (s: SchemaState): SchemaState | undefined => {
    if (s.level === 'field') {
      const back: SchemaState = { ...s, level: 'type' };
      return { ...back, cursor: Math.max(0, items(back).indexOf(s.type ?? '')) };
    }
    if (s.level === 'type') {
      const { ns: _ns, pack: _p, type: _t, ...rest } = s;
      const back: SchemaState = { ...rest, level: 'ns', cursor: 0 };
      return { ...back, cursor: Math.max(0, items(back).indexOf(s.ns ?? '')) };
    }
    return undefined;
  };

  return defineModule<Panels>('substrate.schema', {
    commands: [
      {
        name: 'schema',
        summary: 'browse namespaces, types and fields',
        args: [
          { name: 'namespace', optional: true },
          { name: 'type', optional: true }
        ],
        async run([ns, type], ctx) {
          let schema: Record<string, Schema>;
          try {
            schema = await deps.federatedSchema();
          } catch (err) {
            ctx.print(
              `schema unavailable: ${sanitise(err instanceof Error ? err.message : String(err))}`,
              'error'
            );
            return;
          }
          if (ns !== undefined && !Object.hasOwn(schema, ns)) {
            return ctx.print(`unknown namespace '${sanitise(ns)}'`, 'warn');
          }
          if (
            ns !== undefined &&
            type !== undefined &&
            !Object.hasOwn(schema[ns]?.types ?? {}, type)
          ) {
            return ctx.print(`unknown type '${sanitise(type)}' in ${sanitise(ns)}`, 'warn');
          }
          const state: SchemaState =
            ns === undefined
              ? { level: 'ns', schema, cursor: 0 }
              : type === undefined
                ? { level: 'type', schema, ns, cursor: 0 }
                : { level: 'field', schema, ns, type, cursor: 0 };
          ctx.open('schema', state);
          if (ns !== undefined) loadPack(ns, ctx);
        }
      }
    ],
    panels: {
      schema: {
        view: ({ state, theme, size }) => {
          const head =
            state.level === 'ns'
              ? 'namespaces'
              : state.level === 'type'
                ? `${state.ns} · types`
                : `${state.ns}/${state.type} · fields`;
          const all = items(state);
          const max = Math.max(1, size.rows - 2);
          const start = Math.max(0, Math.min(state.cursor - max + 1, all.length - max));
          const lines = all.slice(start, start + max).map((name, k) => {
            const i = start + k;
            const mark = i === state.cursor ? theme.glyph.cursor : ' ';
            const body =
              state.level === 'ns'
                ? `${name}  ${Object.keys(state.schema[name]?.types ?? {}).length} types`
                : state.level === 'type'
                  ? `${name}  ${Object.keys(typesOf(state)[name]?.fields ?? {}).length} fields`
                  : fieldLine(state, name);
            return truncateCells(sanitise(`${mark} ${body}`), Math.max(1, size.columns - 2));
          });
          return [
            truncateCells(sanitise(`${theme.glyph.title} ${head}`), size.columns),
            ...lines,
            truncateCells('  ↑↓/jk move · enter open · backspace up · esc close', size.columns)
          ].join('\n');
        },
        keymap: [
          { key: 'up', act: 'up' },
          { key: 'k', act: 'up' },
          { key: 'down', act: 'down' },
          { key: 'j', act: 'down' },
          { key: 'enter', act: 'in' },
          { key: 'backspace', act: 'out' }
        ],
        on: { up: move(-1), down: move(1), in: into, out: (s) => out(s) }
      }
    }
  });
}
