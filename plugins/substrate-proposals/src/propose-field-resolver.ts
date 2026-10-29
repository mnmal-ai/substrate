/**
 * Factory for the propose_field mutation resolver.
 *
 * Validates ownership, looks up the target type in the live Registry, handles
 * idempotent re-proposals and destructive-change guards, stores the
 * FieldProposal row, applies the field to the live Registry, marks the row
 * applied, and emits a PubSub notification.
 *
 * Writes route through the autoCRUD `createFieldProposal` resolver on the
 * caller's own transaction when the engine handle is wired (production). Raw
 * `dataset.write` is the fallback for resolver-direct tests that don't boot an
 * engine (as in propose-type-resolver). The registry apply is taken back if
 * the caller's transaction rolls back.
 */

import {
  type MigrationResult,
  migrateFieldValues,
  type ValueMap
} from '@mnmal-ai/substrate-compose';
import { publishSchema } from '@mnmal-ai/substrate-core';
import { resolveIdentity } from '@mnmal-ai/substrate-sdk';
import type {
  Dataset,
  EdgesStore,
  Id,
  RequestContext,
  ResolverArgs,
  Row
} from '@mnmal-ai/substrate-types';
import { applyFieldProposal, assertValidFieldProposal } from './apply.js';
import type { PubSub } from './config.js';
import {
  applyUntilRollback,
  ensureStorageAfterCommit,
  notifyAfterCommit,
  writeInTx
} from './engine-write.js';
import { ProposalError } from './errors.js';
import { type FieldSpecJson, parseFieldSpec, stringifyFieldDef } from './field-spec-json.js';
import { proposalLockKey, withProposalLock } from './proposal-lock.js';
import type { RegistryStore } from './registry-store.js';

export interface ProposeFieldResolverDeps {
  namespace: string;
  ownedNamespaces: ReadonlySet<string>;
  registryStore: RegistryStore;
  dataset: Dataset;
  edges: EdgesStore;
  pubsub: PubSub;
  /** Typically `ns => \`_substrate_proposals_${ns}\`` */
  channelFor: (ns: string) => string;
}

export interface ProposeFieldInput {
  targetType: string;
  fieldName: string;
  fieldSpec: FieldSpecJson;
  proposedReason: string;
  /**
   * Value map for enum narrowing: stranded source value →
   * target value, or null to knowingly strand (REJECT). Triggers
   * migrate-first-then-narrow on the destructive path; absent means the
   * destructive path stays refused.
   */
  valueMap?: ValueMap | null;
}

/** Canonical JSON string for a FieldSpecJson — parse then stringify to normalise defaults. */
function canonicalize(spec: FieldSpecJson): string {
  return JSON.stringify(stringifyFieldDef(parseFieldSpec(spec)));
}

export function makeProposeFieldResolver(
  deps: ProposeFieldResolverDeps
): (ctx: RequestContext, args: ResolverArgs) => Promise<Row> {
  return async (ctx: RequestContext, args: ResolverArgs): Promise<Row> => {
    // Step 1 — namespace ownership gate. Accept the static ownedNamespaces set
    // captured at construction OR any namespace registered in registryStore
    // (covers hot-added namespaces from propose_namespace).
    if (!deps.ownedNamespaces.has(deps.namespace) && !deps.registryStore.has(deps.namespace)) {
      throw new ProposalError(
        'unowned_namespace',
        `Namespace '${deps.namespace}' is not owned by this plugin instance`
      );
    }

    const input = (args.params ?? {}) as unknown as ProposeFieldInput;
    // Refused before the lock and any row write; the crossRef target must exist.
    assertValidFieldProposal(input.targetType, input.fieldName, input.fieldSpec, (ns, type) =>
      deps.registryStore.ownsType(ns, type)
    );
    if (input.proposedReason !== undefined && typeof input.proposedReason !== 'string') {
      throw new ProposalError('invalid_params', "'proposedReason' must be a string", {
        param: 'proposedReason'
      });
    }
    // The caller's transaction, so the lock, reads and writes share its one
    // connection.
    const dataset = args.dataset ?? deps.dataset;
    return withProposalLock(
      dataset,
      proposalLockKey('field', deps.namespace, `${input.targetType}.${input.fieldName}`),
      () => proposeFieldLocked(deps, ctx, { ...args, dataset }, input)
    );
  };
}

