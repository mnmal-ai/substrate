// Hindsight (vectorize-io/hindsight) as the demo's third memory system.
//
// Memories go in through Hindsight's own write path, retain: each memory is
// rendered as the prose a person would store, and Hindsight's LLM extracts its
// facts, entities and relationships, embeds them locally and later consolidates
// observations. The agent reads through Hindsight's MCP endpoint for the bank,
// with its read tools only. The server is started by scripts/hindsight-up.sh.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSetup, IngestReport, Memory, MemoryAdapter, MemoryKind } from '../src/types.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const RUN = join(ROOT, 'run', 'hindsight');
const URL_ = process.env.HINDSIGHT_URL ?? `http://127.0.0.1:${process.env.HINDSIGHT_PORT ?? 8888}`;
const BANK = process.env.HINDSIGHT_BANK ?? 'lumen';
const API = `${URL_}/v1/default/banks/${BANK}`;

// Retain requests carry this many memories each, and the demo waits for every
// one to finish (fact extraction is an LLM call per memory).
const BATCH = 25;

// The read tools a Hindsight user's agent searches memory with. The bank's MCP
// endpoint also serves write and admin tools (retain, delete_bank, ...); those
// are denied, as the other systems' agents get no write tools either.
const READ_TOOLS = [
  'recall',
  'reflect',
  'list_memories',
  'get_memory',
  'list_documents',
  'get_document'
];
const WRITE_TOOLS = [
  'retain',
  'sync_retain',
  'create_mental_model',
  'update_mental_model',
  'delete_mental_model',
  'refresh_mental_model',
  'clear_mental_model',
  'list_mental_models',
  'get_mental_model',
  'list_banks',
  'create_bank',
  'list_directives',
  'create_directive',
  'delete_directive',
  'delete_document',
  'list_operations',
  'get_operation',
  'cancel_operation',
  'list_tags',
  'get_bank',
  'get_bank_stats',
  'update_bank',
  'delete_bank',
  'clear_memories',
  'get_knowledge_base_tree',
  'search_knowledge_base',
  'get_knowledge_page',
  'create_knowledge_folder',
  'create_knowledge_page',
  'update_knowledge_node',
  'delete_knowledge_node'
];

