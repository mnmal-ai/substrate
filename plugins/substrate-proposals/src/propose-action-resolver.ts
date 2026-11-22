/**
 * Factory for the propose_action mutation resolver: coins an update shortcut
 * on a stored type, which its proposer may use at once and nobody else may
 * until it is promoted.
 *
 * `define` compiles to this mutation, but any `mutate` can send it raw JSON,
 * so every part of the params is checked here, and the stored declaration is
 * rebuilt from the checked parts. The record is written through the trusted
 * path and joins the action layer once the caller's transaction commits.
 */

import { assertTypeActions, resolveIdentity } from '@mnmal-ai/substrate-sdk';
import {
  type ActionDecl,
  type ActionParamDecl,
  type ActionSetValue,
  BUILT_IN_ACTIONS,
  canonicalize,
  checkIdentityGrant,
  type EngineHandle,
  type FieldDef,
  grantRefusal,
  grantRefusalCode,
  type RequestContext,
  type ResolverArgs,
  ResolverFrameError,
  type Row,
  type Schema,
  type TypeSchema
} from '@mnmal-ai/substrate-types';
import {
  ACTIONS_CHANNEL,
  isLapsed,
  LAPSE_MS,
  MAX_PENDING_PER_PROPOSER,
  type ProposalActionLayer
} from './action-layer.js';
import type { PubSub } from './config.js';
import { CONTROL_NAMESPACE } from './control-plane.js';
import { notifyAfterCommit, writeInTx } from './engine-write.js';
import { ProposalError } from './errors.js';
import { PROPOSAL_TYPE_NAMES } from './namespace.js';
import { proposalLockKey, withProposalLock } from './proposal-lock.js';
import type { RegistryStore } from './registry-store.js';
import { lockedRow } from './row-lock.js';

export interface ProposeActionResolverDeps {
  registryStore: RegistryStore;
  pubsub: PubSub;
  now: () => Date;
  /** The layer the plugin's `onStart` builds; undefined until then. */
  layer: () => ProposalActionLayer | undefined;
}

const WORD = /^[a-z][A-Za-z0-9]{1,31}$/;
const RESERVED: ReadonlySet<string> = new Set([...BUILT_IN_ACTIONS, 'define']);
/** Names that would reach the prototype chain of the objects they key. */
const UNSAFE: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

interface Input {
  namespace: string;
  type: string;
  name: string;
  sketch: string;
  decl: Record<string, unknown>;
}

const invalid = (message: string, param: string): ProposalError =>
  new ProposalError('invalid_params', message, { param });

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseInput(params: Record<string, unknown>): Input {
  for (const key of ['namespace', 'type', 'name', 'sketch']) {
    if (typeof params[key] !== 'string') throw invalid(`'${key}' must be a string`, key);
  }
  const { namespace, type, name, sketch, decl } = params as unknown as Input;
  if (!WORD.test(name) || UNSAFE.has(name)) {
    throw invalid(`action name must match ${WORD.source}, and not be '${name}'`, 'name');
  }
  if (!isObject(decl)) throw invalid("'decl' must be an object", 'decl');
  return { namespace, type, name, sketch, decl };
}

/**
 * The type a coined word may go on: a stored type of a namespace on this
 * engine that is not virtual, not `_system*`, and not a proposal record type.
 */
function coinableType(
  registryStore: RegistryStore,
  engine: EngineHandle,
  namespace: string,
  type: string
): TypeSchema {
  const refuse = (why: string, param: string) =>
    invalid(`'${namespace}/${type}' ${why}; coined words go on stored types`, param);
  if (namespace.startsWith('_system')) throw refuse('is in a system namespace', 'namespace');
  let schema: Schema;
  try {
    schema = engine.schemaFor(namespace);
  } catch (err) {
    // `schemaFor` refuses an unknown or tombstoned namespace with this message.
    if (!(err instanceof Error) || !err.message.startsWith('unknown namespace')) throw err;
    throw new ProposalError('unknown_type', `namespace '${namespace}' is not on this server`, {
      namespace
    });
  }
  if (schema.virtual === true) throw refuse('is in a virtual namespace', 'namespace');
  const target = Object.hasOwn(schema.types, type) ? schema.types[type] : undefined;
  if (target === undefined) {
    throw new ProposalError('unknown_type', `'${namespace}/${type}' is not a type`, {
      targetType: type
    });
  }
  if (
    registryStore.ownsNamespace(namespace) &&
    (PROPOSAL_TYPE_NAMES as readonly string[]).includes(type)
  ) {
    throw refuse('holds proposal records', 'type');
  }
  if (schema.mutations[`update${type}`]?.writesRows !== true) throw refuse('is not stored', 'type');
  return target;
}

