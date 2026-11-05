# obsidian-mind setup: what it took

Setup run on 2026-10-20 on a Mac (Apple M2, macOS, Node 24.21.0 via
mise, npm 11.19.0, Claude Code 2.1.284). Template: breferrari/obsidian-mind
at `fae7be4` (v10.0.0, 2026-10-18). The setup follows the README's "Or clone
directly" path and its "Recommended: QMD Semantic Search" section. All times
are wall-clock, measured with `/usr/bin/time -p`.

## The steps

| # | Step | Command | Time | Downloaded / installed |
|---|------|---------|------|------------------------|
| 1 | Clone the template | `git clone https://github.com/breferrari/obsidian-mind.git` | 11.6 s | 8.3 MB of git objects; 16 MB on disk (4.2 MB of it is the README's demo GIF) |
| 2 | Fill in `brain/North Star.md` | Edited by hand (short, neutral goals for Lumen Labs) | a few minutes of a person's time; not measured | none |
| 3 | Install QMD | `npm install -g @tobilu/qmd` | 30.8 s | qmd 2.8.3 plus its dependencies: 206 MB on disk |
| 4 | Bootstrap the index | `node --experimental-strip-types .scripts/qmd-bootstrap.ts` (in the vault) | 150.5 s | Embedding model Qwen3-Embedding-0.6B-Q8_0: 639 MB |
| 5 | First search | `qmd --index vault query "..."` | 427.0 s | Query-expansion model (1.28 GB) and reranker Qwen3-Reranker-0.6B (639 MB) |
| 6 | Start the agent in the vault | `claude` (here, `claude -p ...` from the vault folder) | none | none |

That is **four setup steps a person performs** (clone, North Star, install
QMD, bootstrap), then starting the agent. Step 5 is not a separate command: the
first query downloads the last two models without being asked.

- **Machine time:** about 10.3 minutes (11.6 + 30.8 + 150.5 + 427.0 s). The
  model downloads take most of it, so it depends on the network.
- **Total downloaded:** about 2.6 GB. The models are 2,560,742,688 bytes
  (2.4 GiB) and live in `~/.cache/qmd/models/`. On top of that come 206 MB
  for qmd's npm install and 8 MB for the clone.
- **Ongoing disk:** the vault's index is `~/.cache/qmd/vault.sqlite`, about 5 MB
  for this sample.

The README says the models are "~2.2 GB" and lists `embeddinggemma-300M`
(328 MB) as the embedder. The vault's own bootstrap replaces that embedder with
Qwen3-Embedding-0.6B (639 MB). That explains the extra ~0.3 GB, and why
`qmd doctor` reports "non-default model configuration".

`qmd doctor` was all green afterwards. QMD runs on the M2's GPU through Metal.

### README steps that were skipped

The README's four steps include "open the folder as an Obsidian vault" and
"enable the Obsidian CLI". **The Obsidian app is not installed on this Mac, and
I did not install it.** The README says the vault works for agents without the
app. What that costs:

- **Bases views are not available to the agent.** These are Work Dashboard,
  Incidents, People Directory and the others. They render only in the app.
  The agent can read the `.base` YAML, but not the tables it produces.
  `Home.md` embeds those views, so it shows the agent nothing useful.
- **The `obsidian` CLI and the `obsidian-cli` skill are unavailable.** These
  give vault-aware `search`, `backlinks`, `tasks` and `orphans`. AGENTS.md
  says to use the CLI only when Obsidian is already running, so the agent
  falls back to the filesystem, as AGENTS.md describes.
- **No hook uses the app.** SessionStart, for example, deliberately reads the
  filesystem (#83 in its source). Retrieval through QMD does not depend on the
  app.

## What broke, and what I changed

- **npm 11 skipped six install scripts.** These were node-llama-cpp and five
  tree-sitter grammars; npm's message suggested `--allow-scripts`. Nothing
  turned out to need them. Prebuilt binaries loaded, Metal worked, and
  `qmd doctor` passed. I did not re-run the install.
- **Re-ingesting identical content skipped embedding.** `qmd update` drops
  removed notes from the index, but their vectors stay in the store. A
  reset-then-ingest of the same sample therefore re-embedded in about 0.1 s
  instead of about 2.9 s. `reset()` now also runs `qmd cleanup`, so every
  ingest embeds from scratch. That gives a fair timing.
- **The incident note lacked `ticket` and `role`.** The vault's own write
  validator (`.claude/scripts/validate-write.ts`) flagged it, because the
  manifest requires both on incidents. The data has no value for either, so
  the adapter writes both keys blank, as a person filling in the template
  without that information would. Every adapter-written note now passes the
  validator's frontmatter checks.
- **No hook needed fixing.** Details are in the next section.

## Hooks in a headless `claude -p` session

Checked with `--output-format stream-json --verbose --include-hook-events`,
run from the vault root.

- **The Claude Code mod does not load.** It needs Claude Code 2.1.287 or later;
  this machine has 2.1.284, and npm's latest is 2.1.306. Without the mod, the
  vault's classic hooks in `.claude/settings.json` run. The README describes
  this as the supported fallback ("the hooks run exactly as before").
- **SessionStart** ran and succeeded. It injected 3.2 kB of context against its
  9.0 kB budget:
  - the North Star
  - the brain-topics index
  - open tasks (`- [ ]` lines in `work/active/`)
  - active work
  - a listing of every vault file
  - hygiene flags

  It also starts a detached `qmd update`.
- **UserPromptSubmit** (`classify-message.ts`) ran and succeeded. It added
  nothing for a question.
- **Stop** ran and succeeded. It returned a `systemMessage`, which only the
  user sees: a wrap-up checklist and a hygiene line. It saved the full report
  for the session's next prompt. A one-shot `-p` session never sends a next
  prompt, so the agent never sees the report. It also started the debounced
  `qmd update` and `qmd embed` in the background. **It added no extra turns.**
- **PostToolUse and PreCompact** did not fire. The agent has no Write or Edit
  tool, and these sessions never compact.
- **Instructions and MCP loaded.** A test prompt confirmed that the model had
  AGENTS.md and all ten `.claude/rules/*.md` files. The `qmd` MCP server showed
  `connected` in the init event.
- **Nothing blocked or errored, so I changed nothing in the vault's hooks.**

Not from obsidian-mind: The machine's own user-level settings also load into every
`claude -p` session. These include plugin hooks (the superpowers plugin alone
injects 3.6 kB of context) and a user Stop hook that exits with an error
("MCP server 'lcu' not connected"). The Substrate side gets the same. Passing
`--setting-sources project,local` removes them. I checked that with that flag
only the vault's three hooks run, all succeed, and auth is still the
subscription (`apiKeySource: none`). Whether to use the flag is a decision for
the agent runner, applied to both systems.

## How the adapter writes memories

`adapters/obsidian.ts` follows AGENTS.md ("Creating Notes", "Note Types",
"Linking", "Maintaining Indexes", "Write-Correctness Laws") and `templates/`:

| kind | folder | frontmatter beyond `fields` | body |
|------|--------|-----------------------------|------|
| person | `org/people/<Full name>.md` | `date`, `description`, `type`, `title` (= role, which People Directory shows), `tags: [person]` | Role & Team, Notes, Related |
| project | `work/active/` (`work/archive/<YYYY>/` when done) | Work Note keys: `date`, `description`, `status`, `quarter`, `tags: [work-note, project]` | Context, Related |
| decision | `work/active/` | Decision Record keys: `date`, `description`, `status`, `tags: [decision]` | `# Decision: <title>`, Decision, Related |
| task | `work/active/` (`work/archive/<YYYY>/` when done) | Work Note keys, `tags: [work-note, task]` | Context, Action Items (`- [ ]` / `- [x]`), Related |
| incident | `work/incidents/` | `date`, `description`, `status` (from `resolved`), `quarter`, `ticket`/`role` (blank), `tags: [incident]` | Context, Related |

Every note gets every key from `fields`, plus `date`, `type` and `status`. A
field whose value is another memory's id becomes a link: for example,
`owner: "[[Ana Reyes]]"` and
`supersededBy: "[[Atlas will move to NATS JetStream instead of SQS]]"`.

Notes with a status get a top status line, as Write-Correctness Law 1 asks, for
example `**Status:** superseded — superseded by [[…]]`.

`## Related` lists outbound links and backlinks, because AGENTS.md prefers
bidirectional links.

The adapter also updates the index notes AGENTS.md says to maintain:

- in `work/Index.md`: Active Projects (with their open tasks), Incidents,
  Recently Completed and the Decisions Log table
- in `org/People & Context.md`: People

After writing, it runs the vault's own indexing, `qmd --index vault update`
then `qmd --index vault embed`. This is what the vault's PostToolUse and Stop
refresh worker runs after an agent writes a note.

Notes are written flat in `work/active/`. The hooks flag "loose notes that look
like one topic" and suggest a folder, but that is advisory: grouping is
`/om-tidy`'s job later. Grouping now would also hide tasks from SessionStart's
Open Tasks and Active Work, which read only the top of `work/active/`.

`reset()` deletes only the notes the adapter wrote, which it tracks in
`../.state/obsidian-written.json`, outside the vault. It restores the two index
notes from the vault's git HEAD, then runs `qmd update` and `qmd cleanup`. Any
other new note in the vault is reported and left in place.

## Ingest timings, 10-memory sample

`searchableMs` is the time from the end of the writes until the new note can be
found the way an agent finds it with a warm search path:

1. `qmd update`
2. `qmd embed`
3. the first `qmd search` hit for the last memory's title (BM25, no model load)

It does not include a cold CLI `qmd query`. A real agent queries through the
long-lived MCP server, whose models are already loaded, so it never pays that
cost. The cold query is still measured separately, as `phases.coldQuery`.

Each phase is reported in `phases`.

**Current definition** (final run):

| phase | ms |
|---|---|
| `write` (10 notes + 2 index notes) | 9 |
| `update` | 133 |
| `embed` | 3,550 |
| `firstHit` (`qmd search` found the note on the first probe) | 124 |
| **searchableMs** (update + embed + firstHit) | **3,807** |
| `coldQuery`, not in searchableMs | 12,246 |

**Earlier runs** used the old definition, which counted the cold CLI query:

| | run 1 | run 2 | run 3 |
|---|---|---|---|
| write | 9 | 15 | 9 |
| update | 126 | 134 | 129 |
| embed | 2,973 | 2,878 | 2,911 |
| cold `qmd query` | 10,350 | 10,013 | 9,578 |
| searchableMs (update + embed + cold query) | 13,449 | 13,025 | 12,618 |

All values are in ms.

**Why a cold CLI query takes about 10 s:** each `qmd query` process loads three
models, runs the 1.7B model to expand the query, then reranks. A repeated query
takes 1.4 s, because qmd caches expansions and rerank scores in its `llm_cache`
table.

**Through the MCP server,** which an agent uses with models kept loaded, the
first hybrid query took 5.8 s and later ones about 3.6 s.

## End-to-end check

Run with `node scripts/obsidian-verify.ts`. It resets, ingests
`data/sample.json`, then runs this from the vault:

```
env -u ANTHROPIC_API_KEY claude -p "Which queue is the Atlas project moving to, and why?" \
  --mcp-config <.state/obsidian.mcp.json> --strict-mcp-config \
  --allowedTools mcp__qmd__query,mcp__qmd__get,mcp__qmd__multi_get,mcp__qmd__status,Read,Grep,Glob \
  --output-format json --model claude-sonnet-5-5
```

**Result:** correct. The answer was "Atlas is moving to **NATS JetStream**, not
Amazon SQS", because SQS could not meet the ordering needs, and the SQS decision
is marked superseded. It took 4 turns and about 11 s.

**Tools used:** three `Read` calls (the project note and both decision notes)
and **no qmd call**. SessionStart's file listing named every note in this small
sample, so the agent read the right files directly.

In both runs the answer also said the archived load-test note "isn't in the
vault". That note is in `work/archive/2025/`, but SessionStart always folds the
archive into one count line, and the agent did not check with QMD or Glob.

**Implication for the full set:** with the full memory set, any folder with
more than 12 notes also folds into a count line, so the agent will have to
search.

## Files

- `adapters/obsidian.ts`: the adapter.
- `scripts/obsidian-up.sh`: pre-run check. It confirms qmd is at least 2.5.1,
  runs the vault's bootstrap if the index is missing, and prints `qmd status`.
  It takes 0.6 s.
- `scripts/obsidian-verify.ts`: the end-to-end check above.
- `vault/`: the vault. It is its own git repository, with origin set to the
  GitHub template. The only change from the template is
  `brain/North Star.md`.
- `.state/`: adapter state (`obsidian-written.json`) and the absolute-path MCP
  config (`obsidian.mcp.json`). This is the vault's `.mcp.json` with absolute
  paths.
