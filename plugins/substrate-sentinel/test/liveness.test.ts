import { describe, expect, it } from 'vitest';
import {
  type CoordinatorConnection,
  createLivenessRegistry,
  type PeerConnection,
  runLivenessTick
} from '../src/liveness.js';

function makeConn(overrides: Partial<PeerConnection> = {}): {
  conn: PeerConnection;
  sent: Array<string>;
  closed: Array<boolean>;
  beats: { n: number };
} {
  const sent: Array<string> = [];
  const closed: Array<boolean> = [];
  const beats = { n: 0 };
  const conn: PeerConnection = {
    send: (frame) => {
      sent.push(frame);
    },
    close: (code) => {
      closed.push(code !== undefined);
    },
    heartbeat: () => {
      beats.n++;
    },
    ...overrides
  };
  return { conn, sent, closed, beats };
}

describe('createLivenessRegistry', () => {
  it('round-trips addCoordinator / removeCoordinator metadata', () => {
    const registry = createLivenessRegistry();
    const { conn } = makeConn();
    const meta: CoordinatorConnection = { name: 'a', coordinatorId: '42', url: 'http://a' };
    registry.addCoordinator(conn, meta);
    expect(registry.coordinators().map((e) => e.meta)).toEqual([meta]);
    expect(registry.removeCoordinator(conn)).toEqual(meta);
    expect(registry.coordinators()).toHaveLength(0);
    expect(registry.removeCoordinator(conn)).toBeUndefined();
  });

  it('a re-registration supersedes the older stream for the same coordinator row', () => {
    const registry = createLivenessRegistry();
    const { conn: old, closed } = makeConn();
    const { conn: fresh } = makeConn();
    const meta: CoordinatorConnection = { name: 'a', coordinatorId: '42', url: 'http://a' };
    registry.addCoordinator(old, meta);
    registry.addCoordinator(fresh, meta);

    expect(closed).toHaveLength(1);
    // The old stream's close is now a no-op: nothing to mark offline.
    expect(registry.removeCoordinator(old)).toBeUndefined();
    expect(registry.coordinators().map((e) => e.conn)).toEqual([fresh]);
  });

  it('broadcastEvent reaches every watcher but not coordinators', () => {
    const registry = createLivenessRegistry();
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
    const registry = createLivenessRegistry();
    const watcher = makeConn();
    registry.addWatcher(watcher.conn);
    registry.addWatcher(watcher.conn);
    registry.broadcastEvent({ event: 'online' });
    expect(watcher.sent).toHaveLength(1);
  });
});

describe('runLivenessTick', () => {
  it('reports 0 heartbeats when nothing is open', () => {
    expect(runLivenessTick(createLivenessRegistry())).toEqual({ heartbeats: 0 });
  });

  it('sends every coordinator and watcher one heartbeat, and nothing else', () => {
    const registry = createLivenessRegistry();
    const coord = makeConn();
    const watcher = makeConn();
    registry.addCoordinator(coord.conn, { name: 'c', coordinatorId: '1', url: '' });
    registry.addWatcher(watcher.conn);

    expect(runLivenessTick(registry)).toEqual({ heartbeats: 2 });
    expect([coord.beats.n, watcher.beats.n]).toEqual([1, 1]);
    expect([...coord.sent, ...watcher.sent]).toEqual([]);
    expect([...coord.closed, ...watcher.closed]).toEqual([]);
  });

  it('a peer whose heartbeat throws does not stop the others', () => {
    const registry = createLivenessRegistry();
    const broken = makeConn({
      heartbeat: () => {
        throw new Error('gone');
      }
    });
    const ok = makeConn();
    registry.addWatcher(broken.conn);
    registry.addWatcher(ok.conn);

    expect(runLivenessTick(registry)).toEqual({ heartbeats: 1 });
    expect(ok.beats.n).toBe(1);
  });
});
