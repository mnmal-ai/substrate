// "Many agents, one memory." A teammate's agent on machine A records that the
// Atlas project now moves to Apache Kafka. A different agent, on machine B, is
// then asked what Atlas is moving to.
//
// obsidian-mind shares a vault across machines through git (its README:
// "git-tracked"), so machine B is a git clone of the vault with its own QMD
// index. Substrate is a server, so machine B is just another client.
//
// Afterwards both systems are put back exactly as they were.
//
//   node eval/shared.ts        -> results/shared.json

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  http as hindsight,
  item as hindsightItem,
  rebuildObservations
} from '../adapters/hindsight.ts';
import obsidian from '../adapters/obsidian.ts';
import substrate, { frame } from '../adapters/substrate.ts';
import type { AskResult, Memory } from '../src/types.ts';

const ROOT = new URL('../', import.meta.url).pathname;
const VAULT_A = join(ROOT, 'vault');
const VAULT_B = join(ROOT, 'run', 'vault-b');
const QUESTION =
  'What is the current target queue for the Atlas queue migration project? Answer with only the queue name.';
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

type Step = {
  system: string;
  step: string;
  ms: number;
  detail?: string;
  answer?: string;
  current?: boolean;
};
const steps: Step[] = [];
const log = (s: Step) => {
  steps.push(s);
  console.log(
    `${s.system.padEnd(9)} ${s.step.padEnd(34)} ${String(s.ms).padStart(7)} ms ${s.answer ? `→ ${s.answer}` : (s.detail ?? '')}`
  );
};
const timed = <T>(f: () => T): [T, number] => {
  const t = performance.now();
  const r = f();
  return [r, Math.round(performance.now() - t)];
};
const timedAsync = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
  const t = performance.now();
  const r = await f();
  return [r, Math.round(performance.now() - t)];
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
const qmd = (cwd: string, ...args: string[]) => {
  const r = spawnSync('qmd', ['--index', 'vault-b', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' }
  });
  if (r.status !== 0) throw new Error(`qmd ${args.join(' ')}: ${r.stderr.slice(-300)}`);
};
// The question goes to a separate process, as a separate agent on another machine would be.
const askAs = (system: string, vault?: string): AskResult => {
  const r = spawnSync('node', [join(ROOT, 'agent/ask.ts'), system, QUESTION], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(vault ? { OBSIDIAN_VAULT: vault } : {}) },
    timeout: 300_000
  });
  const json = r.stdout.slice(r.stdout.lastIndexOf('\n{'));
  return JSON.parse(json);
};
const isCurrent = (a: string) => /kafka/i.test(a) && !/nats/i.test(a);

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

// ---- obsidian-mind: machine A is the vault, machine B a git clone of it ----
const base = (() => {
  git(VAULT_A, 'add', '-A');
  spawnSync('git', ['-C', VAULT_A, 'commit', '-qm', 'memory-demo: shared scene base']);
  return git(VAULT_A, 'rev-parse', 'HEAD');
})();
if (existsSync(VAULT_B)) rmSync(VAULT_B, { recursive: true, force: true });
{
  const [, ms] = timed(() => {
    git(ROOT, 'clone', '-q', VAULT_A, VAULT_B);
    // What a second user of the vault runs: obsidian-mind's own QMD bootstrap (index "vault-b", from the folder name).
    const b = spawnSync('node', ['--experimental-strip-types', '.scripts/qmd-bootstrap.ts'], {
      cwd: VAULT_B,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' }
    });
    if (b.status !== 0) throw new Error(`qmd bootstrap in vault-b: ${b.stderr.slice(-300)}`);
    qmd(VAULT_B, 'update');
    qmd(VAULT_B, 'embed');
  });
  log({
    system: 'obsidian',
    step: 'machine B: clone and index the vault',
    ms,
    detail: '(setup, before the change)'
  });
}
try {
  const [, writeMs] = await timedAsync(async () => {
    await obsidian.ingest(changed);
    git(VAULT_A, 'add', '-A');
    git(VAULT_A, 'commit', '-qm', 'Atlas moves to Apache Kafka');
  });
  log({
    system: 'obsidian',
    step: 'machine A: record the change',
    ms: writeMs,
    detail: 'note written, indexed, committed'
  });
  const stale = askAs('obsidian', VAULT_B);
  log({
    system: 'obsidian',
    step: 'machine B: ask',
    ms: stale.wallMs,
    answer: stale.answer,
    current: isCurrent(stale.answer)
  });
  const [, syncMs] = timed(() => {
    git(VAULT_B, 'pull', '-q');
    qmd(VAULT_B, 'update');
    qmd(VAULT_B, 'embed');
  });
  log({
    system: 'obsidian',
    step: 'machine B: git pull and re-index',
    ms: syncMs,
    detail: 'someone has to do this'
  });
  const fresh = askAs('obsidian', VAULT_B);
  log({
    system: 'obsidian',
    step: 'machine B: ask again',
    ms: fresh.wallMs,
    answer: fresh.answer,
    current: isCurrent(fresh.answer)
  });
} finally {
  git(VAULT_A, 'reset', '-q', '--hard', base);
  spawnSync('qmd', ['--index', 'vault', 'update'], {
    cwd: VAULT_A,
    env: { ...process.env, NODE_OPTIONS: '' }
  });
  // Machine B's index is throwaway: drop it with the clone.
  rmSync(join(process.env.HOME!, '.cache/qmd/vault-b.sqlite'), { force: true });
  rmSync(VAULT_B, { recursive: true, force: true });
}

