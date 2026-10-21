import type {
  Dataset,
  EngineHandle,
  NamespaceConfig,
  PackEnvelope,
  Registry,
  WsConnection
} from '@mnmal-ai/substrate/sdk';
import { describe, expect, it } from 'vitest';
import {
  type CoordinatorConnection,
  createLivenessRegistry,
  runLivenessTick
} from '../src/liveness.js';

function makeConn(overrides: Partial<WsConnection> = {}): {
  conn: WsConnection;
  sent: Array<string>;
  closed: Array<boolean>;
} {
  const sent: Array<string> = [];
  const closed: Array<boolean> = [];
  const conn: WsConnection = {
    id: `conn-${Math.random().toString(36).slice(2)}`,
    send: (frame) => {
      sent.push(typeof frame === 'string' ? frame : Buffer.from(frame).toString('utf8'));
    },
    onMessage: () => undefined,
    onClose: () => undefined,
    close: (code) => {
      closed.push(code !== undefined);
    },
    ...overrides
  };
  return { conn, sent, closed };
}

function emptyEnvelope(): PackEnvelope {
  return {
    schemaVersion: 'test',
    data: {},
    shapes: {}
  };
}

function makeEngine(): {
  engine: EngineHandle;
  mutates: Array<{ frame: Record<string, unknown> }>;
} {
  const mutates: Array<{ frame: Record<string, unknown> }> = [];
  const engine: EngineHandle = {
    query: async () => emptyEnvelope(),
    mutate: async (input) => {
      mutates.push({ frame: input.frame as Record<string, unknown> });
      return emptyEnvelope();
    },
    invalidateSchemaCaches: (): void => {},
    addNamespace: (_ns: string, _config: NamespaceConfig): void => {
      throw new Error('test fake: addNamespace not supported');
    },
    tombstoneNamespace: (_ns: string): void => {},
    removeNamespace: () => {},
    namespaceState: () => 'absent' as const,
    onNamespaceTombstoned: () => () => {},
    addDropParticipant: () => () => {},
    dropParticipants: () => [],
    evaluateReadPolicy: () => ({ allow: true }),
    createRegistry: (): Registry => {
      throw new Error('test fake: createRegistry not supported');
    },
    datasetFor: (_ns: string): Dataset | undefined => undefined
  };
  return { engine, mutates };
}

const TEST_THRESHOLD_MS = 60_000;

function makeClockedRegistry(): {
  registry: ReturnType<typeof createLivenessRegistry>;
  advance: (ms: number) => void;
} {
  let clock = 1_000_000;
  const registry = createLivenessRegistry({
    staleThresholdMs: TEST_THRESHOLD_MS,
    now: () => clock
  });
  return {
    registry,
    advance: (ms) => {
      clock += ms;
    }
  };
}