export async function http<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(600_000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`hindsight ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const KIND: Record<MemoryKind, string> = {
  person: 'Person',
  project: 'Project',
  decision: 'Decision',
  task: 'Task',
  incident: 'Incident'
};
const words = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

/** One memory as the text a person would store: references by name, not by id. */
export function render(m: Memory, byId: Map<string, Memory>): string {
  const name = (v: unknown) =>
    typeof v === 'string' && byId.has(v) ? byId.get(v)!.title : String(v);
  const facts = Object.entries(m.fields)
    .filter(([, v]) => v !== null && v !== '')
    .map(([k, v]) => `${words(k)}: ${name(v)}`);
  return [
    `${KIND[m.kind]}: ${m.title} (${m.date})`,
    m.body,
    facts.length ? `${facts.join('; ')}.` : '',
    m.links.length ? `Related: ${m.links.map(name).join(', ')}.` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

export const item = (m: Memory, byId: Map<string, Memory>) => ({
  content: render(m, byId),
  context: m.kind,
  timestamp: `${m.date}T00:00:00Z`,
  document_id: m.id,
  tags: [m.kind],
  metadata: { id: m.id, kind: m.kind }
});

type Operation = { status?: string; operation_type?: string; error_message?: string | null };
const done = (s?: string) =>
  ['completed', 'failed', 'cancelled', 'succeeded', 'success'].includes(String(s));

async function waitFor(ids: string[], deadlineMs: number): Promise<void> {
  const pending = new Set(ids);
  const t0 = performance.now();
  while (pending.size && performance.now() - t0 < deadlineMs) {
    for (const id of [...pending]) {
      const op = await http<Operation>('GET', `/operations/${id}`);
      if (done(op.status)) {
        if (op.status === 'failed')
          throw new Error(`hindsight retain failed: ${op.error_message ?? 'no message'}`);
        pending.delete(id);
      }
    }
    if (pending.size) await new Promise((r) => setTimeout(r, 1000));
  }
  if (pending.size)
    throw new Error(
      `hindsight: ${pending.size} retain operations still running after ${deadlineMs / 1000} s`
    );
}

/** Wait until the bank has no queued or running background work (retain, consolidation). */
export async function idle(deadlineMs = 1_800_000): Promise<number> {
  const t0 = performance.now();
  const open = async (status: string) =>
    (await http<{ total?: number }>('GET', `/operations?status=${status}&limit=1`)).total ?? 0;
  for (;;) {
    if ((await open('pending')) + (await open('processing')) === 0)
      return Math.round(performance.now() - t0);
    if (performance.now() - t0 > deadlineMs)
      throw new Error('hindsight: background work still running');
    await new Promise((res) => setTimeout(res, 2000));
  }
}

/**
 * Rebuild the bank's observations from the facts it holds now. Observations are
 * derived (Hindsight's LLM consolidates them in the background), and deleting a
 * document does not remove observations already built from it, so putting back
 * a change ends with this. It takes minutes and LLM tokens, like any consolidation.
 */
export async function rebuildObservations(): Promise<void> {
  // Let consolidation already under way finish first: a job that started from the
  // change would otherwise write its observation after the clear.
  await idle();
  await http('DELETE', '/observations');
  await http('POST', '/consolidate', {});
  await new Promise((r) => setTimeout(r, 5000));
  await idle();
}

/** How many of the bank's facts and observations mention `term`: a check that a put-back change left nothing behind. */
export async function mentions(term: string): Promise<number> {
  const r = await http<{ results?: Array<{ text?: string }> }>('POST', '/memories/recall', {
    query: term,
    budget: 'high',
    max_tokens: 8192
  });
  return (r.results ?? []).filter((x) => (x.text ?? '').toLowerCase().includes(term.toLowerCase()))
    .length;
}

/** Tokens Hindsight's own LLM has spent in this bank so far (retain, consolidation, reflect). */
export async function llmTokens(): Promise<{ input: number; output: number }> {
  const s = await http<{ buckets?: Array<{ tokens?: { input?: number; output?: number } }> }>(
    'GET',
    '/llm-requests/stats?period=30d'
  );
  return (s.buckets ?? []).reduce(
    (a, b) => ({
      input: a.input + (b.tokens?.input ?? 0),
      output: a.output + (b.tokens?.output ?? 0)
    }),
    { input: 0, output: 0 }
  );
}

async function recallFinds(m: Memory): Promise<boolean> {
  // Raw facts carry the document they came from; observations can span several.
  const r = await http<{
    results?: Array<{ document_id?: string | null; metadata?: { id?: string } | null }>;
  }>('POST', '/memories/recall', {
    query: m.title,
    types: ['world', 'experience'],
    budget: 'low',
    max_tokens: 4096
  });
  return (r.results ?? []).some((x) => x.document_id === m.id || x.metadata?.id === m.id);
}

const adapter: MemoryAdapter & { idle: typeof idle; llmTokens: typeof llmTokens } = {
  name: 'hindsight',
  idle,
  llmTokens,

  async reset() {
    await fetch(`${API}`, { method: 'DELETE', signal: AbortSignal.timeout(120_000) });
    await http('PUT', '', {});
  },

  async ingest(memories: Memory[]): Promise<IngestReport> {
    await http('PUT', '', {});
    const byId = new Map(memories.map((m) => [m.id, m]));
    const before = await llmTokens();
    const t0 = performance.now();
    const ids: string[] = [];
    for (let i = 0; i < memories.length; i += BATCH) {
      const r = await http<{ operation_id?: string | null; operation_ids?: string[] | null }>(
        'POST',
        '/memories',
        {
          items: memories.slice(i, i + BATCH).map((m) => item(m, byId)),
          async: true
        }
      );
      ids.push(...(r.operation_ids ?? (r.operation_id ? [r.operation_id] : [])));
    }
    await waitFor(ids, 3_600_000);
    const t1 = performance.now();

    // Searchable: how long after the last retain finished until recall returns the last memory.
    const last = memories[memories.length - 1]!;
    let found = false;
    while (performance.now() - t1 < 120_000) {
      found = await recallFinds(last);
      if (found) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const t2 = performance.now();
    // Observations are consolidated in the background after retain; the questions
    // are asked once that settles, so it is timed too, outside searchableMs.
    const consolidateMs = await idle();
    const after = await llmTokens();
    return {
      system: 'hindsight',
      count: memories.length,
      writeMs: Math.round(t1 - t0),
      searchableMs: found ? Math.round(t2 - t1) : -1,
      phases: {
        retain: Math.round(t1 - t0),
        firstHit: Math.round(t2 - t1),
        consolidation: consolidateMs
      },
      notes:
        `retain: ${ids.length} async batches of up to ${BATCH}; writeMs runs until every retain operation completed ` +
        `(fact extraction is one LLM call per memory, via the claude-code provider on the Claude subscription). ` +
        `Background consolidation afterwards: ${consolidateMs} ms. Hindsight's own LLM for this ingest: ` +
        `${after.input - before.input} input and ${after.output - before.output} output tokens.`
    };
  },

  async agentSetup(): Promise<AgentSetup> {
    const cwd = join(RUN, 'agent');
    mkdirSync(cwd, { recursive: true });
    const mcpConfig = join(RUN, 'mcp.json');
    writeFileSync(
      mcpConfig,
      `${JSON.stringify(
        { mcpServers: { hindsight: { type: 'http', url: `${URL_}/mcp/${BANK}/` } } },
        null,
        2
      )}\n`
    );
    return {
      cwd,
      mcpConfig,
      allowedTools: READ_TOOLS.map((t) => `mcp__hindsight__${t}`),
      memoryTools: ['mcp__hindsight__'],
      // Hindsight's agent reads memory only through Hindsight: no file tools, no write tools.
      disallowedTools: [
        'Read',
        'Glob',
        'Grep',
        'LS',
        ...WRITE_TOOLS.map((t) => `mcp__hindsight__${t}`)
      ],
      // The counterpart of the session-start context the other two systems give their agents.
      systemPrompt:
        `Your long-term memory is a Hindsight memory bank ("${BANK}") holding the team's knowledge: its people, ` +
        `projects, decisions, tasks and incidents. Use the Hindsight tools to look things up before answering.`
    };
  }
};

export default adapter;
