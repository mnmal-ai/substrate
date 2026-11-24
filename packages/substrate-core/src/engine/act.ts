/**
 * `act`: a sketch compiled against the schema its caller can read, then run
 * as that caller, step by step in one transaction.
 */

import type {
  ActInput,
  ActionLayer,
  ActMode,
  ActPlanStep,
  ActResponse,
  ActResultRecord,
  ActResultStore,
  ActStepOutcome,
  AfterTxWork,
  Dataset,
  DatasetRegistry,
  EdgesStore,
  FrameEntry,
  Identity,
  PackEnvelope,
  Row,
  Schema,
  WriteEvent
} from '@mnmal-ai/substrate-types';
import { idHint, toActionSchema } from '@mnmal-ai/substrate-types';
import { compileSketch } from '../act/compile.js';
import {
  ActDryRunRollback,
  ActStepFailure,
  formatAck,
  inlineFinds,
  MAX_STORED_ROWS,
  newResultId,
  ownerKeyOf,
  planLine,
  stepOutcome
} from '../act/outcome.js';
import { actorOf, type CommittedWritesQueue } from './committed-writes.js';
import type { EntryRunner } from './entry-run.js';
import {
  buildContext,
  buildParsedKeyCache,
  checkIdentityGrant,
  type MetricFn,
  type NamespaceConfig,
  type ParsedKey
} from './internals.js';
import type { LocalTx, TxPartition } from './local-tx.js';
import { partitionMutateByTxScope } from './mutate.js';
import type { SchemaSubsystem } from './schema.js';
import type { SubscribeSubsystem } from './subscribe.js';

export interface ActSubsystemDeps {
  namespaces: Map<string, NamespaceConfig>;
  datasets: DatasetRegistry;
  metric: MetricFn;
  schema: SchemaSubsystem;
  runner: EntryRunner;
  tx: LocalTx;
  committed: CommittedWritesQueue;
  subscribe: SubscribeSubsystem;
  act: { results: ActResultStore; ttlMs: number; maxWriteSteps: number };
  /** The installed action layer, read on each call: it is set after construction. */
  actionLayer: () => ActionLayer | undefined;
  makeEnvelope: (keys: string[], parsedByKey: Map<string, ParsedKey | null>) => PackEnvelope;
}

export class ActSubsystem {
  readonly #namespaces: Map<string, NamespaceConfig>;
  readonly #datasets: DatasetRegistry;
  readonly #metric: MetricFn;
  readonly #schema: SchemaSubsystem;
  readonly #runner: EntryRunner;
  readonly #tx: LocalTx;
  readonly #committed: CommittedWritesQueue;
  readonly #subscribe: SubscribeSubsystem;
  readonly #act: ActSubsystemDeps['act'];
  readonly #layer: ActSubsystemDeps['actionLayer'];
  readonly #makeEnvelope: ActSubsystemDeps['makeEnvelope'];
  /** `act` runs under an idempotency key that have not finished, keyed `ownerKey \0 key`. */
  readonly #inFlightActs = new Map<string, Promise<ActResponse>>();

  constructor(deps: ActSubsystemDeps) {
    this.#namespaces = deps.namespaces;
    this.#datasets = deps.datasets;
    this.#metric = deps.metric;
    this.#schema = deps.schema;
    this.#runner = deps.runner;
    this.#tx = deps.tx;
    this.#committed = deps.committed;
    this.#subscribe = deps.subscribe;
    this.#act = deps.act;
    this.#layer = deps.actionLayer;
    this.#makeEnvelope = deps.makeEnvelope;
  }