/** A field's type as a param of it takes it: without what only the server may set. */
function paramTypeOf(def: FieldDef): FieldDef {
  if (def.kind !== 'scalar') return def;
  const { readonly: _readonly, serverSet: _serverSet, ...rest } = def;
  return rest;
}

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));

/**
 * The declaration rebuilt from checked parts: an update with an optional past
 * word, params each typed as the field it fills, and a set of literals,
 * `{ param }` and `{ now: true }`. No `then`, no list params, no defaults.
 */
function checkedDecl(raw: Record<string, unknown>, fields: Record<string, FieldDef>): ActionDecl {
  for (const key of Object.keys(raw)) {
    if (key === 'then') throw invalid('a coined word takes no then', 'decl.then');
    if (!['kind', 'past', 'params', 'set'].includes(key)) {
      throw invalid(`a coined word's decl has no '${key}'`, `decl.${key}`);
    }
  }
  if (raw.kind !== undefined && raw.kind !== 'update') {
    throw invalid("a coined word is an update: kind must be 'update'", 'decl.kind');
  }
  const { past } = raw;
  if (past !== undefined && (typeof past !== 'string' || !WORD.test(past))) {
    throw invalid(`past must match ${WORD.source}`, 'decl.past');
  }
  const rawParams = raw.params ?? {};
  if (!isObject(rawParams)) throw invalid("'decl.params' must be an object", 'decl.params');
  const params: Record<string, ActionParamDecl> = {};
  for (const [param, p] of Object.entries(rawParams)) {
    const at = `decl.params.${param}`;
    if (UNSAFE.has(param)) throw invalid(`'${param}' cannot name a param`, at);
    if (!isObject(p)) throw invalid(`param '${param}' must be an object`, at);
    if ('list' in p) throw invalid('a coined word takes no list params', at);
    for (const key of Object.keys(p)) {
      if (key !== 'type' && key !== 'optional') {
        throw invalid(`param '${param}' has no '${key}'`, at);
      }
    }
    if (p.optional !== undefined && typeof p.optional !== 'boolean') {
      throw invalid(`param '${param}': optional must be a boolean`, at);
    }
    params[param] = {
      type: p.type as FieldDef,
      ...(p.optional === true ? { optional: true } : {})
    };
  }
  const rawSet = raw.set ?? {};
  if (!isObject(rawSet)) throw invalid("'decl.set' must be an object", 'decl.set');
  const set: Record<string, ActionSetValue> = {};
  for (const [field, v] of Object.entries(rawSet)) {
    const at = `decl.set.${field}`;
    const def = Object.hasOwn(fields, field) ? fields[field] : undefined;
    if (def === undefined) throw invalid(`'${field}' is not a field of the type`, at);
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      set[field] = v as string | number | boolean | null;
    } else if (isObject(v) && Object.keys(v).length === 1 && v.now === true) {
      set[field] = { now: true };
    } else if (isObject(v) && Object.keys(v).length === 1 && typeof v.param === 'string') {
      const param = Object.hasOwn(params, v.param) ? params[v.param] : undefined;
      if (param === undefined) throw invalid(`set uses undeclared param '${v.param}'`, at);
      if (!('type' in param) || !sameJson(param.type, paramTypeOf(def))) {
        throw invalid(`param '${v.param}' must have the type of field '${field}'`, at);
      }
      set[field] = { param: v.param };
    } else {
      throw invalid(`'${field}' takes a literal, { param } or { now: true }`, at);
    }
  }
  return { kind: 'update', ...(typeof past === 'string' ? { past } : {}), params, set };
}

