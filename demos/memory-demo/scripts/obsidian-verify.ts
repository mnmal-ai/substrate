/**
 * End-to-end check of the obsidian-mind adapter:
 * reset, ingest data/sample.json, print the IngestReport, then ask one
 * question through `claude -p` from the vault on the Claude subscription
 * (ANTHROPIC_API_KEY removed from the environment) and print the answer and
 * the tools it called (read from the session transcript).
 *
 *   node scripts/obsidian-verify.ts
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import adapter from '../adapters/obsidian.ts';
import type { Memory } from '../src/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUESTION = 'Which queue is the Atlas project moving to, and why?';

await adapter.reset();
const memories = JSON.parse(readFileSync(join(ROOT, 'data/sample.json'), 'utf-8')) as Memory[];
const report = await adapter.ingest(memories);
console.log('IngestReport:', JSON.stringify(report, null, 2));

const setup = await adapter.agentSetup();
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
const args = [
  '-p',
  QUESTION,
  '--mcp-config',
  setup.mcpConfig,
  '--strict-mcp-config',
  '--allowedTools',
  setup.allowedTools.join(','),
  '--output-format',
  'json',
  '--model',
  'claude-sonnet-5-5'
];
const t0 = performance.now();
const run = spawnSync('claude', args, {
  cwd: setup.cwd,
  env,
  encoding: 'utf-8',
  maxBuffer: 64 * 1024 * 1024
});
const wallMs = Math.round(performance.now() - t0);
if (run.status !== 0) {
  console.error(`claude exited ${run.status}\n${run.stderr}\n${run.stdout}`);
  process.exit(1);
}
const out = JSON.parse(run.stdout) as {
  result: string;
  session_id: string;
  num_turns: number;
  is_error: boolean;
  usage?: Record<string, number>;
};

// Tool calls, from the session transcript Claude Code writes under ~/.claude/projects/.
const projects = join(homedir(), '.claude', 'projects');
let transcript: string | null = null;
for (const dir of readdirSync(projects)) {
  const p = join(projects, dir, `${out.session_id}.jsonl`);
  if (existsSync(p)) transcript = p;
}
const tools: { name: string; input: unknown }[] = [];
if (transcript) {
  for (const line of readFileSync(transcript, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content as {
      type: string;
      name?: string;
      input?: unknown;
    }[]) {
      if (block.type === 'tool_use') tools.push({ name: block.name ?? '?', input: block.input });
    }
  }
}

const memoryCalls = tools.filter((t) =>
  setup.memoryTools.some((m) => t.name === m || t.name.startsWith(m))
);
console.log(
  `\nQuestion: ${QUESTION}\nAnswer (${wallMs} ms, ${out.num_turns} turns):\n${out.result}\n`
);
console.log(`Tool calls (${tools.length}, ${memoryCalls.length} memory):`);
for (const t of tools) console.log(`  - ${t.name} ${JSON.stringify(t.input)}`);
const pass = /nats jetstream/i.test(out.result);
console.log(`\nMentions NATS JetStream: ${pass ? 'yes' : 'NO'}`);
process.exit(pass ? 0 : 1);
