/**
 * The coined action words this engine knows, kept from the ActionProposal
 * records: each proposer's pending words, each type's promoted words, and the
 * names closed on their type (vetoed, retired or superseded by code).
 */

import type { ActionDecl, ActionLayer, PendingAction, Row } from '@mnmal-ai/substrate-types';

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
  /** A record the layer cannot read; it is left out. */
  onSkip?: (row: Row, err: unknown) => void;
}

const time = (v: unknown): number =>
  v === null || v === undefined ? 0 : new Date(v as string | Date).getTime();

/**
 * Whether a pending word has gone unused for {@link LAPSE_MS}, counted from
 * its last counted use or its latest (re)definition, whichever is later.
 */
export function isLapsed(row: Row, now: Date): boolean {
  return now.getTime() - Math.max(time(row.lastUseAt), time(row.proposedAt)) >= LAPSE_MS;
}

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

  constructor(deps: ProposalActionLayerDeps) {
    this.#deps = deps;
    this.proposeKey = deps.proposeKey;
  }

  /** Applies each record, then drops the cached schema of every namespace they target. */
  load(rows: Row[]): void {
    const namespaces = new Set<string>();
    for (const row of rows) {
      this.apply(row);
      if (typeof row.targetNamespace === 'string') namespaces.add(row.targetNamespace);
    }
    for (const ns of namespaces) this.#deps.invalidateSchemaCaches(ns);
  }

  /**
   * Upserts the word a record holds: a live pending one into its proposer's
   * map, a live promoted one into its type's map. Any other record closes its
   * name on its type.
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
    this.#promoted.get(qualified)?.delete(name);
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
    if (row.status === 'pending') mapOf(this.#pending, proposedBy).set(key, word);
    else mapOf(this.#promoted, qualified).set(name, word);
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

  // shortcut: uses are not counted yet, so no word earns promotion; evidence replaces this.
  used(_identityId: string, _actions: ReadonlyArray<{ type: string; name: string }>, _at: Date) {}

  /**
   * Who holds `name` on `qualifiedType`: nobody, `proposer` (pending, lapsed
   * or not), someone else (pending, or promoted for everyone), or nobody ever
   * again.
   */
  nameState(qualifiedType: string, name: string, proposer: string): NameState {
    const key = `${qualifiedType}.${name}`;
    if (this.#closed.has(key)) return 'closed';
    if (this.#promoted.get(qualifiedType)?.has(name) === true) return 'taken';
    for (const [who, words] of this.#pending) {
      if (words.has(key)) return who === proposer ? 'own' : 'taken';
    }
    return 'free';
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
