// Substrate adapter. Memories live in the `lumen` namespace of a local Substrate
// (scripts/substrate-up.sh starts it), declared by adapters/substrate-plugin.
//
// Writes go through Substrate's normal write path: autoCRUD mutations on
// POST /substrate/v1/mutate, batched (an array under one op-key is one
// transaction). Search is Substrate's recall (pgvector + keyword, fused) on
// POST /substrate/v1/recall, the same operation the agent reaches as the
// `recall` MCP tool.
//
// Mapping from a Memory:
//   - kind            -> type (person -> lumen/Person, ...)
//   - id              -> `key` (Substrate allocates its own row ids)
//   - title/body/date -> fields of the same name
//   - links           -> `links`, a list of keys (mixed target types; see the plugin)
//   - fields          -> fields of the same name, values unchanged. When the
//                        type declares a `<field>Ref` crossRef (ownerRef,
//                        projectRef, supersedesRef, supersededByRef), it is set to
//                        the referenced memory's row id: a first-class edge.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSetup, IngestReport, Memory, MemoryAdapter, MemoryKind } from '../src/types.ts';

const DEMO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUN = join(DEMO, 'run', 'substrate');
const NS = 'lumen';

const TYPE_OF: Record<MemoryKind, string> = {
  person: 'Person',
  project: 'Project',
  decision: 'Decision',
  task: 'Task',
  incident: 'Incident'
};
// Create order: a row's crossRef targets should exist before it is written, so
// its first embedding already names them. Same-type refs (a decision that
// supersedes another) are filled in by a second, update pass.
const CREATE_ORDER = ['Person', 'Project', 'Decision', 'Task', 'Incident'];

// The MCP tools the agent gets: the ones that read. Substrate's MCP server also
// registers write and admin tools; an agent that only answers questions carries
// only these.
const MCP_TOOLS = ['schema', 'query', 'recall'];

// Writes go out as batched mutate requests of up to BATCH rows, at most
// WRITE_CONCURRENCY in flight. Every write embeds its row with Ollama inside the
// request, one row at a time, so parallel requests are what keep the embedder
// busy. 4 is the tested setting: an earlier release exhausted its Postgres pool
// at 8 parallel batches, with every connection idle in transaction.
const BATCH = 50;
const WRITE_CONCURRENCY = Number(process.env.SUBSTRATE_DEMO_WRITE_CONCURRENCY ?? 4);

interface Runtime {
  substrateUrl: string;
  src: string;
  embedModel: string;
  node: string;
  substrateBin: string;
}

interface FieldDef {
  kind: string;
  type?: string;
  ns?: string;
}

interface Envelope {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; code?: string; path?: unknown }>;
}

function runtime(): Runtime {
  try {
    return JSON.parse(readFileSync(join(RUN, 'runtime.json'), 'utf8')) as Runtime;
  } catch {
    throw new Error(
      'substrate adapter: run/substrate/runtime.json is missing; start Substrate with scripts/substrate-up.sh'
    );
  }
}

