/**
 * Reciprocal Rank Fusion over an arbitrary number of retrieval arms.
 *
 * Ranks, not scores: the arms' scores are on incomparable scales (cosine,
 * `ts_rank`, term counts), and a rank is the one thing every arm agrees on.
 *
 * Union, not intersection: a row only one arm found still enters the pool,
 * so the lexical arm can surface rows the dense arm missed.
 *
 * A missing arm contributes no term, not a penalty term, so enabling an arm
 * cannot demote rows it says nothing about.
 */

/**
 * The RRF constant from Cormack et al. It damps the
 * difference between adjacent top ranks, so a row needs agreement across arms
 * rather than a narrow win within one to move.
 */
export const RRF_K = 60;

/**
 * Fuse ordered arms into a score per id.
 *
 * Each arm is an ordered list of row ids, best first. Ranks are 1-based and
 * counted PER ARM — a row leading the second arm scores as a leader, not as
 * though it were buried behind the first arm's length.
 *
 * Duplicates within one arm are ignored rather than summed: a store returning
 * the same row twice is reporting one hit, and double-counting would let a
 * buggy arm outvote a correct one.
 */
export function fuseByRank(
  arms: ReadonlyArray<ReadonlyArray<string>>,
  k: number = RRF_K
): Map<string, number> {
  const out = new Map<string, number>();
  for (const arm of arms) {
    for (const [id, rank] of rankArm(arm)) {
      out.set(id, (out.get(id) ?? 0) + 1 / (k + rank));
    }
  }
  return out;
}

/**
 * Map each id in one arm to its 1-based rank, skipping repeats of an id
 * already seen. Shared by fusion and the diagnostics so both report the rank
 * that was actually scored.
 */
function rankArm(arm: ReadonlyArray<string>): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const id of arm) {
    if (!ranks.has(id)) ranks.set(id, ranks.size + 1);
  }
  return ranks;
}

/** One arm's contribution to a fused row, for diagnostics. */
export interface ArmRank {
  /** 1-based rank within that arm, or null when the arm did not return it. */
  dense: number | null;
  lexical: number | null;
}

/**
 * Per-arm ranks for one id, for the opt-in diagnostic envelope.
 *
 * `null` means the arm did not return the row; ranks are 1-based and count
 * each id once, matching the rank `fuseByRank` scored.
 */
export function armRanks(
  id: string,
  dense: ReadonlyArray<string>,
  lexical: ReadonlyArray<string>
): ArmRank {
  return {
    dense: rankArm(dense).get(id) ?? null,
    lexical: rankArm(lexical).get(id) ?? null
  };
}
