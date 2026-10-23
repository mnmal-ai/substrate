// "Change a memory, live." Records that the Atlas project now moves to Apache
// Kafka in both systems, through each one's normal write path, and puts both
// back exactly afterwards. The same change as the recorded shared-memory scene
// (eval/shared.ts), made on this one machine.
//
//   node eval/change.ts apply | undo | status
//
// While it is applied, the Atlas question (changed-1) is graded against the new
// answer. Undo state is written as each step lands, so a change that fails
// halfway can still be put back.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  http as hindsight,
  item as hindsightItem,
  rebuildObservations
} from '../adapters/hindsight.ts';
import obsidian from '../adapters/obsidian.ts';
import { frame } from '../adapters/substrate.ts';
import type { Memory, Question } from '../src/types.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const VAULT = join(ROOT, 'vault');
const STATE = join(ROOT, '.state/change.json');
const OBSIDIAN_STATE = join(ROOT, '.state/obsidian-written.json');
const OBSIDIAN_STATE_BEFORE = join(ROOT, '.state/obsidian-written.before-change.json');

export const QUESTION_ID = 'changed-1';
const OLD_ID = 'decision-atlas-queue-migration-target-queue-2';
const NEW: Memory = {
  id: 'decision-atlas-queue-migration-target-queue-3',
  kind: 'decision',
  title: 'Atlas queue migration: target queue is Apache Kafka',
  body: 'We replaced the earlier decision (NATS JetStream). For Atlas queue migration, the target queue is now Apache Kafka, because the data team needs replayable event streams.',
  date: '2025-09-01',
  fields: {
    status: 'active',
    owner: 'person-ana-reyes',
    project: 'project-atlas-queue-migration',
    topic: 'target queue',
    choice: 'Apache Kafka',
    supersedes: OLD_ID,
    supersededBy: null
  },
  links: ['project-atlas-queue-migration', 'person-ana-reyes', OLD_ID]
};

type OldFields = { status: unknown; supersededBy: unknown; supersededByRef: unknown };
export type ChangeState = {
  applied: boolean;
  at?: string;
  substrate?: { old: string; created: string; before: OldFields };
  obsidianBase?: string;
  hindsight?: { retained: string[] };
  timings?: { substrateMs?: number; obsidianMs?: number; hindsightMs?: number };
};

export const changeState = (): ChangeState =>
  existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { applied: false };
const save = (s: ChangeState) => writeFileSync(STATE, `${JSON.stringify(s, null, 1)}\n`);

// While the change is applied, the Atlas question is graded against the new answer.
export function withChange(questions: Question[]): Question[] {
  if (!changeState().applied) return questions;
  return questions.map((q) =>
    q.id !== QUESTION_ID
      ? q
      : {
          ...q,
          gold: { mustInclude: ['Kafka'], mustNotInclude: ['NATS JetStream', 'Amazon SQS'] },
          why: 'Changed live: Atlas now moves to Apache Kafka. The two earlier decisions are still on record and read almost the same.'
        }
  );
}