  get #actionLayer(): ActionLayer | undefined {
    return this.#layer();
  }

  /**
   * Runs a sketch as the caller: compiled against the schema the caller can
   * read, every step through `runEntry` in one transaction, write hooks on
   * commit only, and a result record only the caller can read.
   */
  async act(input: ActInput): Promise<ActResponse> {
    if (input.mode !== undefined && input.mode !== 'write' && input.mode !== 'dry-run') {
      return {
        ok: false,
        error: { code: 'bad_request', message: "mode must be 'write' or 'dry-run'" },
        result: null
      };
    }
    const identity = input.ctx.identity ?? null;
    if (identity === null) {
      return {
        ok: false,
        error: { code: 'unauthorized', message: 'act needs a signed caller' },
        result: null
      };
    }
    // Records and keys belong to the whole credential, so a narrower grant under the same id shares none.
    const ownerKey = ownerKeyOf(identity);
    const key = (input.mode ?? 'write') === 'write' ? input.idempotencyKey : undefined;
    if (key === undefined) return this.#actRun(input, identity, ownerKey);
    // The store sees the key only once the first run ends; a retry meanwhile joins that run.
    const flightKey = `${ownerKey}\0${key}`;
    const running = this.#inFlightActs.get(flightKey);
    if (running !== undefined) return running;
    const run = (async (): Promise<ActResponse> => {
      const found = await this.#act.results.findByIdempotencyKey(ownerKey, key);
      if (found !== undefined) {
        return { ok: true, ack: found.ack ?? '', result: found.id, ...inlineFinds(found.steps) };
      }
      return this.#actRun(input, identity, ownerKey);
    })();
    this.#inFlightActs.set(flightKey, run);
    try {
      return await run;
    } finally {
      this.#inFlightActs.delete(flightKey);
    }
  }

  async actResult(id: string, identity: Identity | null): Promise<ActResultRecord | undefined> {
    return identity === null ? undefined : this.#act.results.get(id, ownerKeyOf(identity));
  }

  async #actRun(input: ActInput, identity: Identity, ownerKey: string): Promise<ActResponse> {
    const { results, ttlMs, maxWriteSteps } = this.#act;
    const mode = input.mode ?? 'write';
    const schema: Record<string, Schema> = Object.fromEntries(
      Object.entries(this.#schema.federatedSchema()).filter(
        ([ns]) => checkIdentityGrant(identity, ns, 'query').ok
      )
    );
    // The caller's pending words join their types; the cached schema is copied, never mutated.
    // `identity.id` must name the principal propose_action records as the proposer (resolveIdentity(ctx).id).
    const pendingKeys = new Set<string>();
    for (const [qualified, words] of Object.entries(
      this.#actionLayer?.pendingFor(identity.id) ?? {}
    )) {
      const [ns = '', typeName = ''] = qualified.split('/');
      const nsSchema = schema[ns];
      const type = nsSchema?.types[typeName];
      if (nsSchema === undefined || type === undefined) continue;
      const actions = { ...type.actions };
      for (const [name, p] of Object.entries(words)) {
        if (Object.hasOwn(actions, name)) continue;
        actions[name] = { ...toActionSchema(p.decl), pending: { uses: p.uses, needed: p.needed } };
        pendingKeys.add(`${qualified}.${name}`);
      }
      schema[ns] = { ...nsSchema, types: { ...nsSchema.types, [typeName]: { ...type, actions } } };
    }
    const localNamespaces = new Set(
      [...this.#namespaces]
        .filter(([ns, cfg]) => cfg.virtual !== true && this.#datasets.get(ns) !== undefined)
        .map(([ns]) => ns)
    );
    const compiled = compileSketch(input.sketch, schema, {
      ...(input.namespace !== undefined ? { defaultNamespace: input.namespace } : {}),
      localNamespaces,
      maxWriteSteps,
      ...(this.#actionLayer !== undefined ? { defineKey: this.#actionLayer.proposeKey } : {})
    });
    if ('refusal' in compiled) return { ok: false, refusal: compiled.refusal };
    if (!('plan' in compiled)) return { ok: true, help: compiled.help };
    const { plan, help } = compiled;

    // A proposal never shares a transaction, so a leading `define` commits first and the rest runs as one after it.
    const [first] = plan.steps;
    const coined =
      first?.action === 'define' && plan.steps.length > 1
        ? `${first.type}.${(first.params as { name: string }).name}`
        : undefined;
    if (coined !== undefined) pendingKeys.add(coined);
    const phases =
      coined !== undefined ? [plan.steps.slice(0, 1), plan.steps.slice(1)] : [plan.steps];
    const outcomes: ActStepOutcome[] = [];
    let error: { code: string; message: string; step?: number } | undefined;
    for (const [i, steps] of phases.entries()) {
      error = await this.#actPhase(input, mode, steps, outcomes);
      if (error === undefined) continue;
      if (i > 0 && mode === 'write') {
        error = { ...error, message: `${error.message} (step 1 committed: ${coined} is defined)` };
      }
      break;
    }
    if (error === undefined && mode === 'write' && pendingKeys.size > 0) {
      const used = new Map<string, { type: string; name: string }>();
      for (const s of plan.steps) {
        const k = `${s.type}.${s.action}`;
        if (pendingKeys.has(k)) used.set(k, { type: s.type, name: s.action });
      }
      if (used.size > 0) {
        try {
          this.#actionLayer?.used(identity.id, [...used.values()], input.ctx.now ?? new Date());
        } catch (err) {
          // The write committed: a failing layer must not turn it into an error reply.
          this.#metric('engine_act_layer_used_failed', {
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    const ack = formatAck(plan, outcomes, mode);
    const id = newResultId();
    const createdAt = new Date();
    const record: ActResultRecord = {
      id,
      owner: identity.id,
      ownerKey,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
      mode,
      ok: error === undefined,
      ...(error === undefined ? { ack } : { error }),
      ...(error === undefined && mode === 'write' && input.idempotencyKey !== undefined
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
      schemaVersion: this.#schema.federatedSchemaVersion(),
      sketch: input.sketch,
      plan,
      steps: outcomes
    };
    let result: string | null = id;
    try {
      await results.put(record, ttlMs);
    } catch (err) {
      // The write may have committed: failing the call would invite a retry that repeats it.
      this.#metric('engine_act_result_store_failed', {
        error: err instanceof Error ? err.message : String(err)
      });
      result = null;
    }
    return error === undefined
      ? {
          ok: true,
          ack,
          result,
          ...inlineFinds(outcomes),
          ...(mode === 'dry-run' ? { plan: plan.steps.map(planLine) } : {}),
          ...(help !== undefined ? { help } : {})
        }
      : { ok: false, error, result };
  }

  /** Partitions `steps` by transaction scope and runs them as one transaction; resolves the failure, or undefined. */
  async #actPhase(
    input: ActInput,
    mode: ActMode,
    steps: ActPlanStep[],
    outcomes: ActStepOutcome[]
  ): Promise<{ code: string; message: string; step?: number } | undefined> {
    // A crossRef `#N` is looked up on its target type, so that type joins the transaction.
    const refTypes = steps.flatMap((s) =>
      Object.values(s.late ?? {}).flatMap((l) => ('ref' in l ? [l.ref.type] : []))
    );
    const keys = [...new Set([...steps.map((s) => s.key), ...refTypes])];
    const parsedByKey = buildParsedKeyCache(keys);
    const partition = partitionMutateByTxScope(keys, parsedByKey, this.#datasets);
    if (partition.kind === 'cross_tx_scope_refused') {
      this.#metric('engine_cross_tx_scope_refused', { namespaces: partition.namespaces });
      return { code: 'cross_tx_scope_refused', message: partition.message };
    }
    // Unreachable: the compiler admits only namespaces with a dataset.
    if (partition.kind === 'zero_datasets') throw new Error('act plan names no dataset');
    return this.#actSteps(input, mode, steps, parsedByKey, partition, outcomes);
  }

  /**
   * Runs `steps` in one transaction, filling late values as each step comes
   * up, and dispatches their write events only if it commits. Pushes each
   * step's outcome; resolves the failure, or undefined.
   */
  async #actSteps(
    input: ActInput,
    mode: ActMode,
    steps: ActPlanStep[],
    parsedByKey: Map<string, ParsedKey | null>,
    partition: TxPartition,
    outcomes: ActStepOutcome[]
  ): Promise<{ code: string; message: string; step?: number } | undefined> {
    const now = input.ctx.now ?? new Date();
    const queryCtx = buildContext({ ...input.ctx, now }, 'query');
    const mutateCtx = buildContext({ ...input.ctx, now }, 'mutate');
    const pending: WriteEvent[] = [];
    const settled: AfterTxWork[] = [];
    const binds = new Map<string, unknown>();
    let rowBudget = MAX_STORED_ROWS;
    const body = async (
      txFor: (ns: string) => Dataset | null,
      txEdges: EdgesStore
    ): Promise<void> => {
      // One entry through the caller's grant and policy; any refusal fails `step`.
      const run = async (
        step: ActPlanStep,
        key: string,
        entry: FrameEntry,
        operation: 'query' | 'mutate'
      ): Promise<PackEnvelope> => {
        const envelope = this.#makeEnvelope([key], parsedByKey);
        const parsed = parsedByKey.get(key) ?? null;
        const thrown = await this.#runner.runEntry(
          envelope,
          key,
          entry,
          operation === 'query' ? queryCtx : mutateCtx,
          operation,
          parsed === null ? null : txFor(parsed.ns),
          txEdges,
          parsed,
          (event) => pending.push(event),
          input.signal,
          (fn) => settled.push(fn),
          steps.length
        );
        const refusal = envelope.errors?.find((e) => e.path?.[0] === key);
        if (thrown || refusal !== undefined) {
          throw new ActStepFailure({
            code: refusal?.code ?? 'resolver_error',
            // The resolver's shortId hint names a `where` shape no sketch writes.
            message: refusal?.message.replace(idHint(''), '') ?? `'${key}' refused`,
            step: step.step
          });
        }
        return envelope;
      };
      const maxLimit = input.pageLimits?.maxLimit;
      for (const step of steps) {
        const params = { ...step.params };
        if (step.action === 'find' && maxLimit !== undefined) {
          params.limit = Math.min(Number(params.limit), maxLimit);
        }
        for (const [field, late] of Object.entries(step.late ?? {})) {
          if ('bind' in late) params[field] = binds.get(late.bind);
          else if ('now' in late) params[field] = now.toISOString();
          else {
            const { type, shortId } = late.ref;
            const where = { shortId: { eq: shortId } };
            const found = await run(
              step,
              type,
              { params: { where, limit: 1 }, fields: { id: true } },
              'query'
            );
            const row = (found.data[type] as Row[] | undefined)?.[0];
            if (row === undefined) {
              throw new ActStepFailure({
                code: 'not_found',
                message: `no ${type} #${shortId}`,
                step: step.step
              });
            }
            params[field] = row.id;
          }
        }
        const envelope = await run(step, step.key, { params, fields: step.fields }, step.operation);
        const outcome = stepOutcome(step, envelope, rowBudget);
        rowBudget -= outcome.rows?.length ?? 0;
        if (step.bind !== undefined) binds.set(step.bind, outcome.touched?.[0]?.id);
        outcomes.push(outcome);
      }
      if (mode === 'dry-run') throw new ActDryRunRollback();
    };
    let committed = false;
    try {
      const scopeRefusal = await this.#tx.inLocalTx(partition, body);
      if (scopeRefusal !== undefined) {
        return { code: 'cross_tx_scope_refused', message: scopeRefusal };
      }
      committed = true;
      this.#subscribe.dispatchWrites(pending);
      if (this.#committed.active) {
        this.#committed.queue(pending, actorOf(input.ctx.identity ?? null));
      }
      return undefined;
    } catch (err) {
      if (err instanceof ActStepFailure) return err.error;
      if (err instanceof ActDryRunRollback) return undefined;
      throw err;
    } finally {
      await this.#tx.runSettled(settled, committed);
    }
  }
}
