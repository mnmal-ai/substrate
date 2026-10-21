/**
 * Host side of substrate-recall's membership decay sweep: "of these cluster
 * members, which source rows are gone?" Answered with one read per
 * (namespace, type) group, since only the binary holds the dataset registry.
 *
 * POLARITY IS THE SAFETY PROPERTY. This reports rows it can positively
 * establish are absent. A namespace that will not resolve, a group that never
 * gets asked, a dataset that answers nothing — all leave their refs OUT of
 * the result and therefore attached. The sweep's only action is
 * `markDeparted` and there is no un-depart, so under-reporting is corrected
 * by the next pass while over-reporting is corrected by nothing.
 */

import type { Dataset } from '@mnmal-ai/substrate-types';

/** Structurally compatible with substrate-recall's `MemberRef`. */
export interface RowRef {
  namespace: string;
  type: string;
  id: string;
}

export interface RowsMissingProbeOptions {
  /**
   * Late-bound registry lookup — the same closure recall's
   * `EmbedSourceContext` uses, resolving through the registry `compose()`
   * populates well after these deps are built.
   */
  resolveDataset: (namespace: string) => Dataset | null;
}

/** `substrate-recall`'s `memberKey` — kept in step with it by the shared string form. */
function memberKey(ref: RowRef): string {
  return `${ref.namespace}/${ref.type}/${ref.id}`;
}

export function createRowsMissingProbe(
  opts: RowsMissingProbeOptions
): (refs: readonly RowRef[]) => Promise<Set<string>> {
  return async (refs: readonly RowRef[]): Promise<Set<string>> => {
    const groups = new Map<string, { namespace: string; type: string; ids: Set<string> }>();
    for (const ref of refs) {
      const key = `${ref.namespace}/${ref.type}`;
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, { namespace: ref.namespace, type: ref.type, ids: new Set([ref.id]) });
      } else {
        group.ids.add(ref.id);
      }
    }

    const missing = new Set<string>();
    for (const { namespace, type, ids } of groups.values()) {
      const dataset = opts.resolveDataset(namespace);
      if (dataset === null) continue;

      const asked = [...ids];
      // No `limit`: both substrates read an absent limit as unbounded, and a
      // page cap here would silently reclassify the tail of a batch as gone.
      // `fields` narrows the projection to nothing — existence is the whole
      // question, and `id` comes from a dedicated column regardless.
      const result = await dataset.read(type, { ids: asked, fields: {} });
      const found = new Set(result.rows.map((row) => String(row.id)));
      for (const id of asked) {
        if (!found.has(id)) missing.add(memberKey({ namespace, type, id }));
      }
    }

    return missing;
  };
}
