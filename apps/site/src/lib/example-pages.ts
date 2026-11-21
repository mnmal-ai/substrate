/** The worked examples in page order; each is `/examples/<slug>/`. */
export const EXAMPLE_SLUGS = [
  'onboard',
  'reshape',
  'ask',
  'coordinate',
  'warehouse',
  'recall',
  'self-tending'
] as const;

export type ExampleSlug = (typeof EXAMPLE_SLUGS)[number];

/** The `@lucasmarkes/hairline` exports the example pages draw. */
export type FigureName = 'settle' | 'rebuild' | 'query' | 'hub' | 'cabinet' | 'riffle' | 'slow';

/** Each example's Hairline figure, drawn in its page header and on its landing card. */
export const EXAMPLE_FIGURES: Readonly<Record<ExampleSlug, FigureName>> = {
  onboard: 'settle',
  reshape: 'rebuild',
  ask: 'query',
  coordinate: 'hub',
  warehouse: 'cabinet',
  recall: 'riffle',
  'self-tending': 'slow'
};

/** The three `##` sections every example's Markdown body carries, in order. */
export const SECTIONS = [
  { id: 'elsewhere', title: 'Elsewhere' },
  { id: 'on-substrate', title: 'On substrate' },
  { id: 'where-it-stops', title: 'Where it stops' }
] as const;

/**
 * Splits the HTML Astro renders from an example's Markdown at its `<h2>` headings and returns
 * each section without its heading. Throws, naming `file`, unless the headings are exactly
 * `SECTIONS` in order with nothing but whitespace before the first.
 */
export function splitSections(
  html: string,
  file: string
): { elsewhere: string; onSubstrate: string; stops: string } {
  const heads = [...html.matchAll(/<h2 id="([^"]*)"[^>]*>.*?<\/h2>/gs)];
  const found = heads.map((m) => m[1]);
  const first = heads[0];
  if (
    first === undefined ||
    html.slice(0, first.index).trim() !== '' ||
    found.join() !== SECTIONS.map((s) => s.id).join()
  ) {
    throw new Error(
      `${file}: expected sections ${SECTIONS.map((s) => s.title).join(', ')} in that order; found ${found.length ? found.join(', ') : 'none'}`
    );
  }
  const body = (i: number): string => {
    const m = heads[i];
    const next = heads[i + 1];
    return html.slice((m?.index ?? 0) + (m?.[0].length ?? 0), next?.index).trim();
  };
  return { elsewhere: body(0), onSubstrate: body(1), stops: body(2) };
}

/** Sorts entries by `data.order`, throwing unless the orders are exactly 1..n. */
export function byOrder<T extends { id: string; data: { order: number } }>(entries: T[]): T[] {
  const sorted = [...entries].sort((a, b) => a.data.order - b.data.order);
  sorted.forEach((e, i) => {
    if (e.data.order !== i + 1) {
      const prev = sorted[i - 1];
      throw new Error(
        `example order must run 1..${sorted.length}: "${e.id}" has ${e.data.order}${prev ? ` after "${prev.id}" (${prev.data.order})` : ''}`
      );
    }
  });
  return sorted;
}

/** The entries either side of `index`, or `undefined` at the ends; it does not wrap. */
export function neighbours<T>(
  ordered: readonly T[],
  index: number
): { prev: T | undefined; next: T | undefined } {
  return { prev: ordered[index - 1], next: ordered[index + 1] };
}

/** Products the Elsewhere copy may name; each must come with a link to its own docs. */
export const PRODUCTS: readonly string[] = [
  'PostgREST',
  'Hasura',
  'Supabase',
  'Mem0',
  'Zep',
  'Pinecone',
  'Weaviate',
  'Qdrant',
  'pgvector',
  'Kafka',
  'RabbitMQ',
  'Redis',
  'NATS',
  'Temporal',
  'ClickHouse',
  'Snowflake',
  'BigQuery',
  'DuckDB',
  'LangChain'
];

/**
 * Products named in `## Elsewhere` outside the text of an http(s) Markdown link, in first-seen
 * order. A plain mention passes when the text of an http(s) link in the same paragraph names the
 * product, as in `[Hasura](…) tracks tables. Hasura also…`; otherwise it is reported.
 */
export function unlinkedProducts(markdown: string): string[] {
  const section = /^## Elsewhere\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(markdown)?.[1] ?? '';
  const link = /\[([^\]]*)\]\(https?:[^)]*\)/g;
  const found = new Set<string>();
  for (const para of section.split(/\n\s*\n/)) {
    const linkText = [...para.matchAll(link)].map((m) => m[1]).join(' ');
    const plain = para.replace(link, ' ');
    const hits = PRODUCTS.flatMap((p) => {
      const name = new RegExp(`\\b${p}\\b`);
      const at = plain.search(name);
      return at < 0 || name.test(linkText) ? [] : [{ p, at }];
    });
    for (const { p } of hits.sort((a, b) => a.at - b.at)) found.add(p);
  }
  return [...found];
}

/** `<base>/examples/<slug>/` with exactly one slash at the join. */
export function pageHref(base: string, slug: string): string {
  return `${base.replace(/\/+$/, '')}/examples/${slug}/`;
}
