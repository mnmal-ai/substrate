/**
 * The coined action words this engine knows, kept from the ActionProposal
 * records: each proposer's pending words, each type's promoted words, and the
 * names closed on their type (vetoed, retired or superseded by code). It also
 * counts each committed use of a pending word, promotes the word once the
 * uses are evidence enough, and applies each change a peer announces.
 */

import type {
  ActionDecl,
  ActionLayer,
  ActionSchema,
  ActorIdentity,
  Dataset,
  Id,
  PendingAction,
  Row,
  Schema
} from '@mnmal-ai/substrate-types';
import type { PubSub } from './config.js';
import { proposalLockKey, withProposalLock } from './proposal-lock.js';
import { lockedRow } from './row-lock.js';

/** Counted uses a pending word needs to be promoted. */
export const PROMOTE_USES = 5;
/** A use counts only this long after the previous counted use. */
export const USE_SPACING_MS = 3_600_000;
export const MAX_PUBLISHED_PER_TYPE = 10;
/** Live pending words per proposer per namespace. */
export const MAX_PENDING_PER_PROPOSER = 20;
/** A pending word unused this long lapses. */
export const LAPSE_MS = 30 * 86_400_000;

/** Where an instance tells its peers an ActionProposal record changed; the payload is its id. */
export const ACTIONS_CHANNEL = '_substrate_action_proposals';

export type NameState = 'free' | 'own' | 'taken' | 'closed';

interface Word {
  row: Row;
  decl: ActionDecl;
  /** `ns/Type` */
  qualified: string;
  name: string;
}

export interface ProposalActionLayerDeps {
  proposeKey: string;
  now: () => Date;
  invalidateSchemaCaches: (ns: string) => void;
  /** `ns`'s published schema version, coined words included. */
  schemaVersion: (ns: string) => string;
  /** The control-plane dataset the ActionProposal records live in. */
  dataset: Dataset;
  pubsub: PubSub;
  metric: (name: string, payload: Record<string, unknown>) => void;
  /** A record the layer cannot read; it is left out. */
  onSkip?: (row: Row, err: unknown) => void;
}

/** Who a use's write is stamped as. */
export const PLUGIN_ACTOR: ActorIdentity = { kind: 'system', id: 'substrate-proposals' };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const time = (v: unknown): number =>
  v === null || v === undefined ? 0 : new Date(v as string | Date).getTime();

/**
 * Whether a pending word has gone unused for {@link LAPSE_MS}, counted from
 * its last counted use or its latest (re)definition, whichever is later.
 */
export function isLapsed(row: Row, now: Date): boolean {
  return now.getTime() - Math.max(time(row.lastUseAt), time(row.proposedAt)) >= LAPSE_MS;
}

/**
 * Every action of `federated` declared in code or born with its type, keyed
 * `ns/Type.name`; coined words are left out.
 */
export function registryActions(federated: Record<string, Schema>): Map<string, ActionSchema> {
  const out = new Map<string, ActionSchema>();
  for (const [ns, schema] of Object.entries(federated)) {
    for (const [type, typeSchema] of Object.entries(schema.types)) {
      for (const [name, action] of Object.entries(typeSchema.actions ?? {})) {
        if (action.coined !== true) out.set(`${ns}/${type}.${name}`, action);
      }
    }
  }
  return out;
}

/** What a record whose name code now declares becomes. */
const SUPERSEDED = { status: 'superseded', supersededByCode: true, archived: true };

function mapOf<V>(maps: Map<string, Map<string, V>>, key: string): Map<string, V> {
  let map = maps.get(key);
  if (map === undefined) {
    map = new Map();
    maps.set(key, map);
  }
  return map;
}

export class ProposalActionLayer implements ActionLayer {
  readonly proposeKey: string;
  readonly #deps: ProposalActionLayerDeps;
  /** proposer → `ns/Type.name` → pending word */
  readonly #pending = new Map<string, Map<string, Word>>();
  /** `ns/Type` → name → promoted word */
  readonly #promoted = new Map<string, Map<string, Word>>();
  /** `ns/Type.name` of each closed name */
  readonly #closed = new Set<string>();
  /** Uses being recorded. */
  readonly #recording = new Set<Promise<void>>();

  constructor(deps: ProposalActionLayerDeps) {
    this.#deps = deps;
    this.proposeKey = deps.proposeKey;
  }

