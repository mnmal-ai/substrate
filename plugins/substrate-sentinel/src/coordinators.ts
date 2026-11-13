/**
 * Coordinator registration and the topology feed, independent of transport:
 * `handleRegister` upserts the coordinator, its namespaces and bridges and
 * tracks the peer; `handleWatch` adds a watcher; `handleClose` marks a
 * registrant offline and tells the watchers. `stream-routes.ts` mounts them.
 *
 * `register` needs the 'mutate' capability (it writes the coordinator table)
 * and `watch` needs 'read' (it subscribes to the topology broadcast).
 */

import type { EngineHandle, Identity, PackEnvelope } from '@mnmal-ai/substrate/sdk';
import {
  formatQualifiedKey,
  grantedIn,
  grantOf,
  makeCtx,
  queryAll,
  resolveIdentity
} from '@mnmal-ai/substrate/sdk';
import type { CoordinatorConnection, LivenessRegistry, PeerConnection } from './liveness.js';

interface BridgeInfo {
  name: string;
  url: string;
  allowMutate: boolean;
  allowPropose: boolean;
}

// `id` is the autoCRUD-supplied UUID string, not a number; a numeric type
// makes every coordinatorId FK read reject (see namespace.ts).
interface CoordinatorRow {
  id: string;
  name: string;
  url: string;
  namespaces: string;
  status: string;
  lastHeartbeat: string;
  registeredAt: string;
  version: string;
}

interface CoordinatorNsRow {
  id: string;
  coordinatorId: string;
  name: string;
  typeCount: number;
  schemaHash: string;
  url: string;
}

interface BridgeRow {
  id: string;
  coordinatorId: string;
  name: string;
  targetUrl: string;
  allowMutate: boolean;
  allowPropose: boolean;
}

const COORDINATOR_FIELDS: Record<string, true> = {
  id: true,
  name: true,
  url: true,
  namespaces: true,
  status: true,
  lastHeartbeat: true,
  registeredAt: true,
  version: true
};

const COORDINATOR_NS_FIELDS: Record<string, true> = {
  id: true,
  coordinatorId: true,
  name: true,
  typeCount: true,
  schemaHash: true,
  url: true
};

const BRIDGE_FIELDS: Record<string, true> = {
  id: true,
  coordinatorId: true,
  name: true,
  targetUrl: true,
  allowMutate: true,
  allowPropose: true
};

async function engineMutate<T>(
  engine: EngineHandle,
  namespace: string,
  mutationName: string,
  params: Record<string, unknown>,
  fields: Record<string, true>,
  identity: Identity | null
): Promise<T | undefined> {
  const key = formatQualifiedKey(namespace, mutationName);
  const env: PackEnvelope = await engine.mutate({
    frame: { [key]: { params, fields } },
    ctx: makeCtx(namespace, 'mutate', identity)
  });
  const row = env.data[key];
  if (row === undefined || row === null) return undefined;
  // Single-row mutations return the row object directly; array mutations wrap.
  return row as T;
}

// ── register/upsert helpers ───────────────────────────────────────────────────

interface UpsertResult {
  registered: boolean;
  updated: boolean;
  coordinator: CoordinatorRow | undefined;
  /** The name or URL belongs to a row another identity created; nothing was written. */
  foreign?: true;
}

type OwnedCoordinatorRow = CoordinatorRow & {
  _metadata?: { createdBy?: { kind?: string; id?: string } | null };
};

function queryOwned(
  engine: EngineHandle,
  namespace: string,
  identity: Identity | null,
  where: Record<string, unknown>
): Promise<Array<OwnedCoordinatorRow>> {
  return queryAll<OwnedCoordinatorRow>(
    engine,
    namespace,
    'Coordinator',
    { where },
    { ...COORDINATOR_FIELDS, _metadata: { createdBy: true } } as unknown as Record<string, true>,
    identity
  );
}

/** The actor a write by `identity` records as `createdBy`; null when it cannot be attributed. */
function actorOf(identity: Identity | null): { kind: string; id: string } | null {
  try {
    return resolveIdentity({ identity });
  } catch {
    return null;
  }
}

