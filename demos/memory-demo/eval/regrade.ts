// Re-applies the current grader to a recorded run, so a grading rule can change
// without re-running agents:  node eval/regrade.ts results/baseline-3x.json
import { readFileSync, writeFileSync } from 'node:fs';
import { grade, gradeIgnoringWording } from '../agent/ask.ts';
import type { Question } from '../src/types.ts';

const file = process.argv[2]!;
const doc = JSON.parse(readFileSync(file, 'utf8'));
// The answer key comes from the current question file, so a fixed key applies to recorded runs too.
const current: Question[] = JSON.parse(
  readFileSync(new URL(`../data/${doc.questionFile ?? 'questions.json'}`, import.meta.url), 'utf8')
);
doc.questions = doc.questions.map((q: Question) => current.find((c) => c.id === q.id) ?? q);
const qs = new Map<string, Question>(doc.questions.map((q: Question) => [q.id, q]));
let changed = 0;
for (const r of doc.results) {
  const before = r.passed;
  r.passedOriginalGrader ??= before;
  r.passed = !r.error && grade(qs.get(r.questionId)!, r.answer);
  r.passedIgnoringWording = !r.error && gradeIgnoringWording(qs.get(r.questionId)!, r.answer);
  if (before !== r.passed) {
    changed++;
    console.log(
      `${r.system.padEnd(9)} ${r.questionId.padEnd(10)} t${r.trial}: ${before ? 'pass' : 'fail'} -> ${r.passed ? 'pass' : 'fail'}`
    );
  }
}
doc.grader = 'normalized (case and punctuation ignored; last number for counts)';
writeFileSync(file, `${JSON.stringify(doc, null, 1)}\n`);
type Graded = { system: string; passed?: boolean; passedOriginalGrader?: boolean };
const graded = doc.results as Graded[];
for (const s of [...new Set(graded.map((r) => r.system))]) {
  const rs = graded.filter((r) => r.system === s);
  const pct = (k: 'passed' | 'passedOriginalGrader') =>
    Math.round((100 * rs.filter((r) => r[k]).length) / rs.length);
  console.log(
    `${s}: ${pct('passedOriginalGrader')}% with the original grader, ${pct('passed')}% normalized`
  );
}
console.log(`${changed} results changed`);