  /**
   * Applies every record. A live one whose name is in `declaredNames`
   * (`ns/Type.name`) is first marked superseded by code in the store, unless
   * it was archived since it was read.
   */
  async load(rows: Row[], declaredNames: ReadonlySet<string>): Promise<void> {
    for (const row of rows) {
      const live = row.archived !== true && (row.status === 'pending' || row.status === 'promoted');
      const key = `${String(row.targetNamespace)}/${String(row.targetType)}.${String(row.name)}`;
      if (!live || !declaredNames.has(key)) {
        this.apply(row);
        continue;
      }
      const { row: superseded } = await this.#deps.dataset.conditionalUpdate(
        'ActionProposal',
        row.id,
        { archived: false },
        SUPERSEDED,
        PLUGIN_ACTOR,
        this.#deps.now()
      );
      this.apply(superseded ?? { ...row, ...SUPERSEDED });
    }
  }

  /** Applies each record a peer says changed, as the store now holds it. */
  async listenToPeers(): Promise<void> {
    await this.#deps.pubsub.listen(ACTIONS_CHANNEL, async (id) => {
      // A throw here would end the listener.
      try {
        const row = (await this.#deps.dataset.read('ActionProposal', { id })).rows[0];
        if (row !== undefined) this.apply(row);
      } catch (err) {
        this.#report('_system_proposals.action_peer_failed', { id, error: message(err) });
      }
    });
  }

  /**
   * Upserts the word a record holds: a live pending one into its proposer's
   * map, a live promoted one into its type's map. Any other record closes its
   * name on its type. A word joining or leaving the published set drops its
   * namespace's cached schema.
   */
  apply(row: Row): void {
    const { targetNamespace: ns, targetType: type, name, proposedBy } = row;
    if (
      typeof ns !== 'string' ||
      typeof type !== 'string' ||
      typeof name !== 'string' ||
      typeof proposedBy !== 'string'
    ) {
      this.#deps.onSkip?.(row, new Error('names no target, action name or proposer'));
      return;
    }
    const qualified = `${ns}/${type}`;
    const key = `${qualified}.${name}`;
    for (const words of this.#pending.values()) words.delete(key);
    if (this.#promoted.get(qualified)?.delete(name) === true) this.#deps.invalidateSchemaCaches(ns);
    if (row.archived === true || (row.status !== 'pending' && row.status !== 'promoted')) {
      this.#closed.add(key);
      return;
    }
    let decl: ActionDecl;
    try {
      decl = JSON.parse(String(row.declJson)) as ActionDecl;
    } catch (err) {
      this.#deps.onSkip?.(row, err);
      return;
    }
    const word: Word = { row, decl, qualified, name };
    if (row.status === 'pending') {
      mapOf(this.#pending, proposedBy).set(key, word);
    } else {
      mapOf(this.#promoted, qualified).set(name, word);
      this.#deps.invalidateSchemaCaches(ns);
    }
  }

  published(ns: string): Record<string, Record<string, ActionDecl>> {
    // fromEntries, so no type or action name reaches a prototype.
    return Object.fromEntries(
      [...this.#promoted]
        .filter(([qualified, words]) => words.size > 0 && qualified.startsWith(`${ns}/`))
        .map(([qualified, words]) => [
          qualified.slice(ns.length + 1),
          Object.fromEntries([...words].map(([name, w]) => [name, w.decl]))
        ])
    );
  }

  pendingFor(identityId: string): Record<string, Record<string, PendingAction>> {
    const now = this.#deps.now();
    const out: Record<string, Record<string, PendingAction>> = {};
    for (const w of this.#pending.get(identityId)?.values() ?? []) {
      if (isLapsed(w.row, now)) continue;
      // A qualified type holds '/', and propose_action admits no `__proto__` name.
      const words = out[w.qualified] ?? {};
      words[w.name] = { decl: w.decl, uses: Number(w.row.uses ?? 0), needed: PROMOTE_USES };
      out[w.qualified] = words;
    }
    return out;
  }

  /** Records a use of each of the proposer's pending words in the background; never throws. */
  used(identityId: string, actions: ReadonlyArray<{ type: string; name: string }>, at: Date): void {
    const words = this.#pending.get(identityId);
    for (const { type, name } of actions) {
      const id = words?.get(`${type}.${name}`)?.row.id;
      if (id === undefined) continue;
      const work = this.#recordUse(id, at).catch((err: unknown) =>
        this.#report('_system_proposals.action_use_failed', { id, type, name, error: message(err) })
      );
      this.#recording.add(work);
      void work.finally(() => this.#recording.delete(work));
    }
  }

  /** Resolves once every use recorded so far has settled. */
  async settled(): Promise<void> {
    await Promise.all([...this.#recording]);
  }

  /**
   * Counts a use of the pending word `id` at `at` when it comes
   * {@link USE_SPACING_MS} after the last counted use, and promotes the word
   * once it has {@link PROMOTE_USES} and its type has fewer than
   * {@link MAX_PUBLISHED_PER_TYPE} published, spaced or not. The record stays
   * locked from its read to the commit. Once committed, the record joins this
   * layer and peers are told.
   */
  async #recordUse(id: Id, at: Date): Promise<void> {
    const written = await this.#deps.dataset.withTransaction(async (tx): Promise<Row | null> => {
      const row = await lockedRow('ActionProposal', id, tx);
      if (row === null || row.status !== 'pending' || row.archived === true) return null;
      const spaced = row.lastUseAt === null || at.getTime() - time(row.lastUseAt) >= USE_SPACING_MS;
      const uses = Number(row.uses ?? 0) + (spaced ? 1 : 0);
      const counted = spaced ? { uses, lastUseAt: at } : {};
      const store = async (patch: Record<string, unknown>): Promise<Row> => {
        await tx.write('ActionProposal', [{ id: row.id, ...patch }], {
          identity: PLUGIN_ACTOR,
          now: at
        });
        return { ...row, ...patch };
      };
      if (uses < PROMOTE_USES) return spaced ? store(counted) : null;
      const ns = String(row.targetNamespace);
      const type = String(row.targetType);
      // One promotion per type at a time, so two words cannot both take its last slot.
      return withProposalLock(tx, proposalLockKey('action', ns, type), async () => {
        const { rows: published } = await tx.read('ActionProposal', {
          where: {
            AND: [
              { targetNamespace: { eq: ns } },
              { targetType: { eq: type } },
              { status: { eq: 'promoted' } },
              { archived: { eq: false } }
            ]
          },
          limit: MAX_PUBLISHED_PER_TYPE
        });
        if (published.length >= MAX_PUBLISHED_PER_TYPE) return spaced ? store(counted) : null;
        const promotion = { ...counted, status: 'promoted', promotedAt: at };
        return store({
          ...promotion,
          resultingSchemaVersion: this.#versionWith({ ...row, ...promotion }, row)
        });
      });
    });
    if (written === null) return;
    this.apply(written);
    await this.#deps.pubsub.notify(ACTIONS_CHANNEL, String(written.id)).catch((err: unknown) =>
      this.#report('_system_proposals.action_notify_failed', {
        id: written.id,
        error: message(err)
      })
    );
  }

  /** A metric whose sink may throw: the throw is dropped, so a use never fails loudly. */
  #report(name: string, payload: Record<string, unknown>): void {
    try {
      this.#deps.metric(name, payload);
    } catch {
      // The sink's own failure has nowhere further to go.
    }
  }

  /**
   * The schema version `row`'s namespace has with `row` applied. The layer
   * holds `prior` afterwards, and nothing else runs in between.
   */
  #versionWith(row: Row, prior: Row): string {
    this.apply(row);
    try {
      return this.#deps.schemaVersion(String(row.targetNamespace));
    } finally {
      this.apply(prior);
    }
  }

  /**
   * Who holds `name` on `qualifiedType` at `now`: nobody, `proposer` (pending,
   * lapsed or not), someone else (pending and not lapsed, or promoted for
   * everyone), or nobody ever again. Another proposer's lapsed word holds
   * nothing: a define of its name takes its record over.
   */
  nameState(qualifiedType: string, name: string, proposer: string, now: Date): NameState {
    const key = `${qualifiedType}.${name}`;
    if (this.#closed.has(key)) return 'closed';
    if (this.#promoted.get(qualifiedType)?.has(name) === true) return 'taken';
    let own = false;
    for (const [who, words] of this.#pending) {
      const word = words.get(key);
      if (word === undefined) continue;
      if (who === proposer) own = true;
      else if (!isLapsed(word.row, now)) return 'taken';
    }
    return own ? 'own' : 'free';
  }

  /** `proposer`'s pending words in `ns` that have not lapsed by `now`. */
  pendingCount(proposer: string, ns: string, now: Date): number {
    let count = 0;
    for (const w of this.#pending.get(proposer)?.values() ?? []) {
      if (w.row.targetNamespace === ns && !isLapsed(w.row, now)) count++;
    }
    return count;
  }
}
