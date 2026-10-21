/**
 * `_system` drop-namespace + drop-type route handlers (spec §5.12 extension).
 *
 * Routes are admin-gated at compose level. Both emit AuditEvent
 * {kind: 'namespace_dropped' | 'type_dropped'} for every committed drop, and
 * with `cascade: "delete"` also delete the edges touching the target:
 *
 * - Shared substrate: `_system` and, under cascade=delete, the edges store
 *   have the dropped dataset's `txScopeId`, and the dataset implements
 *   `withScopedTransaction`. Row drop, edge drop and audit row all run in
 *   that one transaction and commit or roll back together. If the transaction
 *   yields no enlisted edges handle, the edge drop runs in its own edges
 *   transaction nested inside it, which commits just before the drop does.
 * - Otherwise: the row drop commits first, then the edge drop runs in its own
 *   edges transaction, then the audit row is written. A crash or failure
 *   between those steps leaves a drop without its edge cleanup or audit row.
 *
 * Dry-run rolls back every step, deletes no edges and writes no audit row.
 * The response still reports the counts, and returns a UUID for correlation.
 *
 * Scope is data-only: substrate rows, short-ids and (optionally) edges.
 * Schema declarations are not affected — a type still declared in
 * code/proposals reappears on next compose boot.
 */

import { randomUUID } from 'node:crypto';
import { assertHardDeleteAllowed, ResolverFrameError } from '@mnmal-ai/substrate-core';
import type {
  Dataset,
  DropParticipant,
  DropResult,
  EdgesStore,
  EngineHandle,
  HttpHandler,
  Row,
  SubstrateResponse,
  WriteOptions
} from '@mnmal-ai/substrate-types';
import { extractClientIp, jsonResponse } from '../routes/helpers.js';
import { buildAuditRow } from './install.js';
import { AUDIT_EVENT_TYPE, SYSTEM_NAMESPACE } from './types.js';

const SAMPLE_EDGE_LIMIT = 5;
const DANGLING_COUNT_CAP = 10_000;

function badRequest(code: string, message: string): SubstrateResponse {
  return jsonResponse(400, { code, message });
}

function parseBody(
  req: Parameters<HttpHandler>[0]
): { ok: true; value: unknown } | SubstrateResponse {
  const body = req.body;
  if (body === null || body.length === 0) {
    return badRequest('invalid_body', 'request body is required');
  }
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return badRequest('invalid_body', 'request body must be valid JSON');
  }
}

type Cascade = 'refuse' | 'delete';

export interface DropRouteDeps {
  resolveDataset: (namespace: string) => Dataset | null;
  edges: EdgesStore;
  now: () => Date;
  /**
   * Trusted proxy IPs for XFF resolution. Converted to a Set internally so
   * callers can supply either form — compose.ts passes Set<string>, tests
   * supply string[].
   */
  trustedProxies: string[] | Set<string>;
  /**
   * Does the caller hold `capability` in `namespace`? Asked of every other
   * namespace a drop's edges reach. Absent means auth is off: everything held.
   */
  holds?: (req: Parameters<HttpHandler>[0], namespace: string, capability: string) => boolean;
  /** Capability a cascade delete needs in each linked namespace. Defaults to `'admin'`. */
  adminCapability?: string;
}

export interface DropNamespaceRouteDeps extends DropRouteDeps {
  /**
   * Engine handle used to tombstone the namespace after a successful
   * (non-dry-run) drop. Without the tombstone, `federatedSchema()` / `query` /
   * `mutate` / `subscribe` keep serving the namespace until engine restart —
   * row delete and schema visibility are otherwise decoupled.
   */
  engine: EngineHandle;
}

function parseCascade(value: unknown): Cascade | null {
  if (value === undefined || value === 'refuse') return 'refuse';
  if (value === 'delete') return 'delete';
  return null;
}

