/**
 * Picks the pre-merge run's mode (see pre-merge.yml), and in `follow` mode waits for
 * the followed run's gate. Talks to the GitHub REST API with GH_TOKEN.
 *
 * CLI: `node pre-merge-mode.mjs` prints `mode=<run|follow|release|docs>`, `follow=<run id>` and
 * `only=<* | workspace dirs the change reaches, space-separated>` for $GITHUB_OUTPUT.
 * `node pre-merge-mode.mjs follow` exits 0 when run $FOLLOW's gate succeeded, 1 otherwise.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';

const GATE = 'Pre-merge Postgres gate';
const SUITE_JOB = /^pg /;

/** A changed line of a package.json patch that only moves "version". */
const VERSION_LINE = /^[+-]\s*"version":\s*"[^"]*",?\s*$/;

/**
 * True when a PR changes only package.json "version" lines and CHANGELOG.md.
 * @param {Array<{ filename: string, patch?: string }>} files
 */
export function isVersionOnly(files) {
  if (files.length === 0) return false;
  return files.every(({ filename, patch }) => {
    if (filename === 'CHANGELOG.md') return true;
    if (!filename.endsWith('package.json') || patch === undefined) return false;
    const changed = patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
    return changed.length > 0 && changed.every((l) => VERSION_LINE.test(l));
  });
}

/**
 * A path no Postgres suite reads: Markdown, docs/, the site workflow, and the site's own
 * source and assets. The site's examples, tests and config stay out: its Postgres pass runs them.
 * @param {string} f
 */
const isDocsPath = (f) =>
  f.endsWith('.md') ||
  f.startsWith('docs/') ||
  f === '.github/workflows/site.yml' ||
  f.startsWith('apps/site/src/') ||
  f.startsWith('apps/site/public/');

/**
 * True when every file a PR changes, and every path a rename moved from, is a docs path.
 * @param {Array<{ filename: string, previous_filename?: string }>} files
 */
export function isDocsOnly(files) {
  if (files.length === 0) return false;
  return files.every(
    ({ filename, previous_filename }) =>
      isDocsPath(filename) && (previous_filename === undefined || isDocsPath(previous_filename))
  );
}

const WORKSPACE_ROOTS = ['apps', 'packages', 'plugins'];

/**
 * The workspace as `{ <dir>: [<dir of each workspace package it depends on>] }`, read from the
 * package.json files under `root`.
 * @param {string} root
 */
export function workspaceGraph(root = '.') {
  const pkgs = WORKSPACE_ROOTS.flatMap((r) =>
    existsSync(`${root}/${r}`) ? readdirSync(`${root}/${r}`).map((d) => `${r}/${d}`) : []
  )
    .filter((dir) => existsSync(`${root}/${dir}/package.json`))
    .map((dir) => ({ dir, json: JSON.parse(readFileSync(`${root}/${dir}/package.json`, 'utf8')) }));
  const dirOf = new Map(pkgs.map((p) => [p.json.name, p.dir]));
  const graph = {};
  for (const { dir, json } of pkgs) {
    const deps = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .flatMap((k) => Object.keys(json[k] ?? {}))
      .map((name) => dirOf.get(name))
      .filter((d) => d !== undefined && d !== dir);
    graph[dir] = [...new Set(deps)].sort();
  }
  return graph;
}

/**
 * The workspace dirs a PR's changes reach: each package with a changed file, and every package
 * that depends on one, directly or through others. Docs paths reach nothing. `null` means all
 * of them: a file outside every package changed (the lockfile, the catalog, a workflow, root
 * config), and any package may read it.
 * @param {Array<{ filename: string, previous_filename?: string }>} files
 * @param {Record<string, string[]>} graph
 */
export function affectedDirs(files, graph) {
  const changed = new Set();
  for (const f of files.flatMap((x) => [x.filename, x.previous_filename])) {
    if (f === undefined || isDocsPath(f)) continue;
    const dir = f.split('/').slice(0, 2).join('/');
    if (!Object.hasOwn(graph, dir)) return null;
    changed.add(dir);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [dir, deps] of Object.entries(graph)) {
      if (!changed.has(dir) && deps.some((d) => changed.has(d))) {
        changed.add(dir);
        grew = true;
      }
    }
  }
  return [...changed].sort();
}

/**
 * The run to follow: the newest other run on this commit that started the suites.
 * @param {Array<{ id: number, created_at: string, suiteJobs: number }>} runs
 * @param {number} self
 */
export function pickFollow(runs, self) {
  return runs
    .filter((r) => r.id !== self && r.suiteJobs > 0)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.id;
}

async function api(path) {
  const res = await fetch(`https://api.github.com/repos/${process.env.REPO}/${path}`, {
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: 'application/vnd.github+json'
    }
  });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function prFiles() {
  const files = [];
  for (let page = 1; ; page++) {
    const batch = await api(`pulls/${process.env.PR}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) return files;
  }
}

async function suiteRuns() {
  const { workflow_runs } = await api(
    `actions/workflows/pre-merge.yml/runs?head_sha=${process.env.SHA}&per_page=50`
  );
  return Promise.all(
    workflow_runs.map(async (r) => {
      const { jobs } = await api(`actions/runs/${r.id}/jobs?per_page=100`);
      return {
        id: r.id,
        created_at: r.created_at,
        suiteJobs: jobs.filter((j) => SUITE_JOB.test(j.name)).length
      };
    })
  );
}

async function chooseMode() {
  const files = await prFiles();
  // The files API lists at most 3000 files; a longer PR runs the suites rather than be judged on part.
  const { changed_files } = await api(`pulls/${process.env.PR}`);
  if (files.length < changed_files) return { mode: 'run' };
  if (isVersionOnly(files)) return { mode: 'release' };
  if (isDocsOnly(files)) return { mode: 'docs' };
  const { ACTION, ADDED, RUN_ID } = process.env;
  if (ACTION === 'labeled' && ADDED !== 'ready-to-merge') {
    // Labels added together fire together: give the run that starts the suites time to plan them.
    for (let i = 0; i < 6; i++) {
      await sleep(15_000);
      const follow = pickFollow(await suiteRuns(), Number(RUN_ID));
      if (follow !== undefined) return { mode: 'follow', follow };
    }
  }
  return { mode: 'run', only: affectedDirs(files, workspaceGraph()) };
}

async function followGate() {
  // shortcut: polls for up to 60 min, the suites' worst case; raise it if they grow past that.
  for (let i = 0; i < 360; i++) {
    const { jobs } = await api(`actions/runs/${process.env.FOLLOW}/jobs?per_page=100`);
    const gate = jobs.find((j) => j.name === GATE);
    if (gate?.status === 'completed') {
      console.log(`run ${process.env.FOLLOW}: ${GATE} ${gate.conclusion}`);
      return gate.conclusion === 'success';
    }
    await sleep(10_000);
  }
  console.log(`::error::run ${process.env.FOLLOW} did not finish within 60 min`);
  return false;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === 'follow') {
    process.exit((await followGate()) ? 0 : 1);
  } else {
    const { mode, follow, only } = await chooseMode();
    console.log(`mode=${mode}`);
    console.log(`follow=${follow ?? ''}`);
    console.log(`only=${only == null ? '*' : only.join(' ')}`);
  }
}
