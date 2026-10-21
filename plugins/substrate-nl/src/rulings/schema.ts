/**
 * Rulings arrive from two places: declared by the namespace owner in
 * `defineNamespace(..., { annotations: { nl } })`, and overridden by the
 * operator in `substrate-nl.config.json`. Both are validated here. Bad declared
 * rulings are dropped with a warning rather than failing the boot: one
 * namespace's typo must not take NL down for every namespace, and must not
 * pass silently either.
 */
import type { Schema } from '@mnmal-ai/substrate/sdk';
import { z } from 'zod';
import type { NamespaceRulings } from '../pack/rulings.js';

const ValueAliasSchema = z
  .object({
    type: z.string().min(1),
    field: z.string().min(1),
    in: z.array(z.string()).optional(),
    eq: z.string().optional(),
    startsWith: z.string().optional(),
    contains: z.string().optional()
  })
  .strict()
  .refine(
    (v) => [v.in, v.eq, v.startsWith, v.contains].filter((x) => x !== undefined).length === 1,
    { message: 'a value alias names exactly one of in, eq, startsWith, contains' }
  );

const record = z.record(z.string(), z.string());

export const NamespaceRulingsSchema = z
  .object({
    unscopedTypes: z.array(z.string()).optional(),
    typeAliases: record.optional(),
    fieldAliases: record.optional(),
    liveStatus: record.optional(),
    timeField: record.optional(),
    typeNotes: record.optional(),
    valueAliases: z.record(z.string(), z.array(ValueAliasSchema)).optional()
  })
  .strict() as unknown as z.ZodType<NamespaceRulings>;

/** Per top-level key: records merge entry-by-entry (override wins), arrays replace. */
export function mergeRulings(
  declared: NamespaceRulings,
  override: NamespaceRulings | undefined
): NamespaceRulings {
  if (override === undefined) return declared;
  const out: Record<string, unknown> = { ...declared };
  for (const [key, value] of Object.entries(override)) {
    const prior = out[key];
    out[key] =
      Array.isArray(value) || prior === undefined || Array.isArray(prior)
        ? value
        : { ...(prior as object), ...(value as object) };
  }
  return out as NamespaceRulings;
}

/** The effective rulings for one namespace's schema, plus anything that was dropped. */
export function readRulings(
  schema: Schema,
  override?: NamespaceRulings
): { rulings: NamespaceRulings; warnings: string[] } {
  const warnings: string[] = [];
  let declared: NamespaceRulings = {};
  const raw = schema.annotations?.nl;
  if (raw !== undefined) {
    const parsed = NamespaceRulingsSchema.safeParse(raw);
    if (parsed.success) declared = parsed.data;
    else {
      const where = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
      warnings.push(`declared rulings are invalid and were ignored (${where})`);
    }
  }
  return { rulings: mergeRulings(declared, override), warnings };
}
