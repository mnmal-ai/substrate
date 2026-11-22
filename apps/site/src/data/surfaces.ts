/**
 * Every way in to substrate. An `href` is a path in this repo (rendered as a GitHub link by
 * `repoLink`), an npm package page, or the cortext repo. surfaces.test.ts checks each exists.
 */
export const surfaces: { name: string; blurb: string; href: string }[] = [
  {
    name: 'HTTP',
    blurb:
      'Query, mutate and schema routes, plus one onboard route from which a fresh agent learns the whole grammar.',
    href: 'docs/surface-parity.md'
  },
  {
    name: 'MCP',
    blurb:
      'substrate mcp: a stdio server with query, mutate, schema, recall and run, plus ask and the propose tools when enabled. The lean preset carries act and whoami alone.',
    href: 'apps/substrate/README.md'
  },
  {
    name: 'act',
    blurb:
      'One line of intent in, one line of acknowledgement out. Declared actions carry the conventions, and a deterministic compiler resolves the rest.',
    href: 'docs/act.md'
  },
  {
    name: 'Frame streams',
    blurb: 'Subscribe for a snapshot then every change, as JSON or MessagePack frames.',
    href: 'docs/stream-contract.md'
  },
  {
    name: 'TypeScript client',
    blurb: 'SubstrateClient and watchRows, from the @mnmal-ai/substrate/client subpath.',
    href: 'https://www.npmjs.com/package/@mnmal-ai/substrate'
  },
  {
    name: 'substrate run',
    blurb:
      'One script, many reads and writes, one JSON report back. Signed, and read-only unless told otherwise.',
    href: 'apps/substrate/README.md'
  },
  {
    name: 'substrate-tui',
    blurb: 'A terminal UI: ask in plain English, browse the schema, watch the service.',
    href: 'https://www.npmjs.com/package/@mnmal-ai/substrate-tui'
  },
  {
    name: 'Docker Compose',
    blurb:
      'The server with every plugin in this repo, beside a pgvector Postgres, built from source.',
    href: 'docker-compose.yml'
  },
  {
    name: 'cortext',
    blurb:
      'Memory, agent mail and cold-start context for Claude Code and OpenCode, kept in substrate. It lives in synoptic.',
    href: 'https://github.com/mnmal-ai/synoptic'
  }
];

const REPO = 'https://github.com/mnmal-ai/substrate';

/** A repo path as a GitHub link (`tree` for a path ending in `/`); any other URL as it is. */
export const repoLink = (href: string): string =>
  /^[a-z]+:/.test(href) ? href : `${REPO}/${href.endsWith('/') ? 'tree' : 'blob'}/main/${href}`;
