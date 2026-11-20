export interface ClickBenchQuery {
  q: number;
  expressible: boolean;
  compared: boolean;
  answersMatch: boolean;
  p50Ms: number;
  baselineP50Ms: number;
}
export interface ClickBenchPass {
  sumRatio: number;
  worstRatio: number;
  worstQ: number;
}
export interface ClickBench {
  sha: string;
  version: string;
  date: string;
  machine: string;
  runs: number;
  passes?: ClickBenchPass[];
  queries: ClickBenchQuery[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Ratios are over compared queries only: a vacuous query proves nothing about time. */
export function summarise(d: Pick<ClickBench, 'queries'>): {
  expressible: number;
  compared: number;
  matched: number;
  sumRatio: number;
  worstRatio: number;
  worstQ: number;
} {
  const compared = d.queries.filter((x) => x.compared);
  let worstRatio = 0;
  let worstQ = 0;
  for (const x of compared) {
    const r = x.p50Ms / x.baselineP50Ms;
    if (r > worstRatio) {
      worstRatio = r;
      worstQ = x.q;
    }
  }
  const sum = (f: (x: ClickBenchQuery) => number) => compared.reduce((a, x) => a + f(x), 0);
  return {
    expressible: d.queries.filter((x) => x.expressible).length,
    compared: compared.length,
    matched: compared.filter((x) => x.answersMatch).length,
    sumRatio: round2(sum((x) => x.p50Ms) / sum((x) => x.baselineP50Ms)),
    worstRatio: round2(worstRatio),
    worstQ
  };
}