async function upsertCoordinator(
  engine: EngineHandle,
  namespace: string,
  identity: Identity | null,
  data: { name: string; url: string; namespaces: Array<string>; version?: string }
): Promise<UpsertResult> {
  const now = new Date().toISOString();
  const byName = await queryOwned(engine, namespace, identity, { name: { eq: data.name } });
  const byUrl = await queryOwned(engine, namespace, identity, { url: { eq: data.url } });
  // A name is not a credential, and neither is a URL: only the identity that
  // created a row may repoint it, or advertise its URL under another name
  // (whose offline event would otherwise drop the URL's bridges everywhere).
  // A row with no recorded creator belongs to nobody who can prove it, so only
  // an admin of this namespace (its types keep the default 'admin') may
  // reclaim it.
  const actor = actorOf(identity);
  const isAdmin = grantsCapability(identity ?? undefined, namespace, 'admin');
  const ownedByCaller = (row: OwnedCoordinatorRow): boolean => {
    const by = row._metadata?.createdBy;
    if (by === null || by === undefined) return isAdmin;
    return actor !== null && by.kind === actor.kind && by.id === actor.id;
  };
  if (![...byName, ...byUrl].every(ownedByCaller)) {
    return { registered: false, updated: false, coordinator: undefined, foreign: true };
  }
  const prior = byName[0];

  if (prior !== undefined) {
    const updateParams: Record<string, unknown> = {
      id: prior.id,
      url: data.url,
      namespaces: data.namespaces.join(','),
      status: 'online',
      lastHeartbeat: now
    };
    if (data.version !== undefined) updateParams.version = data.version;
    const updated = await engineMutate<CoordinatorRow>(
      engine,
      namespace,
      'updateCoordinator',
      updateParams,
      COORDINATOR_FIELDS,
      identity
    );
    if (updated !== undefined) {
      await syncNamespaces(engine, namespace, identity, updated.id, data.url, data.namespaces);
    }
    return { registered: true, updated: true, coordinator: updated };
  }

  const createParams: Record<string, unknown> = {
    name: data.name,
    url: data.url,
    namespaces: data.namespaces.join(','),
    status: 'online',
    lastHeartbeat: now,
    registeredAt: now,
    version: data.version ?? ''
  };
  const created = await engineMutate<CoordinatorRow>(
    engine,
    namespace,
    'createCoordinator',
    createParams,
    COORDINATOR_FIELDS,
    identity
  );
  if (created !== undefined) {
    await syncNamespaces(engine, namespace, identity, created.id, data.url, data.namespaces);
  }
  return { registered: true, updated: false, coordinator: created };
}

async function syncNamespaces(
  engine: EngineHandle,
  namespace: string,
  identity: Identity | null,
  coordinatorId: string,
  coordinatorUrl: string,
  desired: Array<string>
): Promise<void> {
  const existing = await queryAll<CoordinatorNsRow>(
    engine,
    namespace,
    'CoordinatorNamespace',
    { where: { coordinatorId: { eq: coordinatorId } } },
    COORDINATOR_NS_FIELDS,
    identity
  );
  const existingNames = new Set(existing.map((e) => e.name));
  const desiredSet = new Set(desired);

  for (const ns of desired) {
    if (existingNames.has(ns)) continue;
    await engineMutate(
      engine,
      namespace,
      'createCoordinatorNamespace',
      {
        coordinatorId,
        name: ns,
        url: coordinatorUrl,
        typeCount: 0,
        schemaHash: ''
      },
      { id: true },
      identity
    );
  }

  for (const entry of existing) {
    if (desiredSet.has(entry.name)) continue;
    await engineMutate(
      engine,
      namespace,
      'deleteCoordinatorNamespace',
      { id: entry.id },
      { id: true },
      identity
    );
  }
}

async function syncBridges(
  engine: EngineHandle,
  namespace: string,
  identity: Identity | null,
  coordinatorId: string,
  bridges: Array<BridgeInfo>
): Promise<void> {
  const existing = await queryAll<BridgeRow>(
    engine,
    namespace,
    'CoordinatorBridge',
    { where: { coordinatorId: { eq: coordinatorId } } },
    BRIDGE_FIELDS,
    identity
  );
  const desiredNames = new Set(bridges.map((b) => b.name));
  const existingByName = new Map(existing.map((e) => [e.name, e]));

  for (const bridge of bridges) {
    const prev = existingByName.get(bridge.name);
    if (prev === undefined) {
      await engineMutate(
        engine,
        namespace,
        'createCoordinatorBridge',
        {
          coordinatorId,
          name: bridge.name,
          targetUrl: bridge.url,
          allowMutate: bridge.allowMutate,
          allowPropose: bridge.allowPropose
        },
        { id: true },
        identity
      );
      continue;
    }
    if (
      prev.targetUrl !== bridge.url ||
      prev.allowMutate !== bridge.allowMutate ||
      prev.allowPropose !== bridge.allowPropose
    ) {
      await engineMutate(
        engine,
        namespace,
        'updateCoordinatorBridge',
        {
          id: prev.id,
          targetUrl: bridge.url,
          allowMutate: bridge.allowMutate,
          allowPropose: bridge.allowPropose
        },
        BRIDGE_FIELDS,
        identity
      );
    }
  }

  for (const entry of existing) {
    if (desiredNames.has(entry.name)) continue;
    await engineMutate(
      engine,
      namespace,
      'deleteCoordinatorBridge',
      { id: entry.id },
      { id: true },
      identity
    );
  }
}

// ── frame dispatch ────────────────────────────────────────────────────────────