const git = (...args: string[]) =>
  execFileSync('git', ['-C', VAULT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
const rowOf = async (type: string, key: string, fields: Record<string, true> = { id: true }) => {
  const d = await frame('/substrate/v1/query', {
    [`lumen/${type}`]: { params: { where: { key: { eq: key } } }, fields }
  });
  return (d[`lumen/${type}`] as Array<Record<string, unknown>>)[0];
};
// obsidian-mind's re-index runs blocking child processes; yield first so a caller
// streaming progress (the demo page) gets the lines already logged.
const flush = () => new Promise((r) => setTimeout(r, 50));
const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

export async function applyChange(
  log: (s: string) => void,
  onTiming: (system: 'substrate' | 'obsidian' | 'hindsight', ms: number) => void = () => {}
): Promise<ChangeState> {
  if (changeState().applied) throw new Error('The change is already made. Put it back first.');
  const loaded = existsSync(join(ROOT, '.state/loaded.json'))
    ? JSON.parse(readFileSync(join(ROOT, '.state/loaded.json'), 'utf8'))
    : { set: 'full' };
  if (loaded.set !== 'full')
    throw new Error('The live change works on the base set. Load the base set first.');
  const memories: Memory[] = JSON.parse(readFileSync(join(ROOT, 'data/memories.json'), 'utf8'));
  const changed = memories
    .map((m) =>
      m.id === OLD_ID
        ? {
            ...m,
            fields: { ...m.fields, status: 'superseded', supersededBy: NEW.id },
            links: [...m.links, NEW.id]
          }
        : m
    )
    .concat(NEW);
  const state: ChangeState = { applied: true, at: new Date().toISOString(), timings: {} };
  save(state);

  // Substrate: one server every agent talks to. The change is two writes.
  log('Substrate: recording the change…');
  const old = await rowOf('Decision', OLD_ID, {
    id: true,
    status: true,
    supersededBy: true,
    supersededByRef: true
  });
  if (!old) throw new Error(`Substrate does not hold ${OLD_ID}; reload the base set.`);
  const before: OldFields = {
    status: old.status ?? null,
    supersededBy: old.supersededBy ?? null,
    supersededByRef: old.supersededByRef ?? null
  };
  let t = performance.now();
  const [owner, project] = [
    (await rowOf('Person', 'person-ana-reyes'))?.id,
    (await rowOf('Project', 'project-atlas-queue-migration'))?.id
  ];
  const created = await frame('/substrate/v1/mutate', {
    'lumen/createDecision': [
      {
        params: {
          key: NEW.id,
          title: NEW.title,
          body: NEW.body,
          date: NEW.date,
          links: NEW.links,
          ...NEW.fields,
          ownerRef: owner,
          projectRef: project,
          supersedesRef: old.id
        },
        fields: { id: true }
      }
    ]
  });
  const newId = (created['lumen/createDecision'] as Array<{ id: string }>)[0]!.id;
  state.substrate = { old: String(old.id), created: newId, before };
  save(state);
  await frame('/substrate/v1/mutate', {
    'lumen/updateDecision': [
      {
        params: { id: old.id, status: 'superseded', supersededBy: NEW.id, supersededByRef: newId },
        fields: { id: true }
      }
    ]
  });
  state.timings!.substrateMs = Math.round(performance.now() - t);
  save(state);
  onTiming('substrate', state.timings!.substrateMs);
  await flush();
  log(
    `Substrate: done in ${secs(state.timings!.substrateMs)}: the new decision, and the old one marked as replaced by it.`
  );

  // Hindsight: its normal write path, retain, for the new decision and for the old
  // one now marked as replaced (same document id, so it replaces the stored one).
  // Its LLM extracts the facts of both, so this takes seconds, not milliseconds.
  const hsDocs =
    (
      await hindsight<{ total_documents?: number }>('GET', '/stats').catch(() => ({
        total_documents: 0
      }))
    ).total_documents ?? 0;
  if (hsDocs > 0) {
    log('Hindsight: retaining the change…');
    const byChanged = new Map(changed.map((m) => [m.id, m]));
    t = performance.now();
    state.hindsight = { retained: [NEW.id, OLD_ID] };
    save(state);
    await hindsight('POST', '/memories', {
      items: [
        hindsightItem(NEW, byChanged),
        { ...hindsightItem(byChanged.get(OLD_ID)!, byChanged), update_mode: 'replace' }
      ],
      async: false
    });
    state.timings!.hindsightMs = Math.round(performance.now() - t);
    save(state);
    onTiming('hindsight', state.timings!.hindsightMs);
    log(
      `Hindsight: done in ${secs(state.timings!.hindsightMs)}: both memories retained, their facts extracted by its LLM.`
    );
  } else {
    log('Hindsight: its bank is empty, so it is left out of this change.');
  }

  // obsidian-mind: its normal write path (the notes, then QMD's re-index), then a
  // commit, as a team sharing the vault through git would.
  log('obsidian-mind: writing the note and re-indexing the vault…');
  await flush();
  git('add', '-A');
  spawnSync('git', ['-C', VAULT, 'commit', '-qm', 'memory-demo: before the live change']);
  state.obsidianBase = git('rev-parse', 'HEAD');
  if (existsSync(OBSIDIAN_STATE)) copyFileSync(OBSIDIAN_STATE, OBSIDIAN_STATE_BEFORE);
  save(state);
  t = performance.now();
  await obsidian.ingest(changed);
  git('add', '-A');
  git('commit', '-qm', 'Atlas moves to Apache Kafka');
  state.timings!.obsidianMs = Math.round(performance.now() - t);
  save(state);
  onTiming('obsidian', state.timings!.obsidianMs);
  log(
    `obsidian-mind: done in ${secs(state.timings!.obsidianMs)}: the new note, the old one marked as replaced, QMD re-indexed, committed.`
  );
  return state;
}

export async function undoChange(log: (s: string) => void): Promise<void> {
  const s = changeState();
  if (!s.applied) throw new Error('There is no change to put back.');
  if (s.substrate) {
    log('Substrate: putting it back…');
    await frame('/substrate/v1/mutate', {
      'lumen/deleteDecision': [{ params: { id: s.substrate.created }, fields: { id: true } }]
    });
    await frame('/substrate/v1/mutate', {
      'lumen/updateDecision': [
        { params: { id: s.substrate.old, ...s.substrate.before }, fields: { id: true } }
      ]
    });
    log('Substrate: back as it was.');
  }
  if (s.hindsight) {
    log('Hindsight: putting it back…');
    const memories: Memory[] = JSON.parse(readFileSync(join(ROOT, 'data/memories.json'), 'utf8'));
    const byId = new Map(memories.map((m) => [m.id, m]));
    await hindsight('DELETE', `/documents/${encodeURIComponent(NEW.id)}`).catch(() => undefined);
    await hindsight('POST', '/memories', {
      items: [{ ...hindsightItem(byId.get(OLD_ID)!, byId), update_mode: 'replace' }],
      async: false
    });
    log('Hindsight: the new decision deleted; the old one retained again from its original text.');
    // Observations consolidated from the change outlive its document; rebuild them.
    log('Hindsight: rebuilding its observations from the restored facts (a few minutes)…');
    await rebuildObservations();
    const left = await mentions('Kafka');
    log(
      left > 0
        ? `Hindsight: ${left} result(s) still mention Kafka; run Put it back again.`
        : 'Hindsight: back as it was.'
    );
  }
  if (s.obsidianBase) {
    log('obsidian-mind: putting it back…');
    await flush();
    git('reset', '-q', '--hard', s.obsidianBase);
    const r = spawnSync('qmd', ['--index', 'vault', 'update'], {
      cwd: VAULT,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' }
    });
    if (r.status !== 0) throw new Error(`qmd update: ${r.stderr.slice(-300)}`);
    if (existsSync(OBSIDIAN_STATE_BEFORE)) {
      copyFileSync(OBSIDIAN_STATE_BEFORE, OBSIDIAN_STATE);
      rmSync(OBSIDIAN_STATE_BEFORE);
    }
    log('obsidian-mind: back as it was.');
  }
  rmSync(STATE, { force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  const log = (s: string) => console.log(s);
  if (cmd === 'apply') await applyChange(log);
  else if (cmd === 'undo') await undoChange(log);
  else console.log(JSON.stringify(changeState(), null, 1));
}
