/**
 * Every read statement runs under its catalog-version guard (M3): one probe of
 * `substrate_type_tables` per table it decodes, as each guarded write carries
 * one (M6). Helpers to count those probes, and to see past the guard to the
 * read's own plan.
 */

/** A catalog-version probe, in a write's guard or a read's: `substrate_type_tables g`. */
export const probes = (q: string): number => q.match(/\bsubstrate_type_tables g\b/g)?.length ?? 0;

type Plan = Record<string, unknown> & { Plans?: Plan[] };

/**
 * The plan of a read's own statement: the guarded read is a nested loop whose
 * outer side scans the one-row `guard` CTE and whose inner side is the read.
 */
export function unguardPlan<P extends Plan>(plan: P): P {
  const side = (rel: string) => plan.Plans?.find((p) => p['Parent Relationship'] === rel);
  const outer = side('Outer');
  let inner = side('Inner');
  if (
    plan['Node Type'] !== 'Nested Loop' ||
    outer?.['CTE Name'] !== 'guard' ||
    inner === undefined
  ) {
    throw new Error(`not a guarded read: ${JSON.stringify(plan).slice(0, 400)}`);
  }
  while (inner['Node Type'] === 'Subquery Scan' || inner['Node Type'] === 'Materialize') {
    const child: Plan | undefined = inner.Plans?.[0];
    if (child === undefined) break;
    inner = child;
  }
  return inner as P;
}
