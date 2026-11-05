# memory-demo contract

A side-by-side demo: the same fake memories go into Substrate, an obsidian-mind
vault and Hindsight, then the same questions go to a Claude agent that can use
only one of the three systems. Everything here is local; nothing is pushed.

Node 24 runs the `.ts` files directly (type stripping), so there is no build
step. Shared types live in `src/types.ts`.

## The memory set (`data/memories.json`)

An array of `Memory` (see `src/types.ts`). One fictional company, Lumen Labs,
with people, projects, decisions, tasks and incidents. `data/sample.json` is a
small slice of the same shape for testing adapters.

- `kind` is one of `person`, `project`, `decision`, `task`, `incident`.
- `fields` holds the typed facts. Every value is a string, number, boolean or
  null. A decision that replaced an older one has `supersedes: "<id>"`, and the
  older one has `status: "superseded"` and `supersededBy: "<id>"`.
- `links` lists the ids this memory relates to (people, projects, decisions).

## Adapters (`adapters/<system>.ts`)

Each adapter exports a default object of type `MemoryAdapter`:

- `name`: `"substrate"`, `"obsidian"` or `"hindsight"`.
- `reset()`: empty the system so a run starts clean.
- `ingest(memories)`: store every memory through the system's normal write
  path, and resolve with `IngestReport` (how long it took, and how long until a
  just-written memory can be found by search).
- `agentSetup()`: what the agent runner needs to put Claude in front of this
  system: a working directory, an MCP config file path, the tools to allow, and
  optional extra system-prompt text that a real user of this system would have.

Fairness rules for adapters:
- Use the system's own normal write and search paths. No shortcuts that a
  real user of the system would not have.
- Never put the question set or its answers anywhere the agent can see.
- obsidian-mind keeps its own hooks, AGENTS.md and QMD search on.

## Questions (`data/questions.json`)

An array of `Question`. `category` is one of `lookup`, `changed`, `filter`,
`count`, `join`. Grading is deterministic: the answer passes when it contains
every `mustInclude` string and none of the `mustNotInclude` strings
(case-insensitive).

## Agent runs (`agent/ask.ts`)

`ask(adapter, question)` runs `claude -p` on the Claude subscription (no API
key) with the adapter's setup and returns an `AskResult`: the answer, each
tool call with its duration, the number of memory calls, tokens, and wall time.
