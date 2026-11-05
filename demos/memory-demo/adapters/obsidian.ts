/**
 * obsidian-mind adapter.
 *
 * Writes each memory as a note the way obsidian-mind's AGENTS.md and
 * templates/ say a note of that kind is written, keeps the indexes AGENTS.md
 * says to maintain, then runs the vault's own QMD indexing (`qmd update` and
 * `qmd embed` under the vault's named index). The agent runs from the vault
 * root, so AGENTS.md, .claude/rules/, the .claude/settings.json hooks and the
 * vault's `qmd` MCP server all load as they do for a real user.
 *
 * Where each kind goes (AGENTS.md "Creating Notes" and "Note Types"):
 *   person   -> org/people/<Full name>.md            (tags: person; `title` = role)
 *   project  -> work/active/<Title>.md                (Work Note template)
 *   decision -> work/active/<Title>.md                (Decision Record template)
 *   task     -> work/active/<Title>.md                (Work Note template, with an Action Items checkbox)
 *   incident -> work/incidents/<Title>.md             (incident frontmatter: severity, status, quarter)
 * Completed work (status done/completed/archived) goes to work/archive/<YYYY>/,
 * as AGENTS.md says and as the hygiene scan flags otherwise.
 *
 * reset() removes only the notes this adapter wrote (listed in a state file
 * outside the vault) and restores the two index notes it edits from the
 * vault's git HEAD, then refreshes the QMD index.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentSetup, FieldValue, IngestReport, Memory, MemoryAdapter } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const VAULT = resolve(process.env.OBSIDIAN_VAULT ?? join(ROOT, 'vault'));
const STATE_DIR = join(ROOT, '.state');
const STATE_FILE = join(STATE_DIR, 'obsidian-written.json');
const MCP_CONFIG = join(STATE_DIR, 'obsidian.mcp.json');
const QMD = process.env.QMD_BIN ?? 'qmd';

/** Index notes AGENTS.md ("Maintaining Indexes") says to update when notes are created. */
const WORK_INDEX = 'work/Index.md';
const PEOPLE_INDEX = 'org/People & Context.md';

const ARCHIVABLE = new Set(['done', 'completed', 'archived']);

type State = { written: string[]; dirs: string[]; indexes: string[] };

// ---------------------------------------------------------------- qmd

/** The vault's QMD index name, resolved as its bootstrap, hooks and MCP wrapper do. */
function qmdIndex(): string {
  const pattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const manifest = JSON.parse(readFileSync(join(VAULT, 'vault-manifest.json'), 'utf-8')) as {
    qmd_index?: string;
    template?: string;
  };
  if (manifest.qmd_index && pattern.test(manifest.qmd_index)) return manifest.qmd_index;
  const slug = basename(VAULT)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+|[-._]+$/g, '');
  if (pattern.test(slug)) return slug;
  if (manifest.template && pattern.test(manifest.template)) return manifest.template;
  throw new Error("obsidian adapter: cannot resolve the vault's qmd index name");
}

function qmd(args: string[]): { ms: number; stdout: string } {
  const t0 = performance.now();
  const r = spawnSync(QMD, ['--index', qmdIndex(), ...args], {
    cwd: VAULT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024
  });
  const ms = performance.now() - t0;
  if (r.error) throw new Error(`qmd ${args[0]} failed to start: ${r.error.message}`);
  if (r.status !== 0)
    throw new Error(`qmd ${args[0]} exited ${r.status}: ${(r.stderr ?? '').slice(-2000)}`);
  return { ms, stdout: r.stdout ?? '' };
}

/** Does `qmd search|query <text>` return the note at `relPath`? */
function finds(mode: 'search' | 'query', text: string, relPath: string): boolean {
  const { stdout } = qmd([mode, text, '--json', '-n', '20']);
  const start = stdout.indexOf('[');
  if (start < 0) return false;
  const hits = JSON.parse(stdout.slice(start)) as { file?: string }[];
  const want = relPath.toLowerCase();
  return hits.some((h) => {
    const file = decodeURIComponent((h.file ?? '').replace(/\?.*$/, '')).toLowerCase();
    return file.endsWith(`/${want}`);
  });
}

// ---------------------------------------------------------------- state

function readState(): State {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as State;
  } catch {
    return { written: [], dirs: [], indexes: [] };
  }
}

function writeState(state: State): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------- note shape

