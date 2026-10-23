// Feeds the same memories into both systems, each through its own normal write
// path, and records how long each took and when each could find what it stored.
//
//   node eval/ingest.ts [memories file] [--only substrate,obsidian,hindsight]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IngestReport, Memory, MemoryAdapter } from '../src/types.ts';

const args = process.argv.slice(2);
const file =
  args.find((a) => a.endsWith('.json')) ??
  new URL('../data/memories.json', import.meta.url).pathname;
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const memories: Memory[] =
  import.meta.url === `file://${process.argv[1]}` ? JSON.parse(readFileSync(file, 'utf8')) : [];

export const SYSTEMS = ['obsidian', 'substrate', 'hindsight'];

export async function ingestBoth(
  mems: Memory[],
  systems = SYSTEMS,
  log = console.log
): Promise<IngestReport[]> {
  const reports: IngestReport[] = [];
  for (const name of systems) {
    const adapter = (await import(`../adapters/${name}.ts`)).default as MemoryAdapter;
    log(`${name}: reset`);
    await adapter.reset();
    log(`${name}: ingesting ${mems.length} memories`);
    const r = await adapter.ingest(mems);
    log(`${name}: wrote in ${r.writeMs} ms, searchable after ${r.searchableMs} ms more`);
    reports.push(r);
  }
  return reports;
}

/** results/ingest.json for the full set, ingest-sample.json and ingest-x5.json for the others. */
export function saveIngest(file: string, count: number, reports: IngestReport[]) {
  const out = new URL('../results/', import.meta.url).pathname;
  mkdirSync(out, { recursive: true });
  const tag = file.endsWith('sample.json')
    ? '-sample'
    : (file.match(/memories(-x\d+)?\.json$/)?.[1] ?? '');
  // A partial ingest (--only) keeps the other systems' recorded reports for the same set.
  const path = `${out}ingest${tag}.json`;
  const prev = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const kept =
    prev?.count === count
      ? (prev.reports as IngestReport[]).filter((r) => !reports.some((n) => n.system === r.system))
      : [];
  writeFileSync(
    path,
    `${JSON.stringify(
      { at: new Date().toISOString(), file, count, reports: [...kept, ...reports] },
      null,
      1
    )}\n`
  );
  // Which set both systems now hold, so the page grades against the matching answer key.
  const set = tag === '-sample' ? 'sample' : tag === '-x5' ? 'x5' : 'full';
  const state = new URL('../.state/', import.meta.url).pathname;
  mkdirSync(state, { recursive: true });
  writeFileSync(
    `${state}loaded.json`,
    `${JSON.stringify({ set, file, count, at: new Date().toISOString() })}\n`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reports = await ingestBoth(memories, only ? only.split(',') : SYSTEMS);
  saveIngest(file, memories.length, reports);
  console.table(
    reports.map((r) => ({
      system: r.system,
      count: r.count,
      writeMs: r.writeMs,
      searchableMs: r.searchableMs,
      totalMs: r.writeMs + r.searchableMs
    }))
  );
}
