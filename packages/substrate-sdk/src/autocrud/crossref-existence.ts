/**
 * Write-time crossRef existence enforcement (`onMissing`). Shared by the
 * create + update autoCRUD resolvers so both refuse an edge to a
 * non-existent/tombstoned target unless the field declares onMissing:'allow'.
 *
 * Runs BEFORE the substrate write in each resolver, so a refusal does zero
 * write work; the engine's G1 transaction also unwinds any partial write.
 */

import type {
  Dataset,
  FieldDef,
  FieldDefCrossRef,
  Id,
  ResolverArgs
} from '@mnmal-ai/substrate-types';
import {
  BatchElementError,
  isBatchElementError,
  MissingReferentError
} from '@mnmal-ai/substrate-types';
import { parseShortForm } from '../short-id-resolver.js';

export interface CrossRefFieldInfo {
  fieldName: string;
  def: FieldDefCrossRef;
}

/** Extract the crossRef fields from a type's field-def map. */
export function collectCrossRefFields(
  fields: Record<string, FieldDef> | undefined
): CrossRefFieldInfo[] {
  if (!fields) return [];
  const out: CrossRefFieldInfo[] = [];
  for (const [fieldName, def] of Object.entries(fields)) {
    if (def.kind === 'crossRef') out.push({ fieldName, def });
  }
  return out;
}

/**
 * Verify each crossRef's target row exists (live, non-tombstoned). Same-ns
 * targets read the tx-scoped `args.dataset`; cross-ns targets read the
 * committed `args.resolveDataset(ns)` view. Throws MissingReferentError on the
 * first missing target.
 *
 * Enforcement is ON by default: a crossRef is a PK<->FK relationship. Three
 * states:
 *
 *   undefined  enforce WHERE ENFORCEABLE — skip silently when the target
 *              namespace is not resolvable here, because a cross-substrate
 *              reference cannot have a real FK (that is what `EdgesStore`
 *              exists for).
 *   'reject'   enforce, AND compose refuses to start when the target namespace
 *              is not locally resolvable. An explicit demand for something
 *              impossible should fail at registration, not at write time.
 *   'allow'    never enforce. The deliberate opt-out, for a genuinely soft
 *              reference.
 */
export async function assertCrossRefTargetsExist(
  args: ResolverArgs,
  crossRefs: CrossRefFieldInfo[],
  values: Record<string, unknown>,
  fromNs: string
): Promise<void> {
  try {
    await assertCrossRefTargetsExistMany(args, crossRefs, [values], fromNs);
  } catch (err) {
    throw isBatchElementError(err) ? err.cause : err;
  }
}

/**
 * Same-type ids an earlier element of this batch creates: `ids` maps each id
 * to the index of the first element that creates it.
 */
export interface PendingIds {
  type: string;
  ids: ReadonlyMap<string, number>;
}

/**
 * `assertCrossRefTargetsExist` for a batch: element `i`'s values are
 * `values[i]`. For each target type it reads the distinct values once, then
 * resolves the misses that parse as a short id with one `resolveShortIds`.
 * A value that `pending` names counts as existing for element `i` only when
 * the element creating it comes before `i`, as sequential dispatch has it
 * written by then. Throws `BatchElementError(i, MissingReferentError)` for
 * the lowest refused element, fields checked in declared order.
 */
export async function assertCrossRefTargetsExistMany(
  args: ResolverArgs,
  crossRefs: CrossRefFieldInfo[],
  values: ReadonlyArray<Record<string, unknown>>,
  fromNs: string,
  pending?: PendingIds
): Promise<void> {
  const enforced = crossRefs.filter(({ def }) => def.onMissing !== 'allow');
  if (enforced.length === 0) return;
  const refOf = (i: number, fieldName: string): Id | undefined => {
    const v = values[i]?.[fieldName];
    return typeof v === 'string' || typeof v === 'number' ? v : undefined;
  };
  const targetOf = (def: FieldDefCrossRef): Dataset | undefined =>
    def.ns === fromNs ? args.dataset : args.resolveDataset?.(def.ns);

  // Distinct values per target (ns, type), each group probed once.
  const groups = new Map<string, { ds: Dataset; type: string; ids: Set<Id> }>();
  for (const { fieldName, def } of enforced) {
    const ds = targetOf(def);
    if (ds === undefined) continue;
    const key = `${def.ns}\u0000${def.type}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { ds, type: def.type, ids: new Set() };
      groups.set(key, group);
    }
    for (let i = 0; i < values.length; i++) {
      const v = refOf(i, fieldName);
      if (v !== undefined) group.ids.add(v);
    }
  }
  const existing = new Map<string, Set<string>>();
  for (const [key, { ds, type, ids }] of groups) {
    existing.set(key, await existingIds(ds, type, [...ids]));
  }

  for (let i = 0; i < values.length; i++) {
    for (const { fieldName, def } of enforced) {
      const value = refOf(i, fieldName);
      if (value === undefined) continue;
      const missing = new MissingReferentError(fieldName, {
        ns: def.ns,
        type: def.type,
        id: value
      });
      const found = existing.get(`${def.ns}\u0000${def.type}`);
      if (found === undefined) {
        // An EXPLICIT reject naming an unresolvable namespace is a
        // misconfiguration compose should have refused at registration; reaching
        // a write means it did not, so fail loudly rather than silently drop the
        // guarantee that was asked for. Defaulted: nothing was promised about a
        // namespace this deployment does not host.
        if (def.onMissing === 'reject') throw new BatchElementError(i, missing);
        continue;
      }
      if (found.has(String(value))) continue;
      const earlier =
        def.ns === fromNs && pending?.type === def.type
          ? pending.ids.get(String(value))
          : undefined;
      if (earlier !== undefined && earlier < i) continue;
      throw new BatchElementError(i, missing);
    }
  }
}

/** The inputs naming a live row: by raw id, else as a short id. */
async function existingIds(ds: Dataset, type: string, inputs: Id[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (inputs.length === 0) return found;
  for (const r of (await ds.read(type, { ids: inputs, includeDeleted: false })).rows) {
    found.add(String(r.id));
  }
  const shortOf = new Map<number, string[]>();
  for (const input of inputs) {
    if (found.has(String(input))) continue;
    const shortId = parseShortForm(input);
    if (shortId === null) continue;
    shortOf.set(shortId, [...(shortOf.get(shortId) ?? []), String(input)]);
  }
  if (shortOf.size === 0) return found;
  const bound = await ds.resolveShortIds(type, [...shortOf.keys()]);
  for (const shortId of bound.keys()) {
    for (const input of shortOf.get(shortId) ?? []) found.add(input);
  }
  return found;
}
