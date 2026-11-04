/**
 * The promotion sweep's server side: a field held in jsonb (`pending`) gets
 * its column from `Dataset.promotePendingFields`, run every
 * `intervalMs` (`SUBSTRATE_PROMOTE_INTERVAL_MS`) and on demand through the
 * admin-gated `POST /substrate/v1/_system/promote-fields`.
 *
 * Each field event is written as an `_system/AuditEvent` (actorKid `'system'`)
 * and then announced, so a subscriber to `_system/AuditEvent` and every
 * coordinator's `onCommittedWrites` see it as they would a mutate's commit.
 * A `busy` field (its table's lock stayed held) is retried by the next sweep
 * and has no event of its own; its third busy sweep in a row is `failed`.
 * The route's sweep also retries fields a unique conflict holds back
 * (`retryConflicts`): an operator runs it after fixing the data; the timer's
 * waits for their type's catalog to change.
 */

import type {
  ActorIdentity,
  Dataset,
  EngineHandle,
  HttpHandler,
  PromotionEvent,
  Row
} from '@mnmal-ai/substrate-types';
import { jsonResponse } from '../routes/helpers.js';
import { buildAuditRow } from './install.js';
import { AUDIT_EVENT_TYPE, SYSTEM_NAMESPACE } from './types.js';

/** The longest a sweep's ADD COLUMN queues writers behind its table lock. */
export const PROMOTE_LOCK_TIMEOUT_MS = 2000;
/** Rows a backfill statement moves at once. */
export const PROMOTE_BATCH_ROWS = 1000;

export interface FieldEvent {
  kind: 'field_pending' | 'field_promoted' | 'field_promotion_failed';
  namespace: string;
  type: string;
  field: string;
  attempts: number;
  error?: string;
}

const SYSTEM_ACTOR: ActorIdentity = { kind: 'system', id: 'system' };

/**
 * Writes each event as an `_system/AuditEvent`, then announces the rows.
 * Nothing when there are none, or when the engine has no `_system` dataset.
 */
export async function emitFieldEvents(
  engine: Pick<EngineHandle, 'announceWrites' | 'datasetFor'>,
  events: readonly FieldEvent[],
  now: Date = new Date()
): Promise<void> {
  const system = events.length === 0 ? undefined : engine.datasetFor(SYSTEM_NAMESPACE);
  if (system === undefined) return;
  const rows = events.map(({ kind, ...details }) =>
    buildAuditRow({ actorKid: 'system', kind, details, now })
  );
  const written = await system.write(AUDIT_EVENT_TYPE, rows, { identity: SYSTEM_ACTOR, now });
  await engine.announceWrites(
    written.ids.map((id, i) => ({
      ns: SYSTEM_NAMESPACE,
      type: AUDIT_EVENT_TYPE,
      id,
      operation: 'create' as const,
      row: written.rows?.[i] ?? ({ ...rows[i], id } as Row)
    })),
    SYSTEM_ACTOR
  );
}

/** The audit event for a sweep's event; none for `busy`. */
function auditOf(e: PromotionEvent): FieldEvent[] {
  if (e.kind === 'busy') return [];
  const { kind, ...rest } = e;
  return [{ kind: kind === 'promoted' ? 'field_promoted' : 'field_promotion_failed', ...rest }];
}

export interface PromoteFieldsRunner {
  /** One sweep, after any already running; its events, each also audited. */
  run(opts?: { retryConflicts?: boolean }): Promise<PromotionEvent[]>;
  /** Stops the timer, aborts the running sweep and waits for it; later runs do nothing. */
  stop(): Promise<void>;
}

/**
 * The sweep, one at a time, with a timer every `intervalMs` (0: none; the
 * route still runs it). A dataset without `promotePendingFields` sweeps nothing.
 */
export function createPromoteFieldsRunner(deps: {
  dataset: Dataset;
  engine: Pick<EngineHandle, 'announceWrites' | 'datasetFor'>;
  intervalMs: number;
}): PromoteFieldsRunner {
  const abort = new AbortController();
  const pass = async (retryConflicts: boolean): Promise<PromotionEvent[]> => {
    if (deps.dataset.promotePendingFields === undefined || abort.signal.aborted) return [];
    const events = await deps.dataset.promotePendingFields({
      lockTimeoutMs: PROMOTE_LOCK_TIMEOUT_MS,
      batchRows: PROMOTE_BATCH_ROWS,
      signal: abort.signal,
      ...(retryConflicts ? { retryConflicts } : {})
    });
    for (const e of events) {
      // A busy event's error says why it was skipped (another process holds it), not an attempt.
      const outcome =
        e.kind === 'busy' && e.error !== undefined
          ? `busy (${e.error})`
          : `${e.kind} (attempt ${e.attempts})${e.error !== undefined ? `: ${e.error}` : ''}`;
      process.stdout.write(`[substrate] field ${e.namespace}/${e.type}.${e.field}: ${outcome}\n`);
    }
    await emitFieldEvents(deps.engine, events.flatMap(auditOf));
    return events;
  };
  let tail: Promise<unknown> = Promise.resolve();
  const run = (opts: { retryConflicts?: boolean } = {}): Promise<PromotionEvent[]> => {
    const next = tail.then(() => pass(opts.retryConflicts === true));
    tail = next.catch(() => undefined);
    return next;
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  if (deps.intervalMs > 0 && deps.dataset.promotePendingFields !== undefined) {
    let running = false;
    timer = setInterval(() => {
      if (running) return;
      running = true;
      run()
        .catch((err: unknown) => {
          process.stderr.write(
            `[substrate] promotion sweep failed and will run again: ${err instanceof Error ? err.message : String(err)}\n`
          );
        })
        .finally(() => {
          running = false;
        });
    }, deps.intervalMs);
    timer.unref?.();
  }
  return {
    run,
    stop: async () => {
      clearInterval(timer);
      abort.abort();
      await tail;
    }
  };
}

/** `POST /substrate/v1/_system/promote-fields`: runs one sweep and answers its events. Admin-gated by the caller. */
export function promoteFieldsRoute(
  run: (opts: { retryConflicts: boolean }) => Promise<PromotionEvent[]>
): HttpHandler {
  return async () => {
    try {
      return jsonResponse(200, { events: await run({ retryConflicts: true }) });
    } catch (err) {
      return jsonResponse(500, {
        code: 'promotion_failed',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  };
}