async function http<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const { substrateUrl } = runtime();
  const res = await fetch(substrateUrl + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000)
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`substrate ${method} ${path}: HTTP ${res.status} ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

/** POST a frame and fail on any rejected op-key (Substrate answers 200 with `errors`). */
export async function frame(
  path: '/substrate/v1/query' | '/substrate/v1/mutate',
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const env = await http<Envelope>('POST', path, body);
  if (env.errors && env.errors.length > 0) {
    const first = env.errors
      .slice(0, 3)
      .map((e) => `${e.code ?? 'error'}: ${e.message}`)
      .join('; ');
    throw new Error(`substrate ${path}: ${env.errors.length} error(s): ${first}`);
  }
  const data = env.data ?? {};
  for (const key of Object.keys(body)) {
    if (!(key in data))
      throw new Error(`substrate ${path}: op-key ${key} missing from the response`);
  }
  return data;
}

async function schemaFields(type: string): Promise<Record<string, FieldDef>> {
  const s = await http<{ fields: Record<string, FieldDef> }>(
    'GET',
    `/substrate/v1/schema/${NS}/${type}?shape=fields`
  );
  return s.fields;
}

/** Every live row id of one type. */
async function rowIds(type: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const params: Record<string, unknown> = { limit: 500 };
    if (cursor) params.cursor = cursor;
    const env = await http<
      Envelope & { _pagination?: Record<string, { hasMore: boolean; nextCursor?: string }> }
    >('POST', '/substrate/v1/query', { [`${NS}/${type}`]: { params, fields: { id: true } } });
    if (env.errors?.length) throw new Error(`substrate query ${type}: ${env.errors[0].message}`);
    const rows = (env.data?.[`${NS}/${type}`] ?? []) as Array<{ id: string }>;
    ids.push(...rows.map((r) => r.id));
    const page = env._pagination?.[`${NS}/${type}`];
    if (!page?.hasMore || !page.nextCursor || rows.length === 0) return ids;
    cursor = page.nextCursor;
  }
}

async function recallFinds(m: Memory): Promise<boolean> {
  const res = await http<{ rows: Array<{ row: { key?: string } }> }>(
    'POST',
    '/substrate/v1/recall',
    {
      query: m.title,
      namespace: NS,
      type: TYPE_OF[m.kind],
      k: 5,
      boost: false,
      // Hits carry only handle fields by default (Substrate >= 1.0.0-alpha.4); the
      // check needs the key.
      rowFields: { key: true }
    }
  );
  return res.rows.some((r) => r.row.key === m.id);
}

/** Run tasks with at most WRITE_CONCURRENCY in flight; results in task order. */
async function inParallel<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(WRITE_CONCURRENCY, tasks.length)) }, worker)
  );
  return out;
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const adapter: MemoryAdapter = {
  name: 'substrate',

  async reset() {
    // Soft-delete every row through the autoCRUD delete mutation. Deleted rows
    // drop out of queries and recall at once (hard purge needs an admin
    // identity, which a server without auth does not have).
    for (const type of CREATE_ORDER) {
      for (;;) {
        const ids = await rowIds(type);
        if (ids.length === 0) break;
        for (const batch of chunks(ids, 200)) {
          await frame('/substrate/v1/mutate', {
            [`${NS}/delete${type}`]: batch.map((id) => ({ params: { id }, fields: { id: true } }))
          });
        }
      }
    }
  },

  async ingest(memories) {
    // The schema a client writes against. Fetched before the clock starts: an
    // application knows its own schema.
    const schema: Record<string, Record<string, FieldDef>> = {};
    for (const type of CREATE_ORDER) schema[type] = await schemaFields(type);

    const undeclared = new Set<string>();
    for (const m of memories) {
      for (const k of Object.keys(m.fields)) {
        if (!(k in schema[TYPE_OF[m.kind]])) undeclared.add(`${TYPE_OF[m.kind]}.${k}`);
      }
    }
    if (undeclared.size > 0) {
      throw new Error(
        `substrate adapter: fields not declared in the lumen namespace: ${[...undeclared].join(', ')}. ` +
          'Add them to adapters/substrate-plugin/bootstrap.js and restart (scripts/substrate-down.sh && scripts/substrate-up.sh).'
      );
    }

    const kindOfKey = new Map(memories.map((m) => [m.id, TYPE_OF[m.kind]]));
    const rowId = new Map<string, string>(); // memory key -> Substrate row id
    const deferred: Memory[] = [];
    let dangling = 0;
    let requests = 0;

    const t0 = performance.now();
    for (const type of CREATE_ORDER) {
      const batch = memories.filter((m) => TYPE_OF[m.kind] === type);
      if (batch.length === 0) continue;
      const frames = batch.map((m) => {
        const params: Record<string, unknown> = {
          key: m.id,
          title: m.title,
          body: m.body,
          date: m.date,
          links: m.links
        };
        let needsSecondPass = false;
        for (const [k, v] of Object.entries(m.fields)) {
          params[k] = v;
          const edge = schema[type][`${k}Ref`];
          if (edge?.kind !== 'crossRef' || v === null) continue;
          const target = rowId.get(String(v));
          if (target) params[`${k}Ref`] = target;
          else if (kindOfKey.get(String(v)) === edge.type) needsSecondPass = true;
          else dangling++;
        }
        if (needsSecondPass) deferred.push(m);
        return { params, fields: { id: true, key: true } };
      });
      const results = await inParallel(
        chunks(frames, BATCH).map(
          (part) => () => frame('/substrate/v1/mutate', { [`${NS}/create${type}`]: part })
        )
      );
      requests += results.length;
      for (const data of results) {
        for (const row of data[`${NS}/create${type}`] as Array<{ id: string; key: string }>)
          rowId.set(row.key, row.id);
      }
    }

    const tCreated = performance.now();

    // Second pass: edges whose target was written after the row itself.
    const updates = new Map<
      string,
      Array<{ params: Record<string, unknown>; fields: { id: true } }>
    >();
    for (const m of deferred) {
      const type = TYPE_OF[m.kind];
      const params: Record<string, unknown> = { id: rowId.get(m.id) };
      for (const [k, v] of Object.entries(m.fields)) {
        if (schema[type][`${k}Ref`]?.kind === 'crossRef' && v !== null && rowId.has(String(v))) {
          params[`${k}Ref`] = rowId.get(String(v));
        }
      }
      const list = updates.get(type) ?? [];
      list.push({ params, fields: { id: true } });
      updates.set(type, list);
    }
    for (const [type, list] of updates) {
      const parts = chunks(list, BATCH);
      await inParallel(
        parts.map((part) => () => frame('/substrate/v1/mutate', { [`${NS}/update${type}`]: part }))
      );
      requests += parts.length;
    }
    const t1 = performance.now();

    // Searchable: how long after the last write until recall returns the last memory.
    const last = memories[memories.length - 1];
    let polls = 0;
    let found = false;
    while (performance.now() - t1 < 60_000) {
      polls++;
      if (await recallFinds(last)) {
        found = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    const t2 = performance.now();

    const report: IngestReport = {
      system: 'substrate',
      count: memories.length,
      writeMs: Math.round(t1 - t0),
      searchableMs: found ? Math.round(t2 - t1) : -1,
      // create includes embedding: Substrate embeds each row inside its write.
      phases: {
        create: Math.round(tCreated - t0),
        edges: Math.round(t1 - tCreated),
        firstHit: Math.round(t2 - t1)
      },
      notes:
        `${requests} batched mutate requests, up to ${WRITE_CONCURRENCY} in parallel ` +
        `(${deferred.length} rows updated in a second pass for same-type edges); ` +
        `each write embeds the row with Ollama ${runtime().embedModel} and keyword-indexes it inside the request. ` +
        `Recall found the last memory ${found ? `on poll ${polls}` : 'NOT within 60s'} (query = its title).` +
        (dangling > 0 ? ` ${dangling} references to unknown memories were dropped.` : '')
    };
    return report;
  },

  async agentSetup(): Promise<AgentSetup> {
    const rt = runtime();
    const cwd = join(RUN, 'agent');
    mkdirSync(cwd, { recursive: true });

    const mcpConfig = join(RUN, 'mcp.json');
    writeFileSync(
      mcpConfig,
      `${JSON.stringify(
        {
          mcpServers: {
            substrate: {
              command: rt.node,
              args: [rt.substrateBin, 'mcp'],
              env: { SUBSTRATE_URL: rt.substrateUrl, SUBSTRATE_MCP_TOOLS: MCP_TOOLS.join(',') }
            }
          }
        },
        null,
        2
      )}\n`
    );

    // What a Substrate user's agent is told: the Substrate interaction conventions
    // that ship with Substrate's agent tooling (the cortext plugin's fragment, from
    // mnmal-ai/synoptic v1.0.0-alpha.4, copied to adapters/substrate-conventions.md),
    // cut before the sections about the mailbox, identity and context store, which
    // this deployment does not run. The context-store section's note on how recall
    // hits read (handles, not bodies) is kept: it describes the recall tool itself.
    // Plus the shape of what this memory holds, read live from the server:
    // Substrate's counterpart of the vault listing and context obsidian-mind's
    // SessionStart hook injects.
    const conventions = readFileSync(join(DEMO, 'adapters', 'substrate-conventions.md'), 'utf8');
    const cut = conventions.indexOf('\n## The mailbox');
    const recallNote =
      conventions.match(/\n(\*\*Hits carry handles, not bodies\*\*[^\n]*)/)?.[1] ?? '';
    const conventionsForAgent = `${(cut > 0 ? conventions.slice(0, cut) : conventions).replace(
      /^<!--.*?-->\s*/s,
      ''
    )}${recallNote ? `\n\n## Recall\n\n${recallNote}` : ''}`;
    // The overview is left out for a run on Claude Code's defaults (eval/run.ts --defaults).
    const lines: string[] = [];
    for (const type of process.env.DEMO_CLAUDE_DEFAULTS === '1'
      ? []
      : ['Person', 'Project', 'Decision', 'Task', 'Incident']) {
      const s = await http<{ fields: Record<string, { type?: string } | string> }>(
        'GET',
        `/substrate/v1/schema/${NS}/${type}?shape=fields`
      );
      const fields = Object.entries(s.fields)
        .filter(([k]) => !['shortId', 'links'].includes(k))
        .map(
          ([k, v]) =>
            `${k}${typeof v === 'object' && v?.type && /^[A-Z]/.test(v.type) ? ` (→ ${v.type})` : ''}`
        );
      lines.push(`- \`${NS}/${type}\`: ${fields.join(', ')}`);
    }
    const deployment = `The Substrate you are connected to keeps its records in the \`${NS}\` namespace.`;
    const overview = lines.length
      ? ` Its types and fields:\n\n${lines.join('\n')}\n\nFields such as \`owner\` and \`project\` hold the related record's \`key\`; the matching \`…Ref\` field links to the record itself.`
      : '';
    const systemPrompt = `${conventionsForAgent.trim()}\n\n## This deployment\n\n${deployment}${overview}\n`;

    return {
      cwd,
      mcpConfig,
      allowedTools: MCP_TOOLS.map((t) => `mcp__substrate__${t}`),
      memoryTools: ['mcp__substrate__'],
      // Substrate's agent reads memory only through Substrate: no file tools at all.
      disallowedTools: ['Read', 'Glob', 'Grep', 'LS'],
      systemPrompt
    };
  }
};

export default adapter;