export function makeProposeActionResolver(
  deps: ProposeActionResolverDeps
): (ctx: RequestContext, args: ResolverArgs) => Promise<Row> {
  return async (ctx, args) => {
    // Alone, the store read below sees only committed rows, and the cap sees every
    // earlier write: entries sharing a transaction would see neither.
    if ((args.txEntries ?? 1) > 1) {
      throw new ProposalError(
        'propose_action_not_alone',
        'propose_action must be the only entry in its mutate request; send it on its own',
        { entries: args.txEntries }
      );
    }
    const input = parseInput(args.params ?? {});
    const { namespace, type, name } = input;
    const gate = checkIdentityGrant(ctx.identity, namespace, 'mutate');
    if (!gate.ok)
      throw new ResolverFrameError(grantRefusalCode(gate), grantRefusal(namespace, gate));
    const binding = deps.registryStore.getBinding(CONTROL_NAMESPACE);
    const layer = deps.layer();
    if (binding.engine === undefined || layer === undefined) {
      throw new ProposalError(
        'engine_not_wired',
        'propose_action runs once the plugin has started'
      );
    }
    // Refused before the lock and any row write.
    const target = coinableType(deps.registryStore, binding.engine, namespace, type);
    const qualified = `${namespace}/${type}`;
    const taken = (why: string) =>
      new ProposalError('action_taken', `${qualified}.${name} ${why}`, { type: qualified, name });
    if (RESERVED.has(name) || Object.hasOwn(target.actions ?? {}, name)) {
      throw taken('is already an action of the type');
    }
    const decl = checkedDecl(input.decl, target.fields);
    try {
      assertTypeActions(type, { fields: target.fields, actions: { [name]: decl } });
    } catch (err) {
      throw invalid(err instanceof Error ? err.message : String(err), 'decl');
    }
    const proposer = resolveIdentity(ctx).id;
    const declJson = JSON.stringify(canonicalize(decl));
    // The caller's transaction, so the lock, reads and writes share its one connection.
    const dataset = args.dataset ?? binding.dataset;
    const txArgs = { ...args, dataset };
    return withProposalLock(
      dataset,
      proposalLockKey('action', namespace, `${type}.${name}`),
      async () => {
        // A define committed a moment ago may not have reached this instance's
        // layer yet, so the name's committed records are applied first.
        const { rows } = await dataset.read('ActionProposal', {
          where: {
            AND: [
              { targetNamespace: { eq: namespace } },
              { targetType: { eq: type } },
              { name: { eq: name } }
            ]
          },
          limit: 1000
        });
        for (const row of rows) layer.apply(row);
        const state = layer.nameState(qualified, name, proposer);
        if (state === 'taken') throw taken('is taken by another pending or published word');
        if (state === 'closed') {
          throw taken('was vetoed, retired or superseded by code, and stays closed');
        }

        const now = deps.now();
        const own = rows.find(
          (r) => r.proposedBy === proposer && r.status === 'pending' && r.archived !== true
        );
        const lapsed = own !== undefined && isLapsed(own, now);
        // An identical redefinition keeps the record, and its count, as it is.
        if (own !== undefined && !lapsed && own.declJson === declJson) return own;
        // shortcut: the cap is read from this instance's layer, so concurrent defines of
        // different names may pass it together; lock per proposer if that matters.
        if (
          (own === undefined || lapsed) &&
          layer.pendingCount(proposer, namespace, now) >= MAX_PENDING_PER_PROPOSER
        ) {
          throw new ProposalError(
            'pending_cap',
            `you hold ${MAX_PENDING_PER_PROPOSER} live pending words in '${namespace}'; one frees when it lapses after ${LAPSE_MS / 86_400_000} days unused`,
            { namespace, cap: MAX_PENDING_PER_PROPOSER }
          );
        }
        if (own !== undefined) {
          // A use may have promoted the word since the read above; its row lock settles it.
          const held = await lockedRow('ActionProposal', own.id, dataset);
          if (
            held === null ||
            held.id !== own.id ||
            held.status !== 'pending' ||
            held.archived === true
          ) {
            throw taken('was promoted or closed while this define ran, and stays as it is');
          }
        }

        const written =
          own === undefined
            ? await writeInTx(
                binding.registry,
                ctx,
                txArgs,
                'createActionProposal',
                {
                  targetNamespace: namespace,
                  targetType: type,
                  name,
                  declJson,
                  sketch: input.sketch,
                  proposedBy: proposer,
                  proposedAt: now,
                  status: 'pending',
                  uses: 0,
                  lastUseAt: null,
                  promotedAt: null,
                  resultingSchemaVersion: null,
                  supersededByCode: false,
                  archived: false
                },
                true,
                true
              )
            : await writeInTx(
                binding.registry,
                ctx,
                txArgs,
                'updateActionProposal',
                // A lapsed word defined again identically revives with its count;
                // a different definition starts counting again.
                own.declJson === declJson
                  ? { id: own.id, proposedAt: now }
                  : {
                      id: own.id,
                      declJson,
                      sketch: input.sketch,
                      proposedAt: now,
                      uses: 0,
                      lastUseAt: null
                    },
                true,
                true
              );
        const row = (await dataset.read('ActionProposal', { id: written.id })).rows[0];
        if (row === undefined)
          throw new Error(`ActionProposal ${written.id} not found after write`);
        await notifyAfterCommit(txArgs, async () => {
          layer.apply(row);
          await deps.pubsub.notify(ACTIONS_CHANNEL, String(row.id));
        });
        return row;
      }
    );
  };
}
