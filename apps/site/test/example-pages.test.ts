import { describe, expect, it } from 'vitest';
import {
  byOrder,
  neighbours,
  pageHref,
  splitSections,
  unlinkedProducts
} from '../src/lib/example-pages.ts';

const H = {
  e: '<h2 id="elsewhere">Elsewhere</h2>',
  s: '<h2 id="on-substrate">On substrate</h2>',
  w: '<h2 id="where-it-stops">Where it stops</h2>'
};

describe('splitSections', () => {
  it("returns each section's HTML without its heading", () => {
    expect(splitSections(`${H.e}<p>a</p>\n${H.s}\n<p>b</p>${H.w}<p>c</p>\n`, 'x.md')).toEqual({
      elsewhere: '<p>a</p>',
      onSubstrate: '<p>b</p>',
      stops: '<p>c</p>'
    });
  });

  it('names the file when a section is missing, misordered, extra, or preceded by prose', () => {
    const bad = [
      `${H.e}<p>a</p>${H.s}<p>b</p>`,
      `${H.s}<p>b</p>${H.e}<p>a</p>${H.w}<p>c</p>`,
      `${H.e}<p>a</p>${H.s}<p>b</p>${H.w}<p>c</p><h2 id="notes">Notes</h2><p>d</p>`,
      `<p>x</p>${H.e}<p>a</p>${H.s}<p>b</p>${H.w}<p>c</p>`
    ];
    for (const html of bad) expect(() => splitSections(html, 'reshape.md')).toThrow(/reshape\.md/);
  });
});

describe('byOrder', () => {
  it('sorts by order and refuses duplicates or gaps', () => {
    const e = (id: string, order: number) => ({ id, data: { order } });
    expect(byOrder([e('b', 2), e('a', 1)]).map((x) => x.id)).toEqual(['a', 'b']);
    expect(() => byOrder([e('p', 1), e('q', 1)])).toThrow(/p.*q/);
    expect(() => byOrder([e('p', 1), e('q', 3)])).toThrow(/p.*q/);
  });
});

describe('neighbours', () => {
  it('has no previous before the first and no next after the last', () => {
    const l = ['a', 'b', 'c'];
    expect(neighbours(l, 0)).toEqual({ prev: undefined, next: 'b' });
    expect(neighbours(l, 1)).toEqual({ prev: 'a', next: 'c' });
    expect(neighbours(l, 2)).toEqual({ prev: 'b', next: undefined });
  });
});

describe('unlinkedProducts', () => {
  const md = `## Elsewhere

[PostgREST](https://docs.postgrest.org/) serves a schema.

Hasura does too.

## On substrate

Pinecone here is outside Elsewhere.
`;

  it('reports a product named in a paragraph without a link', () => {
    expect(unlinkedProducts(md)).toEqual(['Hasura']);
  });

  it('counts a product named only as link text as linked', () => {
    expect(unlinkedProducts('## Elsewhere\n\n[Hasura](https://hasura.io/docs/) too.\n')).toEqual(
      []
    );
  });

  it('reports a product named in plain text beside another product link', () => {
    expect(
      unlinkedProducts(
        '## Elsewhere\n\n[PostgREST](https://docs.postgrest.org/) and Hasura both serve a schema.\n'
      )
    ).toEqual(['Hasura']);
  });

  it('counts a product named inside longer link text as linked', () => {
    expect(
      unlinkedProducts('## Elsewhere\n\n[the Hasura docs](https://hasura.io/docs/) say so.\n')
    ).toEqual([]);
  });

  it('never reports Postgres or PostgreSQL', () => {
    expect(unlinkedProducts('## Elsewhere\n\nPostgres and PostgreSQL.\n')).toEqual([]);
  });
});

describe('pageHref', () => {
  it('joins base and slug with one slash', () => {
    expect(pageHref('/substrate', 'ask')).toBe('/substrate/examples/ask/');
    expect(pageHref('/substrate/', 'ask')).toBe('/substrate/examples/ask/');
  });
});
