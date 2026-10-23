// Runs every question against both systems, several times, and writes the
// scoreboard data to results/eval-<time>.json and results/latest.json.
// By default the systems run side by side on each question, so none gets a
// quieter machine than the others. With --sequential each question goes to one
// system at a time, in an order that rotates from question to question, so the
// systems don't compete for the machine and none is always first or last.
// --defaults runs Claude Code as it ships (see below).
//
//   node eval/run.ts [--trials 3] [--only changed-1,count-2] [--systems substrate,obsidian] [--sequential]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ask } from '../agent/ask.ts';
import type { AskResult, MemoryAdapter, Question } from '../src/types.ts';

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const trials = Number(opt('--trials') ?? 3);
const onlyIds = opt('--only')?.split(',');
const systems = (opt('--systems') ?? 'obsidian,substrate,hindsight').split(',');
const qfile = opt('--questions') ?? 'questions.json';
const tag = opt('--tag');
const sequential = args.includes('--sequential');
// --defaults: Claude Code as it ships (tools found through its tool search) and no
// extra orientation beyond each system's own; read by agent/ask.ts and the adapters.
const defaults = args.includes('--defaults');
if (defaults) process.env.DEMO_CLAUDE_DEFAULTS = '1';

const questions: Question[] = JSON.parse(
  readFileSync(new URL(`../data/${qfile}`, import.meta.url), 'utf8')
).filter((q: Question) => !onlyIds || onlyIds.includes(q.id));
const adapters: MemoryAdapter[] = [];
for (const s of systems) adapters.push((await import(`../adapters/${s}.ts`)).default);

const results: (AskResult & { trial: number; category: string })[] = [];
const out = new URL('../results/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const save = () => {
  const doc = {
    at: new Date().toISOString(),
    model: process.env.DEMO_MODEL ?? 'claude-sonnet-5-5',
    trials,
    questionFile: qfile,
    tag,
    mode: sequential ? 'sequential' : 'parallel',
    config: defaults ? 'claude-code-defaults' : 'tools-up-front',
    questions,
    results
  };
  writeFileSync(`${out}eval-${stamp}.json`, `${JSON.stringify(doc, null, 1)}\n`);
  writeFileSync(
    `${out}${tag ? `${tag}.json` : 'latest.json'}`,
    `${JSON.stringify(doc, null, 1)}\n`
  );
};

const total = questions.length * trials;
let n = 0;
for (let t = 1; t <= trials; t++) {
  for (const q of questions) {
    n++;
    const one = (a: MemoryAdapter) =>
      ask(a, q).catch(
        (e) =>
          ({
            system: a.name,
            questionId: q.id,
            answer: '',
            toolCalls: [],
            memoryCalls: 0,
            memoryMs: 0,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            wallMs: 0,
            passed: false,
            error: String(e)
          }) as AskResult
      );
    let runs: AskResult[];
    if (sequential) {
      runs = [];
      for (let i = 0; i < adapters.length; i++)
        runs.push(await one(adapters[(n - 1 + i) % adapters.length]!));
    } else runs = await Promise.all(adapters.map(one));
    for (const r of runs) results.push({ ...r, trial: t, category: q.category });
    save();
    console.log(
      `[${n}/${total}] trial ${t} ${q.id.padEnd(10)} ` +
        runs
          .map(
            (r) =>
              `${r.system}: ${r.passed ? 'PASS' : 'fail'} ${r.memoryCalls} calls ${(r.wallMs / 1000).toFixed(1)}s`
          )
          .join(' | ')
    );
  }
}

const summary = systems.map((s) => {
  const rs = results.filter((r) => r.system === s);
  const avg = (f: (r: AskResult) => number) =>
    rs.reduce((a, r) => a + f(r), 0) / Math.max(rs.length, 1);
  return {
    system: s,
    accuracy: `${Math.round((100 * rs.filter((r) => r.passed).length) / Math.max(rs.length, 1))}%`,
    memoryCalls: avg((r) => r.memoryCalls).toFixed(1),
    memoryMs: Math.round(avg((r) => r.memoryMs)),
    wallSec: (avg((r) => r.wallMs) / 1000).toFixed(1),
    inputTokens: Math.round(avg((r) => r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite)),
    errors: rs.filter((r) => r.error).length
  };
});
console.table(summary);
