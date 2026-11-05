// Puts one question to a Claude session that can use only one memory system,
// and measures what it did: every tool call and how long it took, how many of
// those were memory lookups, tokens, wall time, and (for set questions) a grade.
//
// Runs on the Claude subscription: ANTHROPIC_API_KEY is removed from the
// environment, so `claude` uses its logged-in account, never an API key.

import { spawn } from 'node:child_process';
import type { AgentSetup, AskResult, MemoryAdapter, Question, ToolCall } from '../src/types.ts';

export const MODEL = process.env.DEMO_MODEL ?? 'claude-sonnet-5-5';

// Tools neither system needs; denied so both sessions have the same reach.
const DENIED = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite'
];

export type AskEvent =
  | { type: 'tool'; id: string; name: string; input: unknown; isMemory: boolean }
  | {
      type: 'toolDone';
      id: string;
      name: string;
      durationMs: number;
      isMemory: boolean;
      output: string;
      isError: boolean;
    }
  | { type: 'text'; text: string }
  | { type: 'done'; result: AskResult };

const LEAK =
  /questions\.json|memories(-x\d+)?\.json|sample\.json|generate\.ts|CONTRACT\.md|TALKING-POINTS|memory-demo\/(data|results|adapters|eval|agent|web|src|scripts)\b|\.\.\/(data|results|adapters)/;

// The parts of Claude Code's stream-json events this runner reads.
type ContentBlock = {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};
type StreamEvent = {
  type?: string;
  subtype?: string;
  message?: { content?: ContentBlock[] };
  result?: unknown;
  is_error?: boolean;
  usage?: Record<string, number | undefined>;
};

const isMemoryTool = (setup: AgentSetup, name: string) =>
  setup.memoryTools.some((m) => name === m || name.startsWith(m));

// What a tool returned, as text for the page, capped so one large read doesn't flood it.
const OUTPUT_CAP = 8000;
const resultText = (content: unknown): string => {
  const s =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((c: ContentBlock) => (c?.type === 'text' ? c.text : `[${c?.type ?? 'content'}]`))
            .join('\n')
        : '';
  return s.length > OUTPUT_CAP
    ? `${s.slice(0, OUTPUT_CAP)}\n… ${s.length - OUTPUT_CAP} more characters`
    : s;
};

// Case and punctuation are ignored, so a note's filename ("Atlas - target queue")
// or a record's key ("project-atlas-queue-migration") counts as the name.
// For counts, the last whole number in the answer is the one graded (a total
// usually follows any breakdown). A name followed by a number is a different
// name: in the larger sets "Atlas queue migration 5" is not "Atlas queue migration".
const norm = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
// Small words a reworded title adds or drops ("for the Ledger billing pipeline").
const SMALL = new Set(['the', 'a', 'an', 'is', 'are', 'to', 'of', 'for', 'on', 'in']);
const words = (s: string) =>
  norm(s)
    .trim()
    .split(' ')
    .filter((w) => w && !SMALL.has(w));

export function grade(q: Question, answer: string): boolean {
  return gradeWith(norm, q, answer);
}

/**
 * Whether the answer names the right items in other words: each expected title's
 * words (small words aside) all appear in one line of the answer, in any order,
 * so "Target queue: NATS JetStream (Atlas queue migration)" counts for "Atlas queue
 * migration: target queue is NATS JetStream". Not the grade: exact titles are the
 * rule, since an agent acting on a record needs its real name. Recorded so the
 * scoreboard can say how many misses were rewording only.
 */
export function gradeIgnoringWording(q: Question, answer: string): boolean {
  const lines = answer.split('\n').map((l) => new Set(words(l)));
  const named = (s: string) => {
    const need = words(s);
    return lines.some((l) => need.every((w) => l.has(w)));
  };
  if (!q.gold.mustInclude.every(named)) return false;
  if ((q.gold.mustNotInclude ?? []).some(named)) return false;
  return gradeWith(
    norm,
    { ...q, gold: { ...q.gold, mustInclude: [], mustNotInclude: [] } },
    answer
  );
}

function gradeWith(norm: (s: string) => string, q: Question, answer: string): boolean {
  const a = norm(answer);
  const has = (s: string) => {
    const n = norm(s);
    for (let i = a.indexOf(n); i !== -1; i = a.indexOf(n, i + 1))
      if (!/^\d/.test(a.slice(i + n.length))) return true;
    return false;
  };
  if (!q.gold.mustInclude.every(has)) return false;
  if ((q.gold.mustNotInclude ?? []).some(has)) return false;
  if (q.gold.exactNumber !== undefined) {
    const nums = answer.match(/-?\d+/g);
    const last = nums ? Number(nums[nums.length - 1]) : NaN;
    if (last !== q.gold.exactNumber && !(q.gold.altNumbers ?? []).includes(last)) return false;
  }
  return true;
}

