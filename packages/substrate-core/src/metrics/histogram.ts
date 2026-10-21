/** Upper bounds in ms: powers of √2 from 0.1 ms; the last bucket catches everything larger. */
const BOUNDS: number[] = [];
for (let b = 0.1; b < 60_000; b *= Math.SQRT2) BOUNDS.push(b);
BOUNDS.push(Number.POSITIVE_INFINITY);

/** O(1) observe; percentiles read off bucket upper bounds (clamped to the observed max). */
export class LogHistogram {
  readonly #counts = new Array<number>(BOUNDS.length).fill(0);
  count = 0;
  max = 0;

  observe(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let i = 0;
    while (ms > (BOUNDS[i] as number)) i++;
    this.#counts[i] = (this.#counts[i] as number) + 1;
    this.count++;
    if (ms > this.max) this.max = ms;
  }

  /** Lower bound of the bucket holding the p-th percentile; 0 when empty. */
  percentileLowerBound(p: number): number {
    if (this.count === 0) return 0;
    const rank = Math.ceil(Math.min(1, Math.max(0, p)) * this.count);
    let seen = 0;
    for (let i = 0; i < BOUNDS.length; i++) {
      seen += this.#counts[i] as number;
      if (seen >= rank) return i === 0 ? 0 : (BOUNDS[i - 1] as number);
    }
    return this.max;
  }

  percentile(p: number): number {
    if (this.count === 0) return 0;
    const rank = Math.ceil(Math.min(1, Math.max(0, p)) * this.count);
    let seen = 0;
    for (let i = 0; i < BOUNDS.length; i++) {
      seen += this.#counts[i] as number;
      if (seen >= rank) return Math.min(BOUNDS[i] as number, this.max);
    }
    return this.max;
  }
}