/** A filename and link target: the note title, minus characters Obsidian refuses in names and links. */
function noteName(title: string): string {
  return title
    .replace(/[\\/:]/g, ' - ')
    .replace(/[*"<>|?#^[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function quarterOf(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return `Q${Math.ceil((m || 1) / 3)}-${y}`;
}

function statusOf(m: Memory): string | null {
  const s = m.fields.status;
  if (typeof s === 'string' && s !== '') return s;
  if (m.kind === 'incident' && typeof m.fields.resolved === 'boolean') {
    return m.fields.resolved ? 'resolved' : 'open';
  }
  return null;
}

function folderFor(m: Memory): string {
  const done = ARCHIVABLE.has((statusOf(m) ?? '').toLowerCase());
  switch (m.kind) {
    case 'person':
      return 'org/people';
    case 'incident':
      return 'work/incidents';
    case 'project':
    case 'task':
    case 'decision':
      return done ? `work/archive/${m.date.slice(0, 4)}` : 'work/active';
  }
}

function tagsFor(m: Memory): string[] {
  switch (m.kind) {
    case 'person':
      return ['person'];
    case 'project':
      return ['work-note', 'project'];
    case 'task':
      return ['work-note', 'task'];
    case 'decision':
      return ['decision'];
    case 'incident':
      return ['incident'];
  }
}

/** First sentence of the body, held near AGENTS.md's ~150-character description. */
function describe(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  const text = sentence.length >= 40 ? sentence : flat;
  if (text.length <= 160) return text;
  return `${text.slice(0, 157).replace(/\s+\S*$/, '')}…`;
}

type Note = { memory: Memory; name: string; rel: string };

function yamlScalar(v: FieldValue, link: (id: string) => string | null): string {
  if (v === null) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const target = link(v);
  return JSON.stringify(target === null ? v : `[[${target}]]`);
}

function renderNote(note: Note, byId: Map<string, Note>, backlinks: Map<string, string[]>): string {
  const m = note.memory;
  const link = (id: string): string | null => byId.get(id)?.name ?? null;
  const status = statusOf(m);

  // Frontmatter: the template's keys first, then every key in `fields`.
  const fm = new Map<string, string>();
  fm.set('date', JSON.stringify(m.date));
  fm.set('description', JSON.stringify(describe(m.body)));
  fm.set('type', m.kind);
  if (status !== null) fm.set('status', JSON.stringify(status));
  if (m.kind === 'person' && typeof m.fields.role === 'string')
    fm.set('title', JSON.stringify(m.fields.role));
  if (m.kind !== 'person') fm.set('quarter', JSON.stringify(quarterOf(m.date)));
  // The manifest requires these on incidents; the data has no value for them, so they stay blank.
  if (m.kind === 'incident') for (const k of ['ticket', 'role']) fm.set(k, '');
  for (const [k, v] of Object.entries(m.fields)) fm.set(k, yamlScalar(v, link));
  const frontmatter = [
    '---',
    ...[...fm].map(([k, v]) => (v === '' ? `${k}:` : `${k}: ${v}`)),
    'tags:',
    ...tagsFor(m).map((t) => `  - ${t}`),
    '---'
  ].join('\n');

  const out: string[] = [frontmatter, ''];
  out.push(m.kind === 'decision' ? `# Decision: ${m.title}` : `# ${m.title}`, '');

  // AGENTS.md Write-Correctness Law 1: status lives in the frontmatter plus a top status line.
  if (status !== null) {
    let line = `**Status:** ${status}`;
    const by = m.fields.supersededBy;
    const over = m.fields.supersedes;
    if (typeof by === 'string' && link(by)) line += ` — superseded by [[${link(by)}]]`;
    if (typeof over === 'string' && link(over)) line += ` — supersedes [[${link(over)}]]`;
    out.push(line, '');
  }

  switch (m.kind) {
    case 'person': {
      out.push('## Role & Team', '');
      for (const [k, v] of Object.entries(m.fields)) {
        if (v === null) continue;
        const target = typeof v === 'string' ? link(v) : null;
        out.push(`- ${k[0]!.toUpperCase()}${k.slice(1)}: ${target ? `[[${target}]]` : String(v)}`);
      }
      out.push('', '## Notes', '', m.body, '');
      break;
    }
    case 'decision':
      out.push('## Decision', '', m.body, '');
      break;
    case 'task': {
      const box = ARCHIVABLE.has((status ?? '').toLowerCase()) ? 'x' : ' ';
      out.push('## Context', '', m.body, '', '## Action Items', '', `- [${box}] ${m.title}`, '');
      break;
    }
    default:
      out.push('## Context', '', m.body, '');
  }

  // Graph-first: every outbound link, plus the notes that link here (AGENTS.md prefers bidirectional links).
  const related: string[] = [];
  for (const id of [...m.links, ...(backlinks.get(m.id) ?? [])]) {
    const target = link(id);
    if (target !== null && target !== note.name && !related.includes(target)) related.push(target);
  }
  out.push('## Related', '', ...(related.length ? related.map((r) => `- [[${r}]]`) : ['-']), '');
  return out.join('\n');
}

// ---------------------------------------------------------------- indexes

/** Replace the first bare "-" placeholder line under `heading` with `lines`. */
function fillSection(md: string, heading: string, lines: string[]): string {
  if (lines.length === 0) return md;
  const rows = md.split('\n');
  const at = rows.findIndex((r) => r.trim() === heading);
  if (at < 0) return md;
  for (let i = at + 1; i < rows.length && !/^#{1,3} /.test(rows[i]!); i++) {
    if (rows[i]!.trim() === '-') {
      rows.splice(i, 1, ...lines);
      return rows.join('\n');
    }
  }
  return md;
}

/** Replace the empty row of the table under `heading` with `lines`. */
function fillTable(md: string, heading: string, lines: string[]): string {
  if (lines.length === 0) return md;
  const rows = md.split('\n');
  const at = rows.findIndex((r) => r.trim() === heading);
  if (at < 0) return md;
  for (let i = at + 1; i < rows.length && !/^#{1,3} /.test(rows[i]!); i++) {
    if (/^\|(\s*\|)+\s*$/.test(rows[i]!.trim())) {
      rows.splice(i, 1, ...lines);
      return rows.join('\n');
    }
  }
  return md;
}

function updateIndexes(notes: Note[], byId: Map<string, Note>): Map<string, string> {
  const out = new Map<string, string>();
  const active = (n: Note) => n.rel.startsWith('work/active/');
  const projectOf = (n: Note): string | null => {
    const p = n.memory.fields.project;
    return typeof p === 'string' && byId.has(p) ? p : null;
  };

  const projects = notes.filter((n) => n.memory.kind === 'project' && active(n));
  const activeLines: string[] = [];
  for (const p of projects) {
    activeLines.push(`- [[${p.name}]]`);
    for (const t of notes.filter(
      (n) => n.memory.kind === 'task' && active(n) && projectOf(n) === p.memory.id
    )) {
      activeLines.push(`  - [[${t.name}]]`);
    }
  }
  for (const t of notes.filter(
    (n) => n.memory.kind === 'task' && active(n) && projectOf(n) === null
  )) {
    activeLines.push(`- [[${t.name}]]`);
  }
  const completed = notes
    .filter((n) => n.rel.startsWith('work/archive/'))
    .map((n) => `- [[${n.name}]]`);
  const incidents = notes.filter((n) => n.memory.kind === 'incident').map((n) => `- [[${n.name}]]`);
  const decisions = notes
    .filter((n) => n.memory.kind === 'decision')
    .sort((a, b) => a.memory.date.localeCompare(b.memory.date))
    .map(
      (n) =>
        `| ${n.memory.date} | ${n.memory.title.replace(/\|/g, '-')} | ${statusOf(n.memory) ?? ''} | [[${n.name}]] |`
    );

  const workPath = join(VAULT, WORK_INDEX);
  let work = readFileSync(workPath, 'utf-8');
  work = fillSection(work, '## Incidents', incidents);
  work = fillSection(work, '## Active Projects', activeLines);
  work = fillSection(work, '## Recently Completed', completed);
  work = fillTable(work, '## Decisions Log', decisions);
  out.set(WORK_INDEX, work);

  const people = notes.filter((n) => n.memory.kind === 'person').map((n) => `- [[${n.name}]]`);
  const peoplePath = join(VAULT, PEOPLE_INDEX);
  out.set(PEOPLE_INDEX, fillSection(readFileSync(peoplePath, 'utf-8'), '## People', people));
  return out;
}

// ---------------------------------------------------------------- adapter

async function reset(): Promise<void> {
  const state = readState();
  for (const rel of state.written) rmSync(join(VAULT, rel), { force: true });
  // Directories this adapter created, deepest first, only once empty.
  for (const rel of [...state.dirs].sort((a, b) => b.length - a.length)) {
    const dir = join(VAULT, rel);
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      /* already gone */
    }
  }
  // The index notes return to the template's version.
  const indexes = [...new Set([...state.indexes, WORK_INDEX, PEOPLE_INDEX])];
  const r = spawnSync('git', ['-C', VAULT, 'checkout', 'HEAD', '--', ...indexes], {
    encoding: 'utf-8'
  });
  if (r.status !== 0)
    throw new Error(`obsidian adapter: restoring index notes failed: ${r.stderr}`);
  writeState({ written: [], dirs: [], indexes: [] });

  // Anything else new in the content folders was not written here: report it, leave it.
  const stray = spawnSync(
    'git',
    [
      '-C',
      VAULT,
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--',
      'work',
      'org',
      'perf',
      'brain',
      'reference',
      'thinking',
      'memories'
    ],
    { encoding: 'utf-8' }
  );
  const extra = (stray.stdout ?? '')
    .split('\n')
    .filter((l) => l.startsWith('??') && l.endsWith('.md'));
  if (extra.length > 0)
    console.warn(
      `obsidian adapter: ${extra.length} note(s) in the vault were not written by the adapter and were left in place:\n${extra.join('\n')}`
    );

  // update drops the removed notes from the index; cleanup drops their
  // vectors too, so the next ingest embeds from cold instead of reusing them.
  qmd(['update']);
  qmd(['cleanup']);
}

async function ingest(memories: Memory[]): Promise<IngestReport> {
  // Name every note first, so links resolve to the names the notes get.
  const byId = new Map<string, Note>();
  const used = new Set<string>();
  for (const m of memories) {
    let name = noteName(m.title);
    if (used.has(name.toLowerCase())) name = `${name} (${m.kind})`;
    for (let i = 2; used.has(name.toLowerCase()); i++)
      name = `${noteName(m.title)} (${m.kind} ${i})`;
    used.add(name.toLowerCase());
    byId.set(m.id, { memory: m, name, rel: `${folderFor(m)}/${name}.md` });
  }
  const backlinks = new Map<string, string[]>();
  for (const m of memories) {
    for (const id of m.links) backlinks.set(id, [...(backlinks.get(id) ?? []), m.id]);
  }
  const notes = [...byId.values()];

  const state = readState();
  const t0 = performance.now();
  for (const note of notes) {
    const dir = dirname(join(VAULT, note.rel));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      state.dirs.push(dirname(note.rel));
    }
    writeFileSync(join(VAULT, note.rel), renderNote(note, byId, backlinks));
    state.written.push(note.rel);
  }
  for (const [rel, content] of updateIndexes(notes, byId)) {
    writeFileSync(join(VAULT, rel), content);
    state.indexes.push(rel);
  }
  const writeMs = performance.now() - t0;
  state.written = [...new Set(state.written)];
  state.dirs = [...new Set(state.dirs)];
  state.indexes = [...new Set(state.indexes)];
  writeState(state);

  // The vault's own indexing path: update (BM25), then embed (vectors), then
  // a keyword hit (`qmd search`, BM25, no model load) for the last memory's
  // title: what an agent's warm search path needs. A cold CLI `qmd query`
  // (~10 s of model loading) is measured separately, outside searchableMs.
  const t1 = performance.now();
  const update = qmd(['update']);
  const embed = qmd(['embed']);
  const last = byId.get(memories[memories.length - 1]!.id)!;
  let probes = 0;
  let found = false;
  const tHit = performance.now();
  // The deadline starts once indexing is done: at 1,000+ notes, embedding alone can take minutes.
  const deadline = tHit + 120_000;
  while (!found && performance.now() < deadline) {
    probes++;
    found = finds('search', last.memory.title, last.rel);
  }
  const firstHitMs = performance.now() - tHit;
  const searchableMs = performance.now() - t1;
  if (!found)
    throw new Error(
      `obsidian adapter: "${last.memory.title}" not found by qmd search within 120 s`
    );

  // For reference only, not in searchableMs: one cold CLI hybrid query.
  const tq = performance.now();
  const hybridFound = finds('query', last.memory.title, last.rel);
  const coldQueryMs = performance.now() - tq;

  return {
    system: 'obsidian',
    count: memories.length,
    writeMs: Math.round(writeMs),
    searchableMs: Math.round(searchableMs),
    phases: {
      write: Math.round(writeMs),
      update: Math.round(update.ms),
      embed: Math.round(embed.ms),
      firstHit: Math.round(firstHitMs),
      coldQuery: Math.round(coldQueryMs)
    },
    notes:
      `searchableMs = qmd update + qmd embed + first qmd search (BM25) hit, on probe ${probes}; ` +
      `coldQuery is not in searchableMs: one CLI qmd query, which loads the expansion, embedding and ` +
      `rerank models (${hybridFound ? 'found' : 'did NOT find'} the note); ` +
      `${notes.length} notes + 2 index notes written to ${VAULT}`
  };
}

async function agentSetup(): Promise<AgentSetup> {
  // The vault's .mcp.json, with absolute paths so it works from any runner.
  mkdirSync(STATE_DIR, { recursive: true });
  const config = {
    mcpServers: {
      qmd: { command: process.execPath, args: [join(VAULT, '.claude/scripts/qmd-mcp.mjs')] }
    }
  };
  writeFileSync(MCP_CONFIG, `${JSON.stringify(config, null, 2)}\n`);
  return {
    cwd: VAULT,
    mcpConfig: MCP_CONFIG,
    allowedTools: [
      'mcp__qmd__query',
      'mcp__qmd__get',
      'mcp__qmd__multi_get',
      'mcp__qmd__status',
      'Read',
      'Grep',
      'Glob'
    ],
    memoryTools: ['mcp__qmd__', 'Read', 'Grep', 'Glob']
  };
}

const adapter: MemoryAdapter = { name: 'obsidian', reset, ingest, agentSetup };
export default adapter;
