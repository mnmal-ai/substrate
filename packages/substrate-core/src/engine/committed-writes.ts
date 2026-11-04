/**
 * Coordinator `onCommittedWrites` delivery. Each plugin has its own promise
 * chain, so its calls run in commit order, nothing on the mutate path awaits
 * them, and a hung hook stalls only that plugin's later calls.
 */

import type {
  ActorIdentity,
  CommittedWriteBatch,
  CommittedWritesHook,
  Id,
  Identity,
  WriteEvent
} from '@mnmal-ai/substrate-types';

type Metric = (name: string, payload?: unknown) => void;

/**
 * The row-attribution actor of a request identity, or null when it names none.
 * Mirrors the sdk's `resolveIdentity` (core cannot import the sdk) but returns
 * null instead of throwing: a hook is told who wrote, it does not gate the write.
 */
export function actorOf(identity: Identity | null): ActorIdentity | null {
  if (identity === null) return null;
  const { agentKeyId, tokenId } = identity;
  if (typeof agentKeyId === 'string' && agentKeyId.length > 0) {
    return { kind: 'agent', id: agentKeyId };
  }
  if (typeof tokenId === 'string' && tokenId.length > 0) return { kind: 'user', id: tokenId };
  if (identity.kind === 'system' && identity.id.length > 0) {
    return { kind: 'system', id: identity.id };
  }
  return null;
}

export class CommittedWritesQueue {
  readonly #hooks: ReadonlyArray<{ plugin: string; hook: CommittedWritesHook }>;
  readonly #metric: Metric;
  readonly #chains = new Map<string, Promise<void>>();
  readonly #warnings = new Map<string, string>();

  constructor(hooks: ReadonlyArray<{ plugin: string; hook: CommittedWritesHook }>, metric: Metric) {
    this.#hooks = hooks;
    this.#metric = metric;
  }

  /** Callers check this first, so a deployment with no hooks does no grouping at all. */
  get active(): boolean {
    return this.#hooks.length > 0;
  }

  /** Queue one committed transaction's events (or an announced set): one call per group per hook. */
  queue(events: readonly WriteEvent[], actor: ActorIdentity | null): void {
    if (this.#hooks.length === 0 || events.length === 0) return;
    // Groups in first-appearance order; ids keep emit order.
    const groups = new Map<string, CommittedWriteBatch & { ids: Id[] }>();
    for (const e of events) {
      const key = JSON.stringify([e.ns, e.type, e.operation]);
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, {
          namespace: e.ns,
          type: e.type,
          operation: e.operation,
          actor,
          ids: [e.id]
        });
      } else {
        group.ids.push(e.id);
      }
    }
    // Frozen once: every plugin sees the same array, and none can change it for the next.
    for (const group of groups.values()) Object.freeze(group.ids);
    for (const { plugin, hook } of this.#hooks) {
      for (const batch of groups.values()) this.#enqueue(plugin, hook, batch);
    }
  }

  /**
   * Resolves once every call queued so far has finished. A hook that itself
   * mutates queues calls this does not wait for.
   */
  async settled(): Promise<void> {
    await Promise.all(this.#chains.values());
  }

  warnings(): string[] {
    return [...this.#warnings.values()];
  }

  #enqueue(plugin: string, hook: CommittedWritesHook, batch: CommittedWriteBatch): void {
    const prev = this.#chains.get(plugin) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        await hook(batch);
        this.#warnings.delete(plugin);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // /health is unauthenticated: the warning names the plugin, never the message.
        // The message goes to the operator through the metric sink's payload,
        // as the engine does for its other swallowed errors.
        this.#warnings.set(
          plugin,
          `post-write hook ${plugin} failed at ${new Date().toISOString()}`
        );
        // A throwing metric sink must not break the chain.
        try {
          this.#metric('engine_post_write_hook_error', { plugin, error: message });
        } catch {}
      });
    this.#chains.set(plugin, next);
  }
}
