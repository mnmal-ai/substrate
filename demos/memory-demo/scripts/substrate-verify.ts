// End-to-end check of the Substrate adapter: reset, ingest a memory file, print
// the IngestReport, then ask Claude one question through Substrate's MCP server.
//
//   scripts/substrate-up.sh
//   node scripts/substrate-verify.ts [data/sample.json] ["question"]
//
// Runs `claude -p` on the subscription (ANTHROPIC_API_KEY removed).
//
// The brief's bare command (only --allowedTools) is not a sandbox: in -p mode
// Read/Glob/Grep are always available and the user's own permission allowlist
// can admit Bash. One bare run grepped data/questions.json and memories.json
// from the agent's cwd, which sits inside this repo. So built-in file and shell
// tools are denied here, and user-level settings are not loaded (as agent/ask.ts
// does). SUBSTRATE_VERIFY_BARE=1 runs the bare command instead.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import adapter from '../adapters/substrate.ts';
import type { Memory } from '../src/types.ts';

const file = process.argv[2] ?? 'data/sample.json';
const question = process.argv[3] ?? 'Which queue is the Atlas project moving to, and why?';
const memories = JSON.parse(readFileSync(file, 'utf8')) as Memory[];

let t = performance.now();
await adapter.reset();
console.log(`reset: ${Math.round(performance.now() - t)} ms`);

const report = await adapter.ingest(memories);
console.log('IngestReport:', JSON.stringify(report, null, 2));

const setup = await adapter.agentSetup();
const args = [
  '-p',
  question,
  '--mcp-config',
  setup.mcpConfig,
  '--strict-mcp-config',
  '--allowedTools',
  setup.allowedTools.join(','),
  '--output-format',
  'json',
  '--verbose',
  '--model',
  process.env.DEMO_MODEL ?? 'claude-sonnet-5-5'
];
if (process.env.SUBSTRATE_VERIFY_BARE !== '1') {
  args.push(
    '--disallowedTools',
    'Bash,Read,Glob,Grep,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task,Agent,TodoWrite',
    '--setting-sources',
    'project,local'
  );
}
// The same instructions and limits agent/ask.ts gives every run.
if (setup.systemPrompt) args.push('--append-system-prompt', setup.systemPrompt);
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
env.ENABLE_TOOL_SEARCH = 'false';
env.MAX_MCP_OUTPUT_TOKENS = '100000';

console.log(
  `\nclaude ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n  (cwd ${setup.cwd})`
);
t = performance.now();
const out = spawnSync('claude', args, {
  cwd: setup.cwd,
  env,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024
});
const wallMs = Math.round(performance.now() - t);
if (out.status !== 0) {
  console.error(out.stderr || out.stdout);
  process.exit(1);
}

// With --verbose, json output is the whole message list; without, one result object.
const parsed = JSON.parse(out.stdout);
type Block = { type?: string; name?: string; input?: unknown };
type Event = {
  type?: string;
  subtype?: string;
  message?: { content?: Block[] };
  num_turns?: number;
  total_cost_usd?: number;
  result?: string;
  apiKeySource?: string;
  mcp_servers?: unknown;
  tools?: string[];
};
const events: Event[] = Array.isArray(parsed) ? parsed : [parsed];
const result = events.find((e) => e.type === 'result');
const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
const toolUses = events
  .filter((e) => e.type === 'assistant')
  .flatMap((e) => e.message?.content ?? [])
  .filter((c) => c.type === 'tool_use');

console.log(
  `\nwall: ${wallMs} ms, turns: ${result?.num_turns}, cost-equivalent: $${result?.total_cost_usd ?? '?'} (subscription, not billed)`
);
if (init) {
  console.log(`billed to an API key: ${init.apiKeySource === 'none' ? 'no' : 'yes'}`);
  console.log(`mcp servers: ${JSON.stringify(init.mcp_servers)}`);
  console.log(
    `substrate tools offered: ${(init.tools ?? []).filter((n) => n.startsWith('mcp__substrate__')).join(', ')}`
  );
}
console.log(`tool calls (${toolUses.length}):`);
for (const c of toolUses) console.log(`  ${c.name} ${JSON.stringify(c.input).slice(0, 300)}`);
console.log(`\nanswer:\n${result?.result}`);

const answer = String(result?.result ?? '').toLowerCase();
const usedSubstrate = toolUses.some((c) => (c.name ?? '').startsWith('mcp__substrate__'));
const offSubstrate = toolUses.filter(
  (c) => !(c.name ?? '').startsWith('mcp__substrate__') && c.name !== 'ToolSearch'
);
const ok = answer.includes('jetstream') && usedSubstrate && offSubstrate.length === 0;
console.log(
  `\ncheck: mentions JetStream=${answer.includes('jetstream')}, used Substrate tools=${usedSubstrate}, ` +
    `non-Substrate tool calls=${offSubstrate.length} -> ${ok ? 'PASS' : 'FAIL'}`
);
process.exit(ok ? 0 : 1);
