/**
 * The shape a mutation's result is encoded and decoded by, matching what the
 * JSON wire projects: the published `returns` narrowed to the frame's
 * `fields`. A mutation marked `writesRows` (an autoCRUD create or update) that
 * names no `fields` answers `{ id, shortId }`; any other mutation without
 * `fields` answers its whole `returns`. The server encodes by this and the
 * client decodes by it, both from the published schema, so they agree.
 */

import type { FieldDef, FieldInput, MutationSchema } from '@mnmal-ai/substrate-types';

/** What a row-writing mutation answers when the frame names no `fields`. */
export const MUTATION_ACK_FIELDS = { id: true, shortId: true } as const;

/** The `returns` a mutation's result is positioned by, given the frame's `fields` (`true` selects everything). */
export function mutationReturns(
  mutation: Pick<MutationSchema, 'returns' | 'writesRows'>,
  fields: FieldInput | true | undefined
): FieldDef {
  if (fields === true) return mutation.returns;
  const selection = fields ?? (mutation.writesRows === true ? MUTATION_ACK_FIELDS : undefined);
  return selection === undefined ? mutation.returns : narrow(mutation.returns, selection);
}

/**
 * `def` narrowed to the selection, in declared order: a list narrows its
 * element, and a nested selection narrows a nested struct, as the JSON
 * projection recurses. A selected field the struct does not declare is
 * dropped, as the JSON projection drops a field the row does not carry.
 */
function narrow(def: FieldDef, selection: FieldInput): FieldDef {
  if (def.kind === 'list') return { ...def, of: narrow(def.of, selection) };
  if (def.kind !== 'struct') return def;
  const fields: Record<string, FieldDef> = {};
  for (const [name, field] of Object.entries(def.fields)) {
    const sub = selection[name];
    if (sub === undefined) continue;
    fields[name] = typeof sub === 'object' && sub !== null ? narrow(field, sub) : field;
  }
  return { ...def, fields };
}
