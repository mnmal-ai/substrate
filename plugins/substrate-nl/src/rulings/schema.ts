/**
 * Rulings arrive from two places: declared by the namespace owner in
 * `defineNamespace(..., { annotations: { nl } })`, and overridden by the
 * operator in `substrate-nl.config.json`. Both are validated here. Bad declared
 * rulings are dropped with a warning rather than failing the boot: one
 * namespace's typo must not take NL down for every namespace, and must not
 * pass silently either.
 */
import {
  METADATA_AUTHOR_FIELDS,
  METADATA_FILTER_FIELDS,
  type Schema
} from '@mnmal-ai/substrate/sdk';
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

const norm = (p: string): string => p.trim().replace(/\s+/g, ' ').toLowerCase();

const FieldPhraseSchema = z
  .object({
    field: z.string().min(1).optional(),
    value: z.unknown().optional(),
    exclude: z.record(z.string(), z.unknown()).optional(),
    derive: z
      .union([
        z.object({ diff: z.tuple([z.string(), z.string()]) }).strict(),
        z.object({ ratio: z.tuple([z.string(), z.string()]) }).strict()
      ])
      .optional(),
    pick: z.enum(['latest', 'max', 'min']).optional()
  })
  .strict()
  .refine((v) => v.field !== undefined || (v.value === undefined && v.exclude === undefined), {
    message: 'value and exclude require field'
  })
  .refine((v) => v.field !== undefined || v.derive !== undefined || v.pick !== undefined, {
    message: 'an entry needs at least one of field, derive, pick'
  });

const FieldPhrasesSchema = z.record(z.string(), FieldPhraseSchema).transform((rec, ctx) => {
  const out: Record<string, z.infer<typeof FieldPhraseSchema>> = {};
  for (const [phrase, entry] of Object.entries(rec)) {
    const key = norm(phrase);
    if (Object.hasOwn(out, key)) {
      ctx.addIssue({ code: 'custom', message: `two phrases normalise to '${key}'` });
      return z.NEVER;
    }
    out[key] = entry;
  }
  return out;
});

const record = z.record(z.string(), z.string());

export const NamespaceRulingsSchema = z
  .object({
    fieldPhrases: FieldPhrasesSchema.optional(),
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

const COMBINATORS = ['AND', 'OR', 'NOT'];

/** Field names an `exclude` clause names, walked through AND/OR/NOT. Structural only: operator spellings are the engine's to refuse at query time. */
function whereFields(w: unknown, out: string[]): void {
  if (Array.isArray(w)) for (const x of w) whereFields(x, out);
  else if (typeof w === 'object' && w !== null)
    for (const [k, v] of Object.entries(w))
      if (COMBINATORS.includes(k)) whereFields(v, out);
      else out.push(k);
}

/** Why a `fieldPhrases` entry does not fit the schema, or undefined. */
function phraseProblem(schema: Schema, e: z.infer<typeof FieldPhraseSchema>): string | undefined {
  const types = new Set<string>();
  const refs = [
    ...(e.field !== undefined ? [e.field] : []),
    ...(e.derive ? (Object.values(e.derive)[0] ?? []) : [])
  ];
  for (const r of refs) {
    const dot = r.indexOf('.');
    const type = dot < 0 ? r : r.slice(0, dot);
    const field = dot < 0 ? '' : r.slice(dot + 1);
    const t = Object.hasOwn(schema.types, type) ? schema.types[type] : undefined;
    if (t === undefined) return `unknown type '${type}'`;
    if (!Object.hasOwn(t.fields, field)) return `unknown field '${type}.${field}'`;
    types.add(type);
  }
  if (types.size > 1) return `refers to more than one type (${[...types].join(', ')})`;
  const [type] = types;
  if (e.exclude !== undefined && type !== undefined) {
    const names: string[] = [];
    whereFields(e.exclude, names);
    const fields = schema.types[type]?.fields ?? {};
    const bad = names.find(
      (n) =>
        !n.startsWith('_') &&
        !Object.hasOwn(fields, n) &&
        !Object.hasOwn(METADATA_FILTER_FIELDS, n) &&
        !Object.hasOwn(METADATA_AUTHOR_FIELDS, n)
    );
    if (bad !== undefined) return `exclude names unknown field '${type}.${bad}'`;
  }
  return undefined;
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
  let normOverride = override;
  if (override?.fieldPhrases !== undefined) {
    const p = FieldPhrasesSchema.safeParse(override.fieldPhrases);
    const { fieldPhrases: _drop, ...rest } = override;
    if (p.success)
      normOverride = {
        ...rest,
        fieldPhrases: p.data as NonNullable<NamespaceRulings['fieldPhrases']>
      };
    else {
      normOverride = rest;
      warnings.push(
        `override fieldPhrases are invalid and were ignored (${p.error.issues.map((i) => i.message).join('; ')})`
      );
    }
  }
  const rulings = mergeRulings(declared, normOverride);
  if (rulings.fieldPhrases !== undefined) {
    const kept: NonNullable<NamespaceRulings['fieldPhrases']> = {};
    for (const [phrase, entry] of Object.entries(rulings.fieldPhrases)) {
      const problem = phraseProblem(schema, entry);
      if (problem === undefined) kept[phrase] = entry;
      else warnings.push(`fieldPhrases '${phrase}' was ignored: ${problem}`);
    }
    rulings.fieldPhrases = kept;
  }
  return { rulings, warnings };
}
