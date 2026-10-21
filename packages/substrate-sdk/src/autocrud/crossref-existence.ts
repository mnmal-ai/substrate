/**
 * Write-time crossRef existence enforcement (`onMissing`). Shared by the
 * create + update autoCRUD resolvers so both refuse an edge to a
 * non-existent/tombstoned target unless the field declares onMissing:'allow'.
 *
 * Runs BEFORE the substrate write in each resolver, so a refusal does zero
 * write work; the engine's G1 transaction also unwinds any partial write.
 */

import type { Dataset, FieldDef, FieldDefCrossRef, ResolverArgs } from '@mnmal-ai/substrate-types';
import { MissingReferentError } from '@mnmal-ai/substrate-types';
import { resolveEntityId } from '../short-id-resolver.js';

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
  for (const { fieldName, def } of crossRefs) {
    if (def.onMissing === 'allow') continue;
    const value = values[fieldName];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;

    const targetDs: Dataset | undefined =
      def.ns === fromNs ? args.dataset : args.resolveDataset?.(def.ns);

    if (targetDs === undefined) {
      // An EXPLICIT reject naming an unresolvable namespace is a
      // misconfiguration compose should have refused at registration; reaching
      // a write means it did not, so fail loudly rather than silently drop the
      // guarantee that was asked for.
      if (def.onMissing === 'reject') {
        throw new MissingReferentError(fieldName, { ns: def.ns, type: def.type, id: value });
      }
      // Defaulted: nothing was promised about a namespace this deployment does
      // not host, and there is nothing here to check it against.
      continue;
    }

    const resolved = await resolveEntityId(targetDs, def.type, value);
    if (resolved === null) {
      throw new MissingReferentError(fieldName, { ns: def.ns, type: def.type, id: value });
    }
  }
}
