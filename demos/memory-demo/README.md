# Agent memory, side by side: Substrate, obsidian-mind and Hindsight

The same memories go into three agent-memory systems:

- **Substrate:** a typed store with hybrid recall (this repository).
- **[obsidian-mind](https://github.com/breferrari/obsidian-mind):** an Obsidian vault with hooks and QMD hybrid search.
- **[Hindsight](https://github.com/vectorize-io/hindsight):** a memory server whose LLM extracts facts as it stores them.

The same questions then go to a Claude agent that can use only one of the three. Everything runs locally.

## Run the demo

```bash
scripts/demo-up.sh           # starts all three, warms their search, opens http://localhost:4600
```

Or start each system on its own:

```bash
scripts/substrate-up.sh      # Postgres with pgvector on :5441 and Substrate on :3100
scripts/obsidian-up.sh       # QMD health check for the vault
scripts/hindsight-up.sh      # Hindsight on :8888, its LLM on the Claude subscription
node web/server.ts           # http://localhost:4600
```

The page has five tabs. Keys 1 to 5 switch them, and every ⓘ explains its section.

- **Ask:** one question to all three systems at once. Each pane streams the agent's memory lookups with their timings, then its answer, and grades the answer when the question comes from the prepared set. Every lookup opens to show what was asked and what came back.
- **Ingest:** the same memory set into all three, timed.
- **Scoreboard:** the recorded runs, every question three times for each system.
- **Shared memory:**
  - a live change that writes one decision into all three systems and puts it back;
  - a recorded scene in which one agent changes a decision on machine A and another agent on machine B is asked about it.
- **Setup:** what it took to stand each system up.

## Set up from a fresh clone

1. **Prerequisites:**
   - Docker;
   - Ollama with `bge-m3` (`ollama pull bge-m3`);
   - mise and uv;
   - Claude Code signed in to a Claude subscription (the runner removes `ANTHROPIC_API_KEY`, so no API key is used);
   - QMD (`npm install -g @tobilu/qmd`).
2. **Substrate:** a built checkout of `mnmal-ai/substrate` (`mise install && pnpm install && pnpm build` in it).
   - `scripts/substrate-up.sh` reads it from `SUBSTRATE_SRC`, which defaults to `~/Developer/mnmal-ai/memory-demo-src/substrate`.
   - When this folder sits inside the substrate repo at `demos/memory-demo`, use the repo itself: `SUBSTRATE_SRC=$(git rev-parse --show-toplevel) scripts/demo-up.sh`.
   - The `lumen` types come from `adapters/substrate-plugin/`. Steps and timings are in `adapters/SUBSTRATE.md`.
3. **obsidian-mind:**
   - Clone the template into `vault/` here: `git clone https://github.com/breferrari/obsidian-mind.git vault`.
   - Fill in `vault/brain/North Star.md`.
   - Run `scripts/obsidian-up.sh`, which builds QMD's index. The first search downloads about 2.6 GB of local models.
   - Steps and timings are in `adapters/OBSIDIAN.md`.
4. **Hindsight:** `scripts/hindsight-up.sh` installs `hindsight-api` into `run/hindsight/.venv` on first run, about 2 GB. Steps, timings and its LLM costs are in `adapters/HINDSIGHT.md`.
5. **Run it:** `scripts/demo-up.sh`. On first run it loads the base set into Substrate and obsidian-mind, which takes about a minute. Hindsight is loaded on its own, `node eval/ingest.ts --only hindsight`, because its LLM reads every memory: 10 to 15 minutes and about 5 million tokens of subscription use.

- **Committed:** `data/` (deterministic; `node data/generate.ts` rebuilds it) and the recorded runs in `results/`.
- **Local and ignored:** `vault/`, `run/` and `.state/`.

## Reproduce the numbers

```bash
node data/generate.ts                                              # 253 memories + 23 questions (deterministic)
node eval/ingest.ts                                                # the same memories into all three, timed
node eval/shared.ts                                                # the shared-memory scene
node eval/run.ts --trials 3 --sequential --tag three-3x            # every question, tools loaded up front
node eval/run.ts --trials 3 --sequential --defaults --tag defaults-3x   # the same, on Claude Code's defaults
node eval/rerun.ts results/three-3x.json                           # re-ask answers the machine spoiled
```

`--sequential` asks one system at a time, in an order that rotates from question to question, so the systems don't compete for the machine. `eval/rerun.ts` re-asks only answers that failed to reach the Claude API, plus, with `--over-ms`, answers that ran past a time limit during a run in which the machine slept. It lists each one it replaced in the run's `reruns`. On an awake machine a slow answer is a real result and stays.

## How the comparison is kept fair

- **Same memories,** through each system's own normal write path (`adapters/`).
- **Same agent:**
  - the same model (`claude-sonnet-5-5`, on the Claude subscription), the same question text and the same tool limits;
  - the runner loads only project settings (`--setting-sources project,local`), so obsidian-mind's own hooks run and the demo machine's personal ones don't.
- **Same output limit:** Claude Code's MCP output limit is raised for every agent. A large result stays in the answer instead of being saved to a file that an agent without file tools could not read.
- **Each system at its best:**
  - obsidian-mind keeps its template, hooks, AGENTS.md and rules, QMD with its local models, and Read, Grep and Glob over the vault;
  - Substrate's agent gets Substrate's interaction conventions (from the cortext plugin);
  - Hindsight's agent gets its bank's read tools: recall, reflect, and listing and reading memories and documents.
- **Two configurations:**
  - Claude Code's defaults, where MCP tools are found through tool search and each agent has only its system's own orientation;
  - tools loaded up front, with a short live overview of Substrate's types.
- **No peeking:** any run that touches the question set, the answer key or the demo's code is discarded and counted as wrong (`agent/ask.ts`).
- **Mechanical grading:**
  - answers are checked against an answer key derived from the data;
  - case and punctuation are ignored, so a note's filename or a record's key counts as the name;
  - counts are graded on the last number in the answer;
  - exact titles are the rule. Each result also records whether it named the right items in other words (`passedIgnoringWording`), and the scoreboard reports those misses separately.
- **Hindsight's own LLM is counted:** the tokens Hindsight's LLM spends while answering (its reflect tool) are recorded as `memoryLlmTokens`, separately from the agent's.

## What's where

- `data/`: the generator, the memory sets and the questions with their answer keys.
- `adapters/`: one file per system, plus setup notes (`SUBSTRATE.md`, `OBSIDIAN.md`, `HINDSIGHT.md`), the Substrate plugin and the conventions its agent gets.
- `agent/ask.ts`: runs one question against one system and measures it.
- `eval/`: ingest, the full run, re-asking spoiled answers, re-grading, the shared-memory scene, and the live change on the Shared page (`node eval/change.ts apply | undo | status`).
- `results/`: every recorded run.
- `web/`: the demo page, in the Axon design system (`web/axon/` is Axon's built CSS, copied from mnmal-ai/axon). Pages morph into each other with the View Transitions API.
- `docs/`: the sequence diagram of how Substrate writes and answers, as Mermaid source and a PNG; http://localhost:4600/how renders the source.
- `TALKING-POINTS.md`: what to say, with the numbers.