export async function ask(
  adapter: MemoryAdapter,
  question: string | Question,
  onEvent: (e: AskEvent) => void = () => {}
): Promise<AskResult> {
  const setup = await adapter.agentSetup();
  const q = typeof question === 'string' ? undefined : question;
  const text = typeof question === 'string' ? question : question.question;
  const args = [
    '-p',
    text,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    MODEL,
    '--mcp-config',
    setup.mcpConfig,
    '--strict-mcp-config',
    '--allowedTools',
    setup.allowedTools.join(','),
    '--disallowedTools',
    [...DENIED, ...(setup.disallowedTools ?? [])].join(','),
    // Project settings only: the system's own hooks load, the demo machine's personal ones don't.
    '--setting-sources',
    'project,local',
    '--no-session-persistence'
  ];
  if (setup.systemPrompt) args.push('--append-system-prompt', setup.systemPrompt);

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.NODE_OPTIONS;
  // Load every MCP tool up front for all systems, instead of discovering them
  // through ToolSearch mid-answer (a harness cost, not a memory-system cost).
  // DEMO_CLAUDE_DEFAULTS=1 (eval/run.ts --defaults) leaves Claude Code as it ships.
  if (process.env.DEMO_CLAUDE_DEFAULTS === '1') delete env.ENABLE_TOOL_SEARCH;
  else env.ENABLE_TOOL_SEARCH = 'false';
  // An MCP result over Claude Code's inline limit is saved to a file for the agent
  // to read, but these agents have no file tools (so none can open the answer key).
  // A high limit keeps every system's results inline, for all of them alike.
  env.MAX_MCP_OUTPUT_TOKENS = '100000';

  // A memory system with its own LLM (Hindsight) reports what that LLM spent, so
  // the answer's cost is not hidden inside the memory system.
  const sysTokens = (adapter as { llmTokens?: () => Promise<{ input: number; output: number }> })
    .llmTokens;
  const sysBefore = sysTokens ? await sysTokens().catch(() => null) : null;
  const started = performance.now();
  const pending = new Map<string, { name: string; input: unknown; at: number }>();
  const calls: ToolCall[] = [];
  let answer = '';
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let error: string | undefined;

  await new Promise<void>((resolve) => {
    const child = spawn('claude', args, { cwd: setup.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev: StreamEvent;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const now = performance.now();
        if (ev.type === 'assistant') {
          for (const c of ev.message?.content ?? []) {
            if (c.type === 'tool_use') {
              const id = c.id ?? '';
              const name = c.name ?? '';
              pending.set(id, { name, input: c.input, at: now });
              onEvent({
                type: 'tool',
                id,
                name,
                input: c.input,
                isMemory: isMemoryTool(setup, name)
              });
            } else if (c.type === 'text' && c.text) {
              onEvent({ type: 'text', text: c.text });
            }
          }
        } else if (ev.type === 'user') {
          for (const c of ev.message?.content ?? []) {
            if (c.type !== 'tool_result') continue;
            const toolUseId = c.tool_use_id ?? '';
            const p = pending.get(toolUseId);
            if (!p) continue;
            pending.delete(toolUseId);
            const call: ToolCall = {
              name: p.name,
              input: p.input,
              durationMs: Math.round(now - p.at),
              isMemory: isMemoryTool(setup, p.name)
            };
            calls.push(call);
            onEvent({
              type: 'toolDone',
              id: toolUseId,
              name: call.name,
              durationMs: call.durationMs,
              isMemory: call.isMemory,
              output: resultText(c.content),
              isError: !!c.is_error
            });
          }
        } else if (ev.type === 'result') {
          answer = typeof ev.result === 'string' ? ev.result : '';
          if (ev.is_error) error = ev.subtype ?? 'error';
          const u = ev.usage ?? {};
          usage = {
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0
          };
        }
      }
    });
    child.on('close', (code) => {
      if (code !== 0 && !answer) error = `claude exited ${code}: ${stderr.trim().slice(-400)}`;
      resolve();
    });
  });

  // The answer key and the demo's own code live next to the vault. Any run that
  // touches them is thrown out, whatever its answer.
  const leak = calls.find((c) => LEAK.test(JSON.stringify(c.input ?? '')));
  if (leak) error = `touched the demo's own files (${leak.name}); run discarded`;
  const memory = calls.filter((c) => c.isMemory);
  const sysAfter = sysBefore && sysTokens ? await sysTokens().catch(() => null) : null;
  const result: AskResult = {
    system: adapter.name,
    questionId: q?.id,
    answer: answer.trim(),
    toolCalls: calls,
    memoryCalls: memory.length,
    memoryMs: memory.reduce((s, c) => s + c.durationMs, 0),
    ...(sysBefore && sysAfter
      ? {
          memoryLlmTokens: {
            input: sysAfter.input - sysBefore.input,
            output: sysAfter.output - sysBefore.output
          }
        }
      : {}),
    tokens: usage,
    wallMs: Math.round(performance.now() - started),
    passed: q ? !leak && grade(q, answer) : undefined,
    passedIgnoringWording: q ? !leak && gradeIgnoringWording(q, answer) : undefined,
    error
  };
  onEvent({ type: 'done', result });
  return result;
}

// CLI: node agent/ask.ts <substrate|obsidian|hindsight> "question"   or   node agent/ask.ts <system> --id changed-1
if (import.meta.url === `file://${process.argv[1]}`) {
  const [system, ...rest] = process.argv.slice(2);
  const adapter = (await import(`../adapters/${system}.ts`)).default as MemoryAdapter;
  let question: string | Question = rest.join(' ');
  if (rest[0] === '--id') {
    const { readFileSync } = await import('node:fs');
    const qs: Question[] = JSON.parse(
      readFileSync(new URL('../data/questions.json', import.meta.url), 'utf8')
    );
    question = qs.find((x) => x.id === rest[1])!;
  }
  const r = await ask(adapter, question, (e) => {
    if (e.type === 'tool') console.log(`  -> ${e.name} ${JSON.stringify(e.input).slice(0, 120)}`);
    if (e.type === 'toolDone') console.log(`  <- ${e.name} ${e.durationMs} ms`);
  });
  console.log(JSON.stringify({ ...r, toolCalls: r.toolCalls.length }, null, 1));
}