/** Steps 2-8, run while holding the proposal lock for this field. */
async function proposeFieldLocked(
  deps: ProposeFieldResolverDeps,
  ctx: RequestContext,
  args: ResolverArgs & { dataset: Dataset },
  input: ProposeFieldInput
): Promise<Row> {
  const { targetType, fieldName, fieldSpec } = input;
  const proposedReason = input.proposedReason ?? '';
  // The signed caller, never a param: the row is the audit trail.
  const proposedBy = resolveIdentity(ctx).id;
  const suppliedMap: ValueMap | null = input.valueMap ?? null;

  // Step 2 — look up the target type in the live registry
  const binding = deps.registryStore.getBinding(deps.namespace);
  const registryWriter = binding.registry;
  const entry = registryWriter.get(targetType);
  if (!entry) {
    throw new ProposalError(
      'unknown_type',
      `Target type '${targetType}' is not registered in namespace '${deps.namespace}'`,
      { targetType }
    );
  }

  // Step 3 — check if the target already has this field
  const existingFieldDef = entry.fields[fieldName];
  // Set on the destructive-with-map path below; returned alongside the
  // applied row so the migration's counts are visible without a re-scan.
  let migration: MigrationResult | null = null;
  if (existingFieldDef !== undefined) {
    const incomingCanonical = canonicalize(fieldSpec);
    const existingCanonical = JSON.stringify(stringifyFieldDef(existingFieldDef));

    if (incomingCanonical === existingCanonical) {
      // Idempotent noop — look up the prior FieldProposal row
      const priorResult = await args.dataset.read('FieldProposal', {
        where: {
          AND: [
            { targetType: { eq: targetType } },
            { fieldName: { eq: fieldName } },
            { archived: { eq: false } }
          ]
        },
        limit: 1
      });

      if (priorResult.rows.length > 0) {
        return priorResult.rows[0] as Row;
      }

      // No proposal row — field was code-declared; return a synthesized placeholder
      return {
        id: `code-declared:${targetType}.${fieldName}`,
        targetType,
        fieldName,
        fieldSpecJson: incomingCanonical,
        applied: true,
        proposedBy: 'code',
        proposedReason: 'code-declared'
      } as Row;
    }

    // Specs differ — destructive change. Without a value map the path stays
    // refused; with one, migrate first, then narrow. The map
    // only applies to enum narrowing — any other destructive shape has no
    // vocabulary to migrate between.
    if (suppliedMap === null) {
      throw new ProposalError(
        'destructive_change_required',
        `Field '${fieldName}' on '${targetType}' already exists with a different spec. ` +
          `Pass a valueMap (stranded source value → target value, null to knowingly strand) ` +
          `to migrate stored rows first, then narrow.`,
        {
          existing: JSON.stringify(stringifyFieldDef(existingFieldDef)),
          proposed: canonicalize(fieldSpec)
        }
      );
    }
    const newEnum: readonly string[] | null =
      fieldSpec.kind === 'scalar' ? (fieldSpec.enum ?? null) : null;
    if (newEnum === null) {
      throw new ProposalError(
        'destructive_change_required',
        `Field '${fieldName}' on '${targetType}' already exists with a different spec, and the ` +
          `supplied valueMap only applies to enum narrowing — the proposed spec declares no vocabulary.`,
        {
          existing: JSON.stringify(stringifyFieldDef(existingFieldDef)),
          proposed: canonicalize(fieldSpec)
        }
      );
    }
    const oldEnum: readonly string[] | null =
      existingFieldDef.kind === 'scalar' ? (existingFieldDef.enum ?? null) : null;
    // Migrate BEFORE the proposal row or the narrowing below exists: a map
    // that refuses (unmapped values, illegal targets) is an authoring error
    // and must fail before anything is recorded.
    migration = await migrateFieldValues(
      {
        dataset: args.dataset,
        namespace: deps.namespace,
        type: targetType,
        field: fieldName,
        vocabulary: newEnum
      },
      suppliedMap,
      { oldVocabulary: oldEnum }
    );
  }

  // Step 4 — new field: write the FieldProposal row (applied=false). Engine
  // path runs through autoCRUD; fallback path raw-writes.
  const proposedAt = new Date();
  const initialParams: Record<string, unknown> = {
    targetType,
    fieldName,
    fieldSpecJson: JSON.stringify(fieldSpec),
    proposedBy,
    proposedAt,
    proposedReason,
    valueMapJson: suppliedMap === null ? null : JSON.stringify(suppliedMap),
    applied: false,
    appliedAt: null,
    resultingSchemaVersion: null,
    supersededByCode: false,
    archived: false
  };

  const engine = binding.engine;
  // The dataset assigns the proposal's id.
  const newId: Id | undefined =
    engine !== undefined
      ? (await writeInTx(binding.registry, ctx, args, 'createFieldProposal', initialParams)).id
      : (await args.dataset.write('FieldProposal', [initialParams])).ids[0];
  if (newId === undefined) throw new Error('dataset.write did not return an id for FieldProposal');

  // Step 5 — apply the field to the live registry
  try {
    applyUntilRollback(
      args,
      binding.registry,
      () =>
        applyFieldProposal({
          namespace: deps.namespace,
          targetType,
          fieldName,
          fieldSpec,
          registryStore: deps.registryStore,
          dataset: deps.dataset,
          edges: deps.edges
        }),
      () => binding.invalidateSchemaCaches?.()
    );
  } catch (cause) {
    throw new ProposalError(
      'field_already_exists',
      `Could not apply field '${fieldName}' to '${targetType}': ${cause instanceof Error ? cause.message : String(cause)}`,
      {},
      { cause }
    );
  }

  // Step 6 — mark the row as applied, stamping the schemaVersion that
  // RESULTED from the step-5 apply: the registry is already mutated, so
  // publishSchema reads the post-apply state.
  const now = new Date();
  const resultingSchemaVersion = publishSchema(binding.registry).schemaVersion;
  if (engine !== undefined) {
    await writeInTx(binding.registry, ctx, args, 'updateFieldProposal', {
      id: newId,
      applied: true,
      appliedAt: now,
      resultingSchemaVersion
    });
  }
  const readBack = await args.dataset.read('FieldProposal', { id: newId });
  const rawRow = readBack.rows[0];
  if (!rawRow) {
    throw new Error(`FieldProposal row ${newId} not found after write`);
  }
  let appliedRow: Row;
  if (engine !== undefined) {
    appliedRow = rawRow;
  } else {
    appliedRow = { ...rawRow, applied: true, appliedAt: now, resultingSchemaVersion };
    await args.dataset.write('FieldProposal', [appliedRow]);
  }

  // Step 7 — notify
  await notifyAfterCommit(args, () =>
    deps.pubsub.notify(deps.channelFor(deps.namespace), String(newId))
  );
  ensureStorageAfterCommit(args.afterTx, deps.dataset, targetType, deps.registryStore.storage);

  // Step 8 — return the applied row, carrying the migration summary when
  // the destructive path ran so its counts need no re-scan to read.
  if (migration === null) return appliedRow;
  const { ids: _written, ...summary } = migration;
  return { ...appliedRow, migration: summary };
}
