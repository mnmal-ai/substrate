# Substrate setup for the memory demo

What it took to run Substrate from source on this Mac (macOS 27, Apple silicon) and put a Claude agent in front of it. Every step was timed. The install below ran on 2026-10-22 against `mnmal-ai/substrate` `main` at `4405a78` (v1.0.0-alpha.2), cloned depth 1. The demo was then updated to `43ffd3c` (v1.0.0-alpha.5): `git checkout`, `pnpm install` (no dependency changes) and `pnpm build` (4 s). Every recorded run is on alpha.5.

## Commands

```bash
scripts/substrate-up.sh             # Postgres + Substrate in the background, waits for health (about 3 s)
node scripts/substrate-verify.ts    # reset, ingest data/sample.json, ask claude -p one question
node agent/ask.ts substrate "Which queue is the Atlas project moving to, and why?"
scripts/substrate-down.sh           # stops only what substrate-up started; --purge also drops the volume
```

- The source checkout is `SUBSTRATE_SRC` (default `~/Developer/mnmal-ai/memory-demo-src/substrate`). Inside the substrate repo, use the repo itself: `SUBSTRATE_SRC=$(git rev-parse --show-toplevel)`.
- Postgres runs in the container `memory-demo-substrate-pg` (`pgvector/pgvector:pg17`) on `127.0.0.1:5441`, with its data in the volume `memory-demo-substrate-pgdata`.
- Substrate listens on `127.0.0.1:3100`, with auth off and the system actor `memory-demo`. Its log is `run/substrate/server.log`.
- Embeddings come from Ollama at `127.0.0.1:11434`, using `bge-m3`. `SUBSTRATE_DEMO_EMBED_MODEL=nomic-embed-text` switches models; run `--purge` first.

## Setup steps, timed

Machine time for a source install came to about a minute and a half. No registry token is needed: every package comes from the public npm registry.

| # | Step | Time | Downloaded or installed |
|---|------|------|-------------------------|
| 0 | Prerequisites already on the machine: git, Docker, mise, Ollama with `bge-m3` | — | — |
| 1 | `mise trust` (a new checkout's `mise.toml`) | <1 s | — |
| 2 | `mise install` | 7 s | pnpm 12.14.0. Node `latest` resolved to 26.10.0, which was already installed; a fresh machine would download it too. |
| 3 | `pnpm install --frozen-lockfile` | 71 s | 520 MB `node_modules`, all from npmjs.org |
| 4 | `pnpm build` | 8 s | 23 turbo tasks |
| 5 | Postgres with pgvector (`docker run`, inside `substrate-up.sh`) | ~1 s to healthy | `pgvector/pgvector:pg17` was already cached, so no pull was timed |
| 6 | **Write a plugin** declaring the `lumen` types (`adapters/substrate-plugin/`, about 120 lines of JS) | authoring, not machine time | — |
| 7 | Build the plugin install root: symlink `@mnmal-ai/substrate` (which carries recall) and the lumen plugin, list both in its `package.json`, write `substrate-recall.config.json` (inside `substrate-up.sh`) | <0.1 s | — |
| 8 | `substrate serve` (inside `substrate-up.sh`): runs the core schema migrations and recall's three on first boot | ~1 s | — |
| 9 | Write the MCP config for `substrate mcp` (stdio, `SUBSTRATE_URL`, `SUBSTRATE_MCP_TOOLS=schema,query,recall`) | — | — |

`substrate-up.sh` takes about 3 s cold (new container, first-boot migrations).

## How the data maps

Each memory becomes a row of its type in the `lumen` namespace (`lumen/Person`, `lumen/Project`, `lumen/Decision`, `lumen/Task`, `lumen/Incident`):

- `key` is the memory's id; `title`, `body` and `date` are fields of the same name; `links` is a list of keys.
- Every other field keeps the memory's own value, so `owner` reads `person-ana-reyes`.
- Each reference also gets a crossRef (`ownerRef`, `projectRef`, `supersedesRef`, `supersededByRef`) holding the target row's id: a first-class edge.
- Recall embeds a row's title, body, date and facts, with each linked row's title added, so "Ana Reyes" matches rows she owns.

Writes go through autoCRUD mutations on `POST /substrate/v1/mutate`, batched 50 rows to a request and 4 requests at a time. Every write embeds its row through Ollama before it returns, so a row is searchable as soon as its write commits.

## What the agent gets

- **Tools:** the three read tools of Substrate's MCP server, `schema`, `query` and `recall`. No write tools, and no Read, Glob or Grep.
- **Instructions:** the Substrate interaction conventions that ship with Substrate's agent tooling (the cortext plugin's fragment, from `mnmal-ai/synoptic` v1.0.0-alpha.4, copied to `adapters/substrate-conventions.md`). It is cut before the mailbox, identity and context-store sections, which this deployment does not run, plus the context-store section's note on how recall hits read, since it describes the recall tool itself.
- **Orientation:** an overview of the `lumen` types and fields, read live from the server, as obsidian-mind's session-start hook gives its agent the vault's shape. The Claude Code defaults run leaves this out.

## The end-to-end check

`node scripts/substrate-verify.ts data/sample.json`, on alpha.5:
- reset in 435 ms;
- 10 memories stored in 2.3 s and searchable 161 ms later;
- the agent answered which queue Atlas is moving to, and why, in two Substrate calls (a typed query for the project, then a recall over decisions asking for their fields), with no other tools and no API key.

Loading the 253-memory base set takes 29.8 s until searchable on alpha.5 (42.2 s on alpha.2).

## What to know

1. **The plugin's contract range.** A plugin declares which Substrate versions it supports. Substrate's versions start at 1.0.0-alpha, so the plugin declares `>=1.0.0-alpha.0 <2.0.0`; a range the binary does not satisfy is refused at boot.
2. **The plugin directory needs a `package.json`.** Substrate loads only the packages listed under `dependencies` in `<SUBSTRATE_PLUGIN_DIR>/package.json`. Without that file neither the lumen plugin nor recall loads.
3. **A slow embedding can be dropped silently.** A write whose embedding takes longer than `writeEmbedTimeoutMs` (default 30 s) commits the row with no vector and no error. `substrate-up.sh` raises it to 120 s.
4. **`schema` with no arguments is large.** It returns the whole federated schema, 60 KB, more than Claude Code shows inline by default; Claude Code saves it to a file instead, which an agent without file tools cannot read. The demo raises Claude Code's MCP output limit for every agent, and the type overview means the agent rarely needs the full schema.
5. **The onboarding document is for programs.** `GET /substrate/v1/onboard` returns 23 KB of JSON describing the frame grammar and the installed plugins. The agent's instructions come from the conventions fragment instead.
6. **Write concurrency stays at 4.** An earlier release exhausted its Postgres pool at 8 parallel batched writes; 4 completes every time and was not raised.
7. **Recall returns handles unless asked.** Since v1.0.0-alpha.4 a recall hit carries `id` and its handle fields (`name`, `title`, `topic`, `synopsis`, `description`); `rowFields` asks for more (`{ "key": true }`, or `true` for the whole row). The adapter's searchability check asks for the key. The agent asked for fields in 20 of its 20 recalls with tools loaded up front.