/**
 * Does this identity hold `capability` IN `namespace`?
 *
 * Resolved through `grantOf` — the SAME function the server's own gates use —
 * so this verdict cannot drift from what the engine enforces.
 */
export function grantsCapability(
  identity: Identity | undefined,
  namespace: string,
  capability: string
): boolean {
  if (identity === undefined) return false;
  return grantedIn(grantOf(identity), namespace).includes(capability);
}

export function sendJson(conn: PeerConnection, payload: unknown): void {
  try {
    conn.send(JSON.stringify(payload));
  } catch {
    // Peer gone mid-send; liveness tick will reap.
  }
}

export function parseFrame(buf: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(buf.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function normaliseNamespaces(raw: unknown): Array<string> {
  if (!Array.isArray(raw)) return [];
  const out: Array<string> = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out;
}

function normaliseBridges(raw: unknown): Array<BridgeInfo> {
  if (!Array.isArray(raw)) return [];
  const out: Array<BridgeInfo> = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.name !== 'string' ||
      typeof r.url !== 'string' ||
      typeof r.allowMutate !== 'boolean' ||
      typeof r.allowPropose !== 'boolean'
    ) {
      continue;
    }
    out.push({
      name: r.name,
      url: r.url,
      allowMutate: r.allowMutate,
      allowPropose: r.allowPropose
    });
  }
  return out;
}

/** Why a register was refused, with the HTTP status a frame-stream route answers. */
export interface RegisterRefusal {
  error: string;
  status: 400 | 403 | 409 | 500;
}

/**
 * Upsert the coordinator, track `conn` for it, send the register reply, then
 * broadcast `online`. A refusal is returned for the caller to deliver as an
 * HTTP status, before any stream opens.
 */
export async function handleRegister(
  engine: EngineHandle,
  namespace: string,
  identity: Identity | null,
  registry: LivenessRegistry,
  conn: PeerConnection,
  frame: Record<string, unknown>
): Promise<RegisterRefusal | undefined> {
  const name = typeof frame.name === 'string' ? frame.name : undefined;
  const url = typeof frame.url === 'string' ? frame.url : undefined;
  if (name === undefined || url === undefined) {
    return { error: 'register requires name and url', status: 400 };
  }
  const namespaces = normaliseNamespaces(frame.namespaces);
  const version = typeof frame.version === 'string' ? frame.version : undefined;
  const bridges = normaliseBridges(frame.bridges);

  const upsertArgs: { name: string; url: string; namespaces: Array<string>; version?: string } = {
    name,
    url,
    namespaces
  };
  if (version !== undefined) upsertArgs.version = version;
  // Ownership is the recorded creator, so a caller that cannot be recorded as
  // one could never update its own row after the first register.
  if (actorOf(identity) === null) {
    return {
      error:
        "register requires an attributable identity (an agent key, a token, or a system actor); this one cannot be recorded as the coordinator row's creator",
      status: 403
    };
  }
  const result = await upsertCoordinator(engine, namespace, identity, upsertArgs);
  if (result.foreign === true) {
    return {
      error: `coordinator '${name}' or url '${url}' is registered by another identity`,
      status: 409
    };
  }
  const coordinator = result.coordinator;
  if (coordinator === undefined) {
    return { error: 'failed to upsert coordinator record', status: 500 };
  }

  const meta: CoordinatorConnection = { name, coordinatorId: coordinator.id, url };
  registry.addCoordinator(conn, meta);

  if (bridges.length > 0) {
    await syncBridges(engine, namespace, identity, coordinator.id, bridges);
  }

  sendJson(conn, {
    ok: true,
    registered: result.registered,
    updated: result.updated,
    coordinator
  });

  registry.broadcastEvent({
    event: 'online',
    name,
    url,
    namespaces,
    bridges: bridges.map((b) => ({
      name: b.name,
      url: b.url,
      allowMutate: b.allowMutate,
      allowPropose: b.allowPropose
    }))
  });
  return undefined;
}

export function handleWatch(registry: LivenessRegistry, conn: PeerConnection): void {
  registry.addWatcher(conn);
  sendJson(conn, { ok: true, watching: true });
}

export async function handleClose(
  engine: EngineHandle,
  namespace: string,
  identity: Identity | null,
  registry: LivenessRegistry,
  conn: PeerConnection
): Promise<void> {
  const meta = registry.removeCoordinator(conn);
  registry.removeWatcher(conn);
  if (meta === undefined) return;
  try {
    await engineMutate(
      engine,
      namespace,
      'updateCoordinator',
      { id: meta.coordinatorId, status: 'offline' },
      { id: true, status: true },
      identity
    );
  } catch {
    // Coordinator row may have been purged between register and close;
    // tolerate the missing row rather than crashing the close pipeline.
  }
  registry.broadcastEvent({ event: 'offline', name: meta.name, url: meta.url });
}
