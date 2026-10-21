/**
 * Deterministic provisional labelling for a formed cluster.
 *
 * No model, no network, fully reproducible — `labelledBy: 'medoid'`. The
 * substrate keeps LLMs opt-in, so judgment enters from the calling agent
 * instead, via `recall/labelCluster`.
 *
 * Two ingredients:
 *   - the MEDOID — the member nearest the centroid. An exemplar, not a
 *     summary: a real row a reader can go and look at.
 *   - DISTINGUISHING TERMS — terms frequent inside the cluster and rare
 *     across the corpus. Document frequency, not raw counts, so one verbose
 *     row cannot dominate.
 *
 * Every tie breaks on a stable key (term ascending, id ascending) so identical
 * runs produce identical labels.
 */

import type { Candidate } from './candidate-selection.js';
import { cosineSimilarity } from './cosine.js';

export type LabelInput = Pick<Candidate, 'namespace' | 'type' | 'id' | 'vector' | 'row'>;

/**
 * The indexed, retrieval-tuned handle fields. Long-form fields (`body`,
 * `summary`, `notes`, `rationale`) are deliberately excluded — they are
 * unindexed by convention, and their length would swamp document frequency.
 */
export const HANDLE_FIELDS: readonly string[] = [
  'name',
  'title',
  'topic',
  'synopsis',
  'description'
];

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'not',
  'but',
  'are',
  'was',
  'were',
  'has',
  'have',
  'had',
  'its',
  'their',
  'our',
  'you',
  'your',
  'they',
  'them',
  'all',
  'any',
  'can',
  'will',
  'would',
  'should',
  'when',
  'what',
  'which',
  'who',
  'why',
  'how',
  'via',
  'per',
  'off',
  'out',
  'over',
  'under',
  'than',
  'then',
  'now',
  'one',
  'two',
  'get',
  'set',
  'use',
  'used',
  'using',
  'add',
  'added',
  'new',
  'old'
]);

const MIN_TERM_LENGTH = 3;
const MAX_LABEL_LENGTH = 120;
const MAX_EXEMPLAR_LENGTH = 60;
const DEFAULT_TERM_COUNT = 3;

/** Concatenated handle text for one row; empty string when it has none. */
function handleText(row: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const field of HANDLE_FIELDS) {
    const value = row[field];
    if (typeof value === 'string' && value.length > 0) parts.push(value);
  }
  return parts.join(' ');
}

/** The single best exemplar string for a row — first non-empty handle field. */
function exemplarText(input: LabelInput): string | null {
  for (const field of HANDLE_FIELDS) {
    const value = input.row[field];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function tokenise(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length < MIN_TERM_LENGTH) continue;
    if (STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

export function medoidOf(
  members: readonly LabelInput[],
  centroid: Float32Array
): LabelInput | null {
  let best: LabelInput | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const member of members) {
    const score = cosineSimilarity(member.vector, centroid);
    if (score > bestScore || (score === bestScore && best !== null && member.id < best.id)) {
      best = member;
      bestScore = score;
    }
  }
  return best;
}

export function distinguishingTerms(
  members: readonly LabelInput[],
  corpus: readonly LabelInput[],
  count: number = DEFAULT_TERM_COUNT
): string[] {
  if (members.length === 0) return [];

  const memberTokens = members.map((m) => tokenise(handleText(m.row)));
  const corpusTokens = corpus.map((c) => tokenise(handleText(c.row)));

  const inDf = new Map<string, number>();
  for (const tokens of memberTokens) {
    for (const t of tokens) inDf.set(t, (inDf.get(t) ?? 0) + 1);
  }
  const corpusDf = new Map<string, number>();
  for (const tokens of corpusTokens) {
    for (const t of tokens) corpusDf.set(t, (corpusDf.get(t) ?? 0) + 1);
  }

  const scored: Array<{ term: string; score: number }> = [];
  for (const [term, df] of inDf) {
    const inRate = df / members.length;
    const corpusRate = corpus.length === 0 ? 0 : (corpusDf.get(term) ?? 0) / corpus.length;
    const score = inRate - corpusRate;
    // A term no more common inside than outside distinguishes nothing.
    if (score <= 0) continue;
    scored.push({ term, score });
  }

  scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  return scored.slice(0, count).map((s) => s.term);
}

export function buildLabel(
  members: readonly LabelInput[],
  corpus: readonly LabelInput[],
  centroid: Float32Array
): string {
  const medoid = medoidOf(members, centroid);
  const terms = distinguishingTerms(members, corpus);

  // Last-resort identity: a cluster whose members carry no handle text at all
  // still gets something a reader can look up, rather than an empty string.
  const exemplar =
    medoid === null
      ? null
      : (exemplarText(medoid) ?? `${medoid.namespace}/${medoid.type}/${medoid.id}`);

  const label =
    terms.length === 0
      ? (exemplar ?? 'unlabelled')
      : exemplar === null
        ? terms.join(' / ')
        : `${terms.join(' / ')} — ${exemplar.slice(0, MAX_EXEMPLAR_LENGTH)}`;

  return label.slice(0, MAX_LABEL_LENGTH);
}
