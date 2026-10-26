/**
 * Factory for the propose_type mutation resolver.
 *
 * Validates ownership, deduplicates pending proposals, stores the TypeProposal
 * row, applies the type to the live Registry via applyTypeProposal, marks the
 * row applied, and emits a PubSub notification.
 *
 * Writes route through the autoCRUD `createTypeProposal` resolver on the
 * caller's own transaction when the engine handle is wired (production:
 * onStart wires it), which populates `_metadata`, allocates `shortId`, and
 * fires the `postWrite` hook. When the engine is unwired (resolver-direct test
 * harnesses that don't boot an engine), the resolver falls back to raw
 * `dataset.write` — the writes happen but autoCRUD's surrounding effects do
 * not.
 *
 * The registry apply is taken back if the caller's transaction rolls back
 * (`applyUntilRollback`), so the type never outlives its row.
 */

import { randomUUID } from 'node:crypto';
import { publishSchema } from '@mnmal-ai/substrate-core';
import { resolveIdentity } from '@mnmal-ai/substrate-sdk';
import type {
  Dataset,
  EdgesStore,
  RequestContext,
  ResolverArgs,
  Row
} from '@mnmal-ai/substrate-types';
import { applyTypeProposal, assertValidTypeProposal, typeProposalRegistryKeys } from './apply.js';
import type { PubSub } from './config.js';
import {
  applyUntilRollback,
  ensureStorageAfterCommit,
  notifyAfterCommit,
  writeInTx
} from './engine-write.js';
import { ProposalError } from './errors.js';
import type { FieldSpecJson } from './field-spec-json.js';
import { proposalLockKey, withProposalLock } from './proposal-lock.js';
import type { RegistryStore } from './registry-store.js';

export interface ProposeTypeResolverDeps {
  namespace: string;
  ownedNamespaces: ReadonlySet<string>;
  registryStore: RegistryStore;
  dataset: Dataset;
  edges: EdgesStore;
  pubsub: PubSub;
  /** Typically `ns => \`_substrate_proposals_${ns}\`` */
  channelFor: (ns: string) => string;
}

export interface ProposeTypeInput {
  typeName: string;
  fields: Record<string, FieldSpecJson>;
  proposedReason: string;
}

function parseInput(params: Record<string, unknown>): ProposeTypeInput {
  const { proposedReason } = params;
  if (proposedReason !== undefined && typeof proposedReason !== 'string') {
    throw new ProposalError('invalid_params', "'proposedReason' must be a string", {
      param: 'proposedReason'
    });
  }
  return { ...params, proposedReason: proposedReason ?? '' } as ProposeTypeInput;
}

export function makeProposeTypeResolver(
  deps: ProposeTypeResolverDeps
): (ctx: RequestContext, args: ResolverArgs) => Promise<Row> {
  return async (ctx: RequestContext, args: ResolverArgs): Promise<Row> => {
    // Step 1 — namespace ownership gate. Accept the static ownedNamespaces set
    // captured at construction OR any namespace registered in registryStore
    // (the latter covers hot-added namespaces from propose_namespace).
    if (!deps.ownedNamespaces.has(deps.namespace) && !deps.registryStore.has(deps.namespace)) {
      throw new ProposalError(
        'unowned_namespace',
        `Namespace '${deps.namespace}' is not owned by this plugin instance`
      );
    }

    const input = parseInput(args.params ?? {});
    // Refused before the lock and any row write. A crossRef may target an
    // owned type that exists, or the type being proposed.
    assertValidTypeProposal(
      input.typeName,
      input.fields,
      (ns, type) =>
        (ns === deps.namespace && type === input.typeName) || deps.registryStore.ownsType(ns, type)
    );
    // The caller's transaction, so the lock, reads and writes share its one
    // connection.
    const dataset = args.dataset ?? deps.dataset;
    return withProposalLock(dataset, proposalLockKey('type', deps.namespace, input.typeName), () =>
      proposeTypeLocked(deps, ctx, { ...args, dataset }, input)
    );
  };
}