// ---- Substrate: machine A and machine B are two clients of one server ----
const rowOf = async (type: string, key: string) => {
  const d = await frame('/substrate/v1/query', {
    [`lumen/${type}`]: { params: { where: { key: { eq: key } } }, fields: { id: true } }
  });
  return (d[`lumen/${type}`] as Array<{ id: string }>)[0]?.id;
};
try {
  const [, writeMs] = await timedAsync(async () => {
    const [owner, project, old] = [
      await rowOf('Person', 'person-ana-reyes'),
      await rowOf('Project', 'project-atlas-queue-migration'),
      await rowOf('Decision', OLD_ID)
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
            supersedesRef: old
          },
          fields: { id: true }
        }
      ]
    });
    const newId = (created['lumen/createDecision'] as Array<{ id: string }>)[0]!.id;
    await frame('/substrate/v1/mutate', {
      'lumen/updateDecision': [
        {
          params: { id: old, status: 'superseded', supersededBy: NEW.id, supersededByRef: newId },
          fields: { id: true }
        }
      ]
    });
  });
  log({
    system: 'substrate',
    step: 'machine A: record the change',
    ms: writeMs,
    detail: 'two writes to the server'
  });
  const now = askAs('substrate');
  log({
    system: 'substrate',
    step: 'machine B: ask',
    ms: now.wallMs,
    answer: now.answer,
    current: isCurrent(now.answer)
  });
} finally {
  // Put Substrate back exactly as it was: the clean way is to re-ingest the base set.
  await substrate.reset();
  await substrate.ingest(memories);
}

// ---- Hindsight: also one server, so machine B is another client ----
// The change goes in through retain (its LLM re-extracts both memories); it is put
// back by deleting the new decision and retaining the old one's original text.
const byChanged = new Map(changed.map((m) => [m.id, m]));
const byBase = new Map(memories.map((m) => [m.id, m]));
try {
  const [, writeMs] = await timedAsync(() =>
    hindsight('POST', '/memories', {
      items: [
        hindsightItem(NEW, byChanged),
        { ...hindsightItem(byChanged.get(OLD_ID)!, byChanged), update_mode: 'replace' }
      ],
      async: false
    })
  );
  log({
    system: 'hindsight',
    step: 'machine A: record the change',
    ms: writeMs,
    detail: 'both memories retained; its LLM extracts their facts'
  });
  const now = askAs('hindsight');
  log({
    system: 'hindsight',
    step: 'machine B: ask',
    ms: now.wallMs,
    answer: now.answer,
    current: isCurrent(now.answer)
  });
} finally {
  await hindsight('DELETE', `/documents/${encodeURIComponent(NEW.id)}`).catch(() => undefined);
  await hindsight('POST', '/memories', {
    items: [{ ...hindsightItem(byBase.get(OLD_ID)!, byBase), update_mode: 'replace' }],
    async: false
  });
  // Observations consolidated from the change outlive its document; rebuild them.
  await rebuildObservations();
  const left = await mentions('Kafka');
  if (left > 0)
    console.warn(
      `WARNING: Hindsight still has ${left} result(s) mentioning Kafka after the rebuild`
    );
}

writeFileSync(
  join(ROOT, 'results/shared.json'),
  `${JSON.stringify({ at: new Date().toISOString(), question: QUESTION, steps }, null, 1)}\n`
);
console.log('restored all three systems; results/shared.json written');