describe('createLivenessRegistry', () => {
  it('round-trips addCoordinator / removeCoordinator metadata', () => {
    const { registry } = makeClockedRegistry();
    const { conn } = makeConn();
    const meta: CoordinatorConnection = { name: 'a', coordinatorId: '42', url: 'http://a' };
    registry.addCoordinator(conn, meta);
    expect(registry.coordinators().map((e) => e.meta)).toEqual([meta]);
    const removed = registry.removeCoordinator(conn);
    expect(removed).toEqual(meta);
    expect(registry.coordinators()).toHaveLength(0);
    expect(registry.removeCoordinator(conn)).toBeUndefined();
  });

  it('a re-registration supersedes the older socket for the same coordinator row', async () => {
    const { registry, advance } = makeClockedRegistry();
    const { engine, mutates } = makeEngine();
    const { conn: stale, closed } = makeConn();
    const { conn: fresh } = makeConn();
    const meta: CoordinatorConnection = { name: 'a', coordinatorId: '42', url: 'http://a' };
    registry.addCoordinator(stale, meta);
    advance(TEST_THRESHOLD_MS / 2);
    registry.addCoordinator(fresh, meta);

    expect(closed).toHaveLength(1);
    // The old socket's close is now a no-op: nothing to mark offline.
    expect(registry.removeCoordinator(stale)).toBeUndefined();
    advance(TEST_THRESHOLD_MS / 2 + 1);
    await runLivenessTick(registry, engine, 'sentinel');
    expect(mutates).toHaveLength(0);
    expect(registry.coordinators().map((e) => e.conn)).toEqual([fresh]);
  });

  it('drainStale returns only sockets silent for longer than the threshold', () => {
    const { registry, advance } = makeClockedRegistry();
    const { conn: alive } = makeConn();
    const { conn: zombie } = makeConn();
    registry.addCoordinator(alive, { name: 'alive', coordinatorId: '1', url: '' });
    registry.addCoordinator(zombie, { name: 'zombie', coordinatorId: '2', url: '' });

    advance(TEST_THRESHOLD_MS);
    expect(registry.drainStale()).toEqual([]);

    registry.markAlive(alive);
    advance(1);
    expect(registry.drainStale()).toEqual([zombie]);
  });

  it('markAlive refreshes the heartbeat for both coordinators and watchers', () => {
    const { registry, advance } = makeClockedRegistry();
    const { conn: coord } = makeConn();
    const { conn: watcher } = makeConn();
    registry.addCoordinator(coord, { name: 'c', coordinatorId: '1', url: '' });
    registry.addWatcher(watcher);

    advance(TEST_THRESHOLD_MS + 1);
    expect(registry.drainStale()).toHaveLength(2);

    registry.markAlive(coord);
    registry.markAlive(watcher);
    expect(registry.drainStale()).toEqual([]);
  });

  it('broadcastEvent reaches every watcher but not coordinators', () => {
    const { registry } = makeClockedRegistry();
    const coord = makeConn();
    const watcherA = makeConn();
    const watcherB = makeConn();
    registry.addCoordinator(coord.conn, { name: 'c', coordinatorId: '1', url: '' });
    registry.addWatcher(watcherA.conn);
    registry.addWatcher(watcherB.conn);

    registry.broadcastEvent({ event: 'online', name: 'c' });
    expect(coord.sent).toEqual([]);
    expect(watcherA.sent).toHaveLength(1);
    expect(watcherB.sent).toHaveLength(1);
    expect(JSON.parse(watcherA.sent[0] ?? '') as Record<string, unknown>).toEqual({
      event: 'online',
      name: 'c'
    });
  });

  it('addWatcher is idempotent — double-registering does not send twice', () => {
    const { registry } = makeClockedRegistry();
    const watcher = makeConn();
    registry.addWatcher(watcher.conn);
    registry.addWatcher(watcher.conn);
    registry.broadcastEvent({ event: 'online' });
    expect(watcher.sent).toHaveLength(1);
  });
});

