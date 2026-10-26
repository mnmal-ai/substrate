// Re-asks answers that the machine, not the memory system, spoiled, and replaces
// them in a recorded run: an answer that failed to reach the Claude API ("API
// Error: ..."). With --over-ms, also answers that ran past that time, for a run
// during which the Mac is known to have slept: on an awake machine a slow answer
// is a real result and stays. Every replacement is listed in the run's `reruns`,
// with the reason and what it replaced, so the change stays visible.
//
//   node eval/rerun.ts results/three-3x.json [--over-ms 90000] [--dry-run]

import { readFileSync, writeFileSync } from 'node:fs';
import { ask } from '../agent/ask.ts';
import type { AskResult, MemoryAdapter, Question } from '../src/types.ts';

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith('.json'));
if (!file)
  throw new Error('usage: node eval/rerun.ts <results file> [--over-ms 90000] [--dry-run]');
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const overMs = Number(opt('--over-ms') ?? Number.POSITIVE_INFINITY);
const dryRun = args.includes('--dry-run');

type Recorded = AskResult & { trial: number; category: string; rerun?: string };
const doc = JSON.parse(readFileSync(file, 'utf8')) as {
  config?: string;
  questions: Question[];
  results: Recorded[];
  reruns?: Array<{
    system: string;
    questionId?: string;
    trial: number;
    reason: string;
    replaced: { wallMs: number; answer: string; passed?: boolean };
  }>;
};
if (doc.config === 'claude-code-defaults') process.env.DEMO_CLAUDE_DEFAULTS = '1';
const questions = new Map(doc.questions.map((q) => [q.id, q]));

const reason = (r: Recorded) =>
  /^API Error/.test(r.answer)
    ? 'the Claude API was unreachable'
    : r.wallMs > overMs
      ? `ran ${Math.round(r.wallMs / 1000)} s, past ${overMs / 1000} s (machine asleep or stalled)`
      : null;
const spoiled = doc.results.filter((r) => reason(r) !== null);
console.log(`${spoiled.length} of ${doc.results.length} answers to re-ask`);

const adapters: Record<string, MemoryAdapter> = {};
doc.reruns ??= [];
for (const r of spoiled) {
  const why = reason(r)!;
  console.log(`  ${r.system} ${r.questionId} trial ${r.trial}: ${why}`);
  if (dryRun) continue;
  adapters[r.system] ??= (await import(`../adapters/${r.system}.ts`)).default as MemoryAdapter;
  const fresh = await ask(adapters[r.system]!, questions.get(r.questionId!)!);
  doc.reruns.push({
    system: r.system,
    questionId: r.questionId,
    trial: r.trial,
    reason: why,
    replaced: { wallMs: r.wallMs, answer: r.answer.slice(0, 200), passed: r.passed }
  });
  Object.assign(r, fresh, { trial: r.trial, category: r.category, rerun: why });
  console.log(
    `    -> ${fresh.passed ? 'PASS' : 'fail'} ${fresh.memoryCalls} calls ${(fresh.wallMs / 1000).toFixed(1)} s`
  );
  writeFileSync(file, `${JSON.stringify(doc, null, 1)}\n`);
}
