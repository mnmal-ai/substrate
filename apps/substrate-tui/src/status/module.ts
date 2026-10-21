import { defineModule, type TuiModule } from '@mnmal-ai/surface-core';
import type { TuiDeps } from '../deps.js';
import { clean } from '../text.js';
import '../events.js';

export const HEALTH_INTERVAL_MS = 10_000;
export const HEALTH_TIMEOUT_MS = 5_000;

type Conn = 'connecting' | 'live' | 'reconnecting' | 'offline';

export function statusModule(deps: TuiDeps, opts: { intervalMs?: number } = {}): TuiModule {
  // View state lives in the factory: a presence view is a pure function of { theme }, so it can only
  // read state, and core re-renders it only when the App does (ctx.status always builds a new Map).
  let conn: Conn = 'connecting';
  let namespace = deps.namespace;
  let inFlight = 0;
  const presenceText = (): string => {
    const head =
      conn === 'live'
        ? '● live'
        : conn === 'offline'
          ? '○ offline'
          : conn === 'reconnecting'
            ? '◌ reconnecting'
            : '◌ …';
    const parts = [head, clean(namespace)];
    if (conn === 'live' && inFlight > 0) parts.push(`${inFlight} in flight`);
    return parts.join(' · ');
  };
  return defineModule('substrate.status', {
    presence: { name: 's u b s t r a t e', view: presenceText },
    init(ctx) {
      conn = 'connecting';
      namespace = deps.namespace;
      inFlight = 0;
      // Unchanged text still re-renders the App; null on a never-set id is a pure re-render poke.
      const repaint = () => ctx.status('presence-tick', null);
      let everLive = false;
      let stopped = false;
      let polling = false;
      let needWho = false;
      // Seed in display order so the row never depends on which request answers first.
      ctx.status('version', '…', 'dim');
      ctx.status('who', '…', 'dim');
      const fetchWho = () =>
        deps.getJson('/substrate/v1/whoami', ctx.signal).then(
          (w) => {
            if (stopped) return;
            const id = (w as { identity?: { id?: unknown } | null } | null)?.identity?.id;
            ctx.status('who', typeof id === 'string' ? clean(id) : 'anon', 'dim');
          },
          () => {
            if (!stopped) ctx.status('who', 'anon?', 'dim');
          }
        );
      let metricsPending = false;
      const fetchInFlight = async () => {
        if (metricsPending) return;
        metricsPending = true;
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), HEALTH_TIMEOUT_MS);
        try {
          const m = (await deps.getJson(
            '/substrate/v1/metrics',
            AbortSignal.any([ctx.signal, timeout.signal])
          )) as { process?: { inFlight?: unknown } } | null;
          const n = m?.process?.inFlight;
          if (!stopped && conn === 'live')
            inFlight = typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
        } catch {
          inFlight = 0;
        } finally {
          clearTimeout(timer);
          metricsPending = false;
          if (!stopped) repaint();
        }
      };
      const poll = async () => {
        if (polling) return;
        polling = true;
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), HEALTH_TIMEOUT_MS);
        try {
          const h = (await deps.getJson(
            '/health',
            AbortSignal.any([ctx.signal, timeout.signal])
          )) as { version?: unknown };
          if (stopped) return;
          everLive = true;
          conn = 'live';
          repaint();
          void fetchInFlight();
          if (typeof h.version === 'string') ctx.status('version', clean(`v${h.version}`), 'dim');
          if (needWho) {
            needWho = false;
            void fetchWho();
          }
        } catch {
          if (stopped) return;
          needWho = true;
          conn = everLive ? 'reconnecting' : 'offline';
          inFlight = 0;
          repaint();
          // A placeholder, not null: null removes the item and it would return at the end of the row.
          ctx.status('version', '…', 'dim');
        } finally {
          clearTimeout(timer);
          polling = false;
        }
      };
      void poll();
      void fetchWho();
      const off = ctx.on('substrate/ns', (e) => {
        namespace = e.namespace;
        repaint();
      });
      const timer = setInterval(() => void poll(), opts.intervalMs ?? HEALTH_INTERVAL_MS);
      return () => {
        stopped = true;
        clearInterval(timer);
        off();
      };
    }
  });
}