describe('runLivenessTick', () => {
  it('returns 0/0 when there are no tracked sockets', async () => {
    const { registry } = makeClockedRegistry();
    const { engine } = makeEngine();
    const result = await runLivenessTick(registry, engine, 'sentinel');
    expect(result).toEqual({ stalePinged: 0, markedOffline: 0 });
  });

  it('evicts coordinators silent past the threshold and marks them offline', async () => {
    const { registry, advance } = makeClockedRegistry();
    const { engine, mutates } = makeEngine();
    const zombie = makeConn();
    const alive = makeConn();
    registry.addCoordinator(zombie.conn, { name: 'zombie', coordinatorId: '1', url: 'http://z' });
    registry.addCoordinator(alive.conn, { name: 'alive', coordinatorId: '2', url: 'http://a' });

    // Tick 1: nobody is stale yet, both get a ping.
    advance(TEST_THRESHOLD_MS / 2);
    let result = await runLivenessTick(registry, engine, 'sentinel');
    expect(result.markedOffline).toBe(0);
    expect(result.stalePinged).toBe(2);
    expect(zombie.sent.some((m) => m.includes('"ping"'))).toBe(true);
    expect(alive.sent.some((m) => m.includes('"ping"'))).toBe(true);

    // Alive responds to the ping; zombie stays silent.
    registry.markAlive(alive.conn);

    // Tick 2: zombie's last heartbeat is past the threshold, so it is evicted.
    advance(TEST_THRESHOLD_MS);
    result = await runLivenessTick(registry, engine, 'sentinel');
    expect(result.markedOffline).toBe(1);
    expect(zombie.closed).toEqual([true]);
    expect(registry.coordinators()).toHaveLength(1);
    expect(registry.coordinators()[0]?.meta.name).toBe('alive');

    // The eviction should have mutated the Coordinator row via engine.mutate.
    const updateCalls = mutates.filter((m) => 'sentinel/updateCoordinator' in m.frame);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('broadcasts offline to remaining watchers when a coordinator is evicted', async () => {
    const { registry, advance } = makeClockedRegistry();
    const { engine } = makeEngine();
    const zombie = makeConn();
    const watcher = makeConn();
    registry.addCoordinator(zombie.conn, { name: 'zombie', coordinatorId: '99', url: 'http://z' });
    registry.addWatcher(watcher.conn);

    // Tick 1: pings.
    advance(TEST_THRESHOLD_MS / 2);
    await runLivenessTick(registry, engine, 'sentinel');
    // Watcher received a ping; clear it to acknowledge and keep it alive.
    registry.markAlive(watcher.conn);
    watcher.sent.length = 0;

    // Tick 2: zombie evicted, offline event broadcast to watcher.
    advance(TEST_THRESHOLD_MS);
    await runLivenessTick(registry, engine, 'sentinel');
    const parsed = watcher.sent
      .map((m) => JSON.parse(m) as Record<string, unknown>)
      .filter((m) => m.event === 'offline');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe('zombie');
  });
});

describe('runLivenessTick — staleThresholdMs', () => {
  const PING_MS = 30_000;
  const THRESHOLD_MS = 90_000;

  function setup(): {
    registry: ReturnType<typeof createLivenessRegistry>;
    engine: EngineHandle;
    coord: ReturnType<typeof makeConn>;
    advanceTo: (ms: number) => void;
  } {
    const start = 1_000_000;
    let clock = start;
    const registry = createLivenessRegistry({
      staleThresholdMs: THRESHOLD_MS,
      now: () => clock
    });
    const { engine } = makeEngine();
    const coord = makeConn();
    registry.addCoordinator(coord.conn, { name: 'c', coordinatorId: '1', url: 'http://c' });
    return {
      registry,
      engine,
      coord,
      advanceTo: (ms) => {
        clock = start + ms;
      }
    };
  }

  it('keeps a coordinator whose pong arrives late but within the threshold', async () => {
    const { registry, engine, coord, advanceTo } = setup();

    advanceTo(PING_MS);
    await runLivenessTick(registry, engine, 'sentinel');
    advanceTo(2 * PING_MS);
    await runLivenessTick(registry, engine, 'sentinel');
    // The pong to the first ping lands 50s late, still inside the 90s threshold.
    advanceTo(80_000);
    registry.markAlive(coord.conn);
    advanceTo(3 * PING_MS);
    const result = await runLivenessTick(registry, engine, 'sentinel');

    expect(result.markedOffline).toBe(0);
    expect(coord.closed).toEqual([]);
    expect(registry.coordinators()).toHaveLength(1);
  });

  it('evicts only once the last heartbeat is older than the threshold', async () => {
    const { registry, engine, coord, advanceTo } = setup();

    for (const tick of [1, 2, 3]) {
      advanceTo(tick * PING_MS);
      const result = await runLivenessTick(registry, engine, 'sentinel');
      expect(result.markedOffline).toBe(0);
    }
    expect(registry.coordinators()).toHaveLength(1);

    advanceTo(4 * PING_MS);
    const result = await runLivenessTick(registry, engine, 'sentinel');
    expect(result.markedOffline).toBe(1);
    expect(coord.closed).toEqual([true]);
    expect(registry.coordinators()).toHaveLength(0);
  });
});