/** Steps 2-7, run while holding the proposal lock for this type name. */
async function proposeTypeLocked(
  deps: ProposeTypeResolverDeps,
  ctx: RequestContext,
  args: ResolverArgs & { dataset: Dataset },
  input: ProposeTypeInput
): Promise<Row> {
  const { typeName, fields, proposedReason } = input;
  // The signed caller, never a param: the row is the audit trail.
  const proposedBy = resolveIdentity(ctx).id;

  // Step 2 — check for an existing non-archived proposal for the same type
  const existing = await args.dataset.read('TypeProposal', {
    where: {
      AND: [{ typeName: { eq: typeName } }, { archived: { eq: false } }]
    },
    limit: 1
  });

  if (existing.rows.length > 0) {
    const prior = existing.rows[0] as Row & {
      proposedBy: string;
      proposedAt: Date | string;
    };
    throw new ProposalError(
      'type_already_proposed',
      `TypeProposal for '${typeName}' already exists (proposed by ${String(prior.proposedBy)})`,
      { by: prior.proposedBy, at: prior.proposedAt }
    );
  }

  // Refuse what step 4 would reject BEFORE the step-3 row write, so a refusal
  // never leaves an applied=false row behind. After step 2, so a type applied
  // by an earlier proposal still reports `type_already_proposed`.
  const liveRegistry = deps.registryStore.getBinding(deps.namespace).registry;
  if (liveRegistry.has(typeName)) {
    throw new ProposalError(
      'type_already_exists',
      `Type '${typeName}' is already registered in namespace '${deps.namespace}'`
    );
  }
  const takenKey = typeProposalRegistryKeys({
    typeName,
    fields,
    dataset: deps.dataset,
    edges: deps.edges
  }).find((key) => liveRegistry.has(key));
  if (takenKey !== undefined) {
    throw new ProposalError(
      'type_already_exists',
      `Type '${typeName}' would register operation '${takenKey}', which is already registered in namespace '${deps.namespace}'`
    );
  }

  // Step 3 — write the initial proposal row (applied=false). Through
  // autoCRUD when the engine is wired (production); raw dataset.write
  // otherwise (resolver-direct tests).
  const proposedAt = new Date();
  const fieldsJson = JSON.stringify(fields);
  const newId = randomUUID();
  const initialParams: Record<string, unknown> = {
    id: newId,
    typeName,
    fieldsJson,
    proposedBy,
    proposedAt,
    proposedReason,
    applied: false,
    appliedAt: null,
    resultingSchemaVersion: null,
    supersededByCode: false,
    archived: false
  };

  const binding = deps.registryStore.getBinding(deps.namespace);
  const engine = binding.engine;

  if (engine !== undefined) {
    await writeInTx(binding.registry, ctx, args, 'createTypeProposal', initialParams);
  } else {
    const writeResult = await args.dataset.write('TypeProposal', [initialParams as Row]);
    if (!writeResult.ids[0]) {
      throw new Error('dataset.write did not return an id for TypeProposal');
    }
  }

  // Step 4 — apply the type to the live registry
  try {
    applyUntilRollback(
      args,
      binding.registry,
      () =>
        applyTypeProposal({
          namespace: deps.namespace,
          typeName,
          fields,
          registryStore: deps.registryStore,
          dataset: deps.dataset,
          edges: deps.edges
        }),
      () => binding.invalidateSchemaCaches?.()
    );
  } catch (cause) {
    throw new ProposalError(
      'type_already_exists',
      `Could not apply type '${typeName}': ${cause instanceof Error ? cause.message : String(cause)}`,
      {},
      { cause }
    );
  }

  // Step 5 — mark the row as applied, stamping the schemaVersion that
  // RESULTED from the step-4 apply (publishSchema over the mutated registry).
  const now = new Date();
  const resultingSchemaVersion = publishSchema(binding.registry).schemaVersion;
  let appliedRow: Row;

  if (engine !== undefined) {
    appliedRow = await writeInTx(binding.registry, ctx, args, 'updateTypeProposal', {
      id: newId,
      applied: true,
      appliedAt: now,
      resultingSchemaVersion
    });
    // autoCRUD's update returns `{ id }` on the projection above. The full
    // row shape is what callers expect — re-read so the downstream consumer
    // (e.g. envelope encoder) sees every field.
    const readBack = await args.dataset.read('TypeProposal', { id: newId });
    const rawRow = readBack.rows[0];
    if (!rawRow) {
      throw new Error(`TypeProposal row ${newId} not found after engine update`);
    }
    appliedRow = rawRow;
  } else {
    const readBack = await args.dataset.read('TypeProposal', { id: newId });
    const rawRow = readBack.rows[0];
    if (!rawRow) {
      throw new Error(`TypeProposal row ${newId} not found after write`);
    }
    appliedRow = { ...rawRow, applied: true, appliedAt: now, resultingSchemaVersion };
    await args.dataset.write('TypeProposal', [appliedRow]);
  }

  // Step 6 — notify
  await notifyAfterCommit(args, () =>
    deps.pubsub.notify(deps.channelFor(deps.namespace), String(newId))
  );
  ensureStorageAfterCommit(args.afterTx, deps.dataset, typeName);

  // Step 7 — return the applied row
  return appliedRow;
}