function actorFromReq(req: Parameters<HttpHandler>[0]): string {
  const identity = req.identity;
  if (identity !== undefined && identity !== null) {
    const kid = identity.kid;
    if (typeof kid === 'string' && kid.length > 0) return kid;
    const id = (identity as { id?: string }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return 'unknown';
}

function toProxySet(trustedProxies: string[] | Set<string>): Set<string> {
  return trustedProxies instanceof Set ? trustedProxies : new Set(trustedProxies);
}

class DryRunRollback extends Error {
  constructor() {
    super('dry-run rollback');
    this.name = 'DryRunRollback';
  }
}

/** Rolls the drop back and answers with `response` instead. */
class DropRefused extends Error {
  constructor(readonly response: SubstrateResponse) {
    super('drop refused');
    this.name = 'DropRefused';
  }
}

/**
 * Kill-switch refusal for both drop routes: writes a `destructive_op_refused`
 * audit row (outside any tx) and returns a 403 with the resolver error's code
 * and message. The audit write is skipped if `_system` is not registered.
 */
async function emitRefusalAndRespond(
  deps: DropRouteDeps,
  req: Parameters<HttpHandler>[0],
  proxySet: Set<string>,
  err: ResolverFrameError,
  surface: 'drop_namespace' | 'drop_type',
  targetKid: string,
  extras: Record<string, unknown>,
  cascade: Cascade,
  dryRun: boolean
): Promise<SubstrateResponse> {
  const refusedNow = deps.now();
  const clientIp = extractClientIp(req, proxySet) ?? undefined;
  const actorKid = actorFromReq(req);
  const substrateDs = deps.resolveDataset(SYSTEM_NAMESPACE);
  if (substrateDs !== null) {
    await substrateDs.write(
      AUDIT_EVENT_TYPE,
      [
        buildAuditRow({
          actorKid,
          kind: 'destructive_op_refused',
          targetKid,
          clientIp,
          details: { surface, ...extras, cascade, dryRun },
          now: refusedNow
        })
      ],
      // Identity + clock for the substrate's `_metadata` auto-fill.
      { identity: { kind: 'agent', id: actorKid }, now: refusedNow }
    );
  }
  return jsonResponse(403, { code: err.code, message: err.message });
}

interface DropCounts {
  rowsDeleted: number;
  shortIdsDeleted: number;
  edgesDeleted: number;
  /** Set when no shared transaction ran the participants: the caller runs them after the commit. */
  participantsPending?: true;
}

interface DropPlan {
  /** Runs on the drop's edges handle after the row drop, before it commits; a response refuses it. */
  precheck: (edges: EdgesStore) => Promise<SubstrateResponse | null>;
  dropRows: (tx: Dataset) => Promise<DropResult>;
  /** Edge cleanup for cascade=delete; null leaves edges untouched. */
  dropEdges: ((edges: EdgesStore) => Promise<number>) | null;
  auditRow: (counts: DropCounts) => Row;
  writeOptions: WriteOptions;
  /** Plugins that act inside a namespace drop's transaction; none for a type drop. */
  participants: readonly DropParticipant[];
}

async function swallowDryRun(work: Promise<unknown>): Promise<SubstrateResponse | null> {
  try {
    await work;
  } catch (err) {
    if (err instanceof DropRefused) return err.response;
    if (!(err instanceof DryRunRollback)) throw err;
  }
  return null;
}

/**
 * The edge checks a drop runs before it commits. Under cascade=delete, the
 * caller must hold admin in every other namespace whose edges would go;
 * `authorise` receives those namespaces, and the edge delete is limited to
 * them. Under cascade=refuse, dangling edges answer 409. Either answer counts
 * and names only what the caller may read.
 */
async function edgePrecheck(
  deps: DropRouteDeps,
  req: Parameters<HttpHandler>[0],
  cascade: Cascade,
  edges: EdgesStore,
  target: { namespace: string; type?: string; label: string },
  authorise: (linked: string[]) => void
): Promise<SubstrateResponse | null> {
  const holds = deps.holds;
  const readable = (ns: string) => holds === undefined || holds(req, ns, 'read');
  if (cascade === 'delete') {
    if (holds === undefined) return null;
    const adminCap = deps.adminCapability ?? 'admin';
    const linked = await edges.namespacesLinkedTo(target.namespace, target.type);
    const denied = linked.find((ns) => !holds(req, ns, adminCap));
    if (denied === undefined) {
      authorise(linked);
      return null;
    }
    if (!readable(denied)) {
      return jsonResponse(403, {
        code: 'forbidden',
        message: 'cascade="delete" would delete edges in a namespace you cannot read'
      });
    }
    return jsonResponse(403, {
      code: 'forbidden',
      message: `cascade="delete" would delete edges in namespace '${denied}'`,
      required: `${denied}:${adminCap}`
    });
  }
  const find = (limit: number) =>
    target.type === undefined
      ? edges.findEdgesTouchingNamespace(target.namespace, limit)
      : edges.findEdgesTouchingType(target.namespace, target.type, limit);
  const sample = await find(SAMPLE_EDGE_LIMIT + 1);
  if (sample.length === 0) return null;
  const visible = (await find(DANGLING_COUNT_CAP)).filter(
    (e) => readable(e.from.ns) && readable(e.to.ns)
  );
  return jsonResponse(409, {
    code: 'dangling_edges',
    message: `edges reference ${target.label}; pass cascade="delete" to drop them`,
    edgeCount: visible.length,
    sampleEdges: visible.slice(0, SAMPLE_EDGE_LIMIT)
  });
}

/**
 * Executes `plan` against `dataset` with the transaction layout described in
 * the file header, rolling every step back when `dryRun` is true.
 *
 * @returns The counts deleted, or that would have been deleted on a dry run;
 *   or the precheck's response when it refused the drop.
 * @throws Error when `_system` is not registered and `dryRun` is false.
 */
async function runDrop(
  deps: DropRouteDeps,
  dataset: Dataset,
  namespace: string,
  dryRun: boolean,
  plan: DropPlan
): Promise<DropCounts | SubstrateResponse> {
  const substrateDs = deps.resolveDataset(SYSTEM_NAMESPACE);
  if (substrateDs === null && !dryRun) {
    throw new Error('_system dataset is not registered — compose is misconfigured');
  }
  const { dropEdges } = plan;
  const counts: DropCounts = { rowsDeleted: 0, shortIdsDeleted: 0, edgesDeleted: 0 };
  const dropRowsVia = async (tx: Dataset): Promise<void> => {
    const res = await plan.dropRows(tx);
    counts.rowsDeleted = res.rowsDeleted;
    counts.shortIdsDeleted = res.shortIdsDeleted;
  };
  const dropEdgesVia = async (edges: EdgesStore): Promise<void> => {
    if (dropEdges !== null) counts.edgesDeleted = await dropEdges(edges);
  };
  // After the row drop, inside its transaction, so an edge written before the
  // rows go is seen and refuses the drop or joins the edge drop rather than
  // dangling. shortcut: an edge committed after this check and before the drop
  // commits still dangles; lock the edges table for the drop to close that.
  const check = async (edges: EdgesStore): Promise<void> => {
    const refusal = await plan.precheck(edges);
    if (refusal !== null) throw new DropRefused(refusal);
  };

  const participantNs = [...new Set(plan.participants.flatMap((p) => p.namespaces))].filter(
    (ns) => ns !== namespace && ns !== SYSTEM_NAMESPACE
  );
  const sharesTxScope =
    substrateDs !== null &&
    substrateDs.txScopeId === dataset.txScopeId &&
    dataset.withScopedTransaction !== undefined &&
    (dropEdges === null || deps.edges.txScopeId === dataset.txScopeId) &&
    participantNs.every((ns) => deps.resolveDataset(ns)?.txScopeId === dataset.txScopeId);

  if (sharesTxScope) {
    const scope = [namespace, SYSTEM_NAMESPACE, ...participantNs];
    const refused = await swallowDryRun(
      dataset.withScopedTransaction!(scope, async (handles) => {
        const txDataset = (ns: string): Dataset => {
          const ds = handles.datasets.get(ns);
          if (ds === undefined) throw new Error(`drop transaction has no dataset for '${ns}'`);
          return ds;
        };
        const body = async (txEdges: EdgesStore): Promise<void> => {
          await dropRowsVia(handles.datasets.get(namespace)!);
          await check(txEdges);
          await dropEdgesVia(txEdges);
          for (const participant of plan.participants) {
            await participant.onDrop(namespace, txDataset);
          }
          if (dryRun) throw new DryRunRollback();
          await handles.datasets
            .get(SYSTEM_NAMESPACE)!
            .write(AUDIT_EVENT_TYPE, [plan.auditRow(counts)], plan.writeOptions);
        };
        if (handles.edges !== null) await body(handles.edges);
        else await deps.edges.withTransaction(body);
      })
    );
    return refused ?? counts;
  }

  // No shared transaction: the edge check runs inside the row drop's.
  const refusal = await swallowDryRun(
    dataset.withTransaction(async (tx) => {
      await dropRowsVia(tx);
      await check(deps.edges);
      if (dryRun) throw new DryRunRollback();
    })
  );
  if (refusal !== null) return refusal;
  if (dropEdges !== null) {
    await swallowDryRun(
      deps.edges.withTransaction(async (tx) => {
        await dropEdgesVia(tx);
        if (dryRun) throw new DryRunRollback();
      })
    );
  }
  if (!dryRun) {
    await substrateDs!.write(AUDIT_EVENT_TYPE, [plan.auditRow(counts)], plan.writeOptions);
    if (plan.participants.length > 0) counts.participantsPending = true;
  }
  return counts;
}

export function dropNamespaceRoute(deps: DropNamespaceRouteDeps): HttpHandler {
  const proxySet = toProxySet(deps.trustedProxies);
  return async (req) => {
    const parsed = parseBody(req);
    if (!('ok' in parsed)) return parsed;
    const body = parsed.value as Record<string, unknown>;

    const namespace = typeof body.namespace === 'string' ? body.namespace : '';
    const confirm = typeof body.confirm === 'string' ? body.confirm : '';
    const dryRun = body.dryRun === true;
    const cascade = parseCascade(body.cascade);

    if (namespace.length === 0) return badRequest('invalid_namespace', 'namespace is required');
    if (cascade === null)
      return badRequest('invalid_cascade', 'cascade must be "refuse" or "delete"');
    if (namespace === SYSTEM_NAMESPACE) {
      return jsonResponse(403, {
        code: 'forbidden_namespace',
        message: '_system cannot be dropped'
      });
    }
    if (confirm !== namespace)
      return badRequest('confirm_mismatch', 'confirm must equal namespace');

    const dataset = deps.resolveDataset(namespace);
    if (dataset === null) {
      return jsonResponse(404, {
        code: 'unknown_namespace',
        message: `namespace '${namespace}' is not registered`
      });
    }

    // Kill switch: SUBSTRATE_HARD_DELETE=refuse short-circuits before any
    // state-touching call.
    try {
      assertHardDeleteAllowed();
    } catch (err) {
      if (err instanceof ResolverFrameError && err.code === 'destructive_ops_disabled') {
        return emitRefusalAndRespond(
          deps,
          req,
          proxySet,
          err,
          'drop_namespace',
          namespace,
          { namespace },
          cascade,
          dryRun
        );
      }
      throw err;
    }

    const now = deps.now();
    const clientIp = extractClientIp(req, proxySet) ?? undefined;
    const actorKid = actorFromReq(req);
    const auditId = randomUUID();
    let within: string[] | undefined;
    const result = await runDrop(deps, dataset, namespace, dryRun, {
      precheck: (edges) =>
        edgePrecheck(
          deps,
          req,
          cascade,
          edges,
          { namespace, label: `namespace '${namespace}'` },
          (linked) => {
            within = linked;
          }
        ),
      dropRows: (tx) => tx.dropNamespace(),
      dropEdges:
        cascade === 'delete' ? (edges) => edges.dropEdgesByNamespace(namespace, within) : null,
      auditRow: (counts) =>
        buildAuditRow({
          actorKid,
          kind: 'namespace_dropped',
          targetKid: namespace,
          clientIp,
          details: { cascade, ...counts, auditId },
          now
        }),
      writeOptions: { identity: { kind: 'agent', id: actorKid }, now },
      participants: deps.engine.dropParticipants()
    });
    if ('status' in result) return result;
    const { rowsDeleted, edgesDeleted, shortIdsDeleted } = result;

    // No shared transaction (memory, or a host whose datasets sit on different
    // substrates): the participants run now, after the commit, each one's
    // failure reported rather than stopping the tombstone below.
    // shortcut: not atomic on this path; a failure leaves what that participant owns undone, named in `warnings`.
    const warnings: string[] = [];
    if (result.participantsPending === true) {
      for (const participant of deps.engine.dropParticipants()) {
        try {
          await participant.onDrop(namespace, (ns) => {
            const ds = deps.resolveDataset(ns);
            if (ds === null) throw new Error(`no dataset for '${ns}'`);
            return ds;
          });
        } catch (err) {
          warnings.push(
            `drop participant for ${participant.namespaces.join(', ')} failed after the drop committed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    // After a real drop, mark the namespace tombstoned on the engine so
    // schema / query / mutate / subscribe stop serving it immediately. Skipped
    // on dry-run (the tx rolled back so nothing was deleted).
    if (!dryRun) {
      deps.engine.tombstoneNamespace(namespace);
    }

    return jsonResponse(200, {
      namespace,
      dryRun,
      cascade,
      rowsDeleted,
      edgesDeleted,
      shortIdsDeleted,
      auditEventId: auditId,
      ...(warnings.length > 0 && { warnings })
    });
  };
}

export function dropTypeRoute(deps: DropRouteDeps): HttpHandler {
  const proxySet = toProxySet(deps.trustedProxies);
  return async (req) => {
    const parsed = parseBody(req);
    if (!('ok' in parsed)) return parsed;
    const body = parsed.value as Record<string, unknown>;

    const namespace = typeof body.namespace === 'string' ? body.namespace : '';
    const type = typeof body.type === 'string' ? body.type : '';
    const confirm = typeof body.confirm === 'string' ? body.confirm : '';
    const dryRun = body.dryRun === true;
    const cascade = parseCascade(body.cascade);

    if (namespace.length === 0) return badRequest('invalid_namespace', 'namespace is required');
    if (type.length === 0) return badRequest('invalid_type', 'type is required');
    if (cascade === null)
      return badRequest('invalid_cascade', 'cascade must be "refuse" or "delete"');
    if (namespace === SYSTEM_NAMESPACE) {
      return jsonResponse(403, {
        code: 'forbidden_namespace',
        message: '_system types cannot be dropped'
      });
    }
    const expectedConfirm = `${namespace}/${type}`;
    if (confirm !== expectedConfirm) {
      return badRequest('confirm_mismatch', `confirm must equal "${expectedConfirm}"`);
    }

    const dataset = deps.resolveDataset(namespace);
    if (dataset === null) {
      return jsonResponse(404, {
        code: 'unknown_namespace',
        message: `namespace '${namespace}' is not registered`
      });
    }

    // Kill switch: SUBSTRATE_HARD_DELETE=refuse short-circuits before any
    // state-touching call.
    try {
      assertHardDeleteAllowed();
    } catch (err) {
      if (err instanceof ResolverFrameError && err.code === 'destructive_ops_disabled') {
        return emitRefusalAndRespond(
          deps,
          req,
          proxySet,
          err,
          'drop_type',
          expectedConfirm,
          { namespace, type },
          cascade,
          dryRun
        );
      }
      throw err;
    }

    const now = deps.now();
    const clientIp = extractClientIp(req, proxySet) ?? undefined;
    const actorKid = actorFromReq(req);
    const auditId = randomUUID();
    let within: string[] | undefined;
    const result = await runDrop(deps, dataset, namespace, dryRun, {
      precheck: (edges) =>
        edgePrecheck(
          deps,
          req,
          cascade,
          edges,
          { namespace, type, label: expectedConfirm },
          (linked) => {
            within = linked;
          }
        ),
      dropRows: (tx) => tx.dropType(type),
      dropEdges:
        cascade === 'delete' ? (edges) => edges.dropEdgesByType(namespace, type, within) : null,
      auditRow: (counts) =>
        buildAuditRow({
          actorKid,
          kind: 'type_dropped',
          targetKid: expectedConfirm,
          clientIp,
          details: { cascade, ...counts, auditId },
          now
        }),
      writeOptions: { identity: { kind: 'agent', id: actorKid }, now },
      participants: []
    });
    if ('status' in result) return result;
    const { rowsDeleted, edgesDeleted, shortIdsDeleted } = result;

    return jsonResponse(200, {
      namespace,
      type,
      dryRun,
      cascade,
      rowsDeleted,
      edgesDeleted,
      shortIdsDeleted,
      auditEventId: auditId
    });
  };
}
