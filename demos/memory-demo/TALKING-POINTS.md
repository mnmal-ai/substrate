# Talking points: why Substrate for agent memory

## The one line

obsidian-mind stores memory as notes and finds it by searching. Hindsight stores memory as facts its LLM extracts, and finds them by searching. Substrate stores memory as typed records and answers questions about them. All three got nearly every fact right at this size. Substrate gets there with the fewest lookups, the least time and the least context, its writes are the cheapest, and a change made by one agent reaches every other agent at once.

## How it was kept fair

- **Recorded on Substrate v1.0.0-alpha.5,** built from source, with Hindsight 1.1.0 and the obsidian-mind template as of October 2026.
- **Same memories:** 253 made-up memories about Lumen Labs (24 people, 10 projects, their decisions, tasks and incidents), written into each system through its own normal write path.
- **Same agent:** Claude Code with Sonnet 5.5 on the Claude subscription, the same question text and the same tool limits (no shell, no web, no file edits). Each agent sees only its own memory.
- **One system at a time:** each question goes to one system at a time, in an order that rotates from question to question, on an awake and quiet Mac (the load was logged every minute).
- **Each system at its best:**
  - obsidian-mind keeps its template, hooks, AGENTS.md and rules, QMD hybrid search on local models, and Read, Grep and Glob over the vault;
  - Substrate's agent gets Substrate's own interaction conventions;
  - Hindsight's agent gets its bank's read tools, including reflect, which has Hindsight's own LLM write an answer.
- **Same output limit:** Claude Code's MCP output limit is raised for every agent, so a large result stays in the answer instead of spilling to a file an agent without file tools can't open.
- **Graded mechanically** against an answer key derived from the data. Exact titles are the rule; misses that named the right items in other words are reported separately. Any run that peeks at the answer key counts as wrong.
- **23 questions in five types:**
  - lookup: one fact;
  - changed: a decision that was replaced;
  - filter: a list picked by exact fields;
  - count: a total;
  - join: several memories combined.
- **Two configurations, each question three times:**
  - **Claude Code's defaults:** tools are found through tool search, and each agent starts with only its system's own orientation;
  - **tools loaded up front:** every agent gets its tools at the start, and Substrate's agent also gets a short overview of its types.

## How Substrate works

**Figure 1** (insert `docs/substrate-sequence.png` here): one write and one question, every call numbered in order. While the demo runs, the same diagram is at http://localhost:4600/how.

**Writing a memory (calls 1 to 7)**

- **1.** A write is a typed mutation, "create a Decision", carrying its fields (title, choice, status, owner, project) and its links.
- **2.** The server checks every field against the Decision type the schema declares, rejects any field it doesn't know, and inserts the row in Postgres.
- **3 to 6.** Before the write returns, the server:
  - updates the keyword (full-text) index;
  - sends the row's text to Ollama for an embedding, a vector of 1,024 numbers from the local bge-m3 model;
  - stores the vector in Postgres with pgvector.
- **7.** So a memory is searchable the moment its write returns. There is no separate indexing step to run or wait for, and no LLM in the write path.

**Answering a question (calls 8 to 24)**

- **8 to 10.** The demo reads Substrate's schema and starts a Claude Code session with the question, Substrate's three read tools and a short overview of the types.
- **11.** Claude Code starts Substrate's MCP server for the session. Each of its tools is a thin proxy to the server's HTTP API.
- **12 and 13.** The model (Sonnet 5.5, the only piece not on this Mac) decides to call the recall tool.
- **14 to 20.** Recall embeds the question through Ollama, runs a vector search and a keyword search in Postgres, and fuses the two rankings (reciprocal rank fusion). Each row comes back with every field.
- **21 to 24.** The model sees three decisions, one active and two marked as replaced, and answers "ClickHouse". The demo streams the answer and every call to the page.
- **Filter, count and join questions** call the query tool instead. One typed query (for example, Tasks where owner is Ben Okafor and status is open) is answered by Postgres alone, with no embedding. That is where the gap in lookups comes from.

**What runs where**

| Piece | Where | What it does |
|---|---|---|
| Demo page and server | This Mac, port 4600 | Asks the systems, streams their calls, grades the answers |
| Claude Code | This Mac | The agent session, one per question |
| Claude model (Sonnet 5.5) | Anthropic, on the Claude subscription | The agent's model, the same for all three systems |
| Substrate MCP | This Mac, one per session | Gives the agent `schema`, `query` and `recall` |
| Substrate server | This Mac, 127.0.0.1:3100 | Typed reads and writes, and recall |
| Ollama with bge-m3 | This Mac | Substrate's embeddings, for every write and every recall question |
| Postgres with pgvector | This Mac, in Docker, 127.0.0.1:5441 | The rows, the keyword index and the vectors |

**The other two, for contrast**

- **obsidian-mind:**
  - Its memory is markdown files in a vault folder.
  - Its agent reads them with Claude Code's own Read, Grep and Glob, or searches through QMD, which runs three local models (query expansion, embedding and reranking) over a SQLite index.
  - A write is a new file. Grep sees it at once; QMD's search sees it only after the vault is re-indexed.
  - Each machine keeps its own index, and sharing goes through git.
- **Hindsight:**
  - A memory server on this Mac (127.0.0.1:8888, embedded Postgres).
  - Every write goes through an LLM, here Sonnet 5.5 on the Claude subscription, which extracts facts, entities and relationships.
  - It embeds them locally and consolidates observations in the background.
  - Its reflect tool has that LLM write an answer.

## Claim 1: more performant

Lead with the run on Claude Code's defaults, the conservative one:

| Claude Code defaults | obsidian-mind | Substrate | Hindsight |
|---|---|---|---|
| Answers correct | 99% | 100% | 96% |
| Time to answer | 10.6 s | **9.5 s** | 21.8 s |
| Memory lookups per answer | 4.9 | **2.6** | **2.6** |
| Time inside lookups | 812 ms | **163 ms** | 14.0 s |
| Tokens in per answer | 125k | 114k | 74k, plus 79k of Hindsight's own LLM |

Then the run with tools loaded up front:

| Tools loaded up front | obsidian-mind | Substrate | Hindsight |
|---|---|---|---|
| Answers correct | 100% | 100% | 94% |
| Time to answer | 17.6 s | **6.6 s** | 16.2 s |
| Memory lookups per answer | 4.2 | **1.4** | 3.2 |
| Time inside lookups | 3.6 s | **122 ms** | 7.0 s |
| Tokens in per answer | 186k | **77k** | 127k, plus 19k of Hindsight's own LLM |

- **Substrate is flat across question types.** With tools up front it answered every type in 6 to 8 s, with 1.1 to 1.6 lookups. Joins took obsidian-mind 9.3 lookups and 284k tokens, and Hindsight 6.9 lookups and 194k; Substrate took 1.6 lookups and 87k.
- **Accuracy is close; say so first.** Substrate answered every question correctly in both runs, and obsidian-mind missed one join. Hindsight missed 3 and 4 of 69. Of those, 1 of 3 and 2 of 4 named the right tasks or decisions with reworded titles ("for **the** Ledger billing pipeline"), because Hindsight stores facts its LLM rewrote. Exact titles are the rule, since an agent acting on a record needs its real name.
- **Be candid about the defaults run.** On Claude Code's defaults, Substrate's agent doesn't know the types. It fetched Substrate's full schema (about 60 KB) before every answer, after looking up its tools through tool search, so its lead on time is narrow: 9.5 s against obsidian-mind's 10.6 s. It still made about half the lookups. Given a short overview of the types at session start (what obsidian-mind's hooks do for its vault), it never fetched the schema and answered in 6.6 s.
- **Hindsight's answers cost a second LLM.** When its agent calls reflect, Hindsight's own LLM writes an answer: on average 79k extra tokens per answer on the defaults run. Those don't show in the agent's tokens in, so the page reports them separately.

## Claim 2: cheaper to keep up to date

| Loading 253 memories | obsidian-mind | Substrate | Hindsight |
|---|---|---|---|
| Until all are searchable | 34.6 s | **29.8 s** | 306.7 s |
| Background work afterwards | — | — | 217 s of consolidation |
| LLM tokens to store them | none | none | 4.3M input tokens |

- **Substrate writes with no LLM.** Each write embeds its row locally and is searchable the moment it returns. Hindsight runs an LLM over every memory it stores, about 17,000 input tokens per memory here, and keeps consolidating afterwards.
- **obsidian-mind writes files in milliseconds,** then re-indexes the whole vault; its search sees nothing new until that finishes.
- **Changing one decision** (Shared tab): Substrate 0.61 s, Hindsight 5.3 s, obsidian-mind 10.5 s.

## Claim 3: one memory for many agents

A teammate's agent on machine A records that Atlas moves to Apache Kafka. A different agent on machine B is then asked what Atlas is moving to.

- **Substrate is one server:** two writes in 0.61 s, and machine B's agent answered "Apache Kafka" straight away, with nothing to sync.
- **Hindsight is one server too:** machine B's agent had the new answer straight away.
  - Its write took 5.3 s, because its LLM re-reads the memories.
  - Undoing a change is harder: observations built from a deleted memory survive it, so putting a change back means rebuilding the bank's observations (4 to 6 minutes and about a million LLM tokens here).
- **obsidian-mind shares through git:**
  - Machine A took 10.5 s to write, re-index and commit.
  - Machine B's agent answered "NATS JetStream", the old decision, with no sign it was stale.
  - It answered "Apache Kafka" only after a git pull and a re-index.

## Where the others hold their own (say it out loud)

- **Accuracy at this size:** obsidian-mind matched Substrate on all but one of 138 answers.
- **Hindsight on single facts:** it answered every lookup and changed-fact question correctly, and it needs no schema: store text, ask questions.
- **Install:** obsidian-mind is a template and a search tool (about 10 minutes, mostly model downloads); Hindsight is one pip package. Substrate needs a short plugin declaring the types before it can store anything, which is also why it can answer typed questions.
- **People can read obsidian-mind's memory.** A vault is markdown a person can open, edit and diff in git.
- **No server to run with obsidian-mind.**

## Questions to expect

- **"Isn't the test rigged toward Substrate?"** It includes lookups and changed facts, where all three did well, and the defaults run, where Substrate's lead on time is narrow. The questions and the answer key are in the repo; change them and re-run.
- **"Couldn't the vault agent just grep?"** It does, mostly. Grep is fast per call; the cost is the number of calls and the notes read into context.
- **"Why is Substrate's lead narrow on Claude Code's defaults?"** Its agent fetches the full schema first, every time. A short type overview at session start removes that: 6.6 s instead of 9.5 s. That overview is what Substrate's agent tooling should provide.
- **"Why does Hindsight miss more?"** Some of its misses (1 of 3 on the defaults run, 2 of 4 on the other) named the right items in reworded titles: its LLM rewrites what it stores, so exact names are lost. The rest were real misses.
- **"What does it cost to run?"** Substrate is a Node server and Postgres with pgvector, with embeddings through Ollama. Hindsight needs an LLM for every write; here it ran on the Claude subscription, otherwise it is metered. obsidian-mind runs its models locally.
- **"Lock-in?"** Substrate's data is rows in Postgres; obsidian-mind's is markdown files; Hindsight's is its own Postgres schema of extracted facts.

## What we found along the way (for the room, not the pitch)

**Substrate**
1. The `schema` tool with no arguments returns the whole federated schema, about 60 KB, more than Claude Code shows inline by default. An agent without a type overview fetches it on every question.
2. `GET /substrate/v1/onboard` is 23 KB of JSON for programs; the agent-facing instructions live in the cortext plugin's conventions fragment.
3. A write whose embedding takes longer than `writeEmbedTimeoutMs` (default 30 s) commits the row with no vector and no error.
4. The plugin directory needs a `package.json` listing its plugins, or neither the plugin nor recall loads.

**Hindsight**
1. Deleting a document leaves the observations already consolidated from it, so a deleted fact can still surface.
2. Its LLM rewrites stored text, so exact titles and names are lost.
3. By default the server binds to every interface and names its worker after the machine's hostname.

## The live demo: run sheet (about 15 minutes)

### Before the meeting

1. With Docker Desktop running, run `scripts/demo-up.sh` in the demo folder. It:
   - starts all three systems;
   - checks Substrate and obsidian-mind hold the 253-memory base set;
   - says whether Hindsight needs loading (`node eval/ingest.ts --only hindsight`, 10 to 15 minutes);
   - pins Substrate's embedding model in Ollama and warms every search path;
   - opens http://localhost:4600.
2. What leaves the Mac:
   - Substrate and obsidian-mind run entirely on this Mac.
   - Hindsight runs here too, but its LLM is Claude on the subscription.
   - Every agent's model is Claude.
3. Make the window large. Keys **1 to 5** switch pages. Every ⓘ explains its section, and every lookup in the Ask panes opens to show what the agent asked and what came back.

Live answers run with tools loaded up front, so expect numbers near the second table. They vary from ask to ask; the recorded runs are the evidence, the live asks are the illustration.

### Step 0: open (about 1 minute, no clicking)

**Say:** the one line above. Then the fairness in one breath:
- the same 253 memories in all three;
- the same model and questions, one system at a time;
- each agent sees only its own memory;
- answers are graded against an answer key.

### Step 1: a lookup, the honest baseline

**Do:** press **1** (Ask). In the question menu pick **"[lookup] Who owns the Harbor container platform project?"** and click **Ask all three**.

**Expect:** all three answer **Ana Reyes**, all Correct.

**Say:** "A single fact by name is what search is good at. All three do it well."

### Step 2: a changed fact

**Do:** pick **"[changed] What is the current storage engine for Ledger billing pipeline?"** and click **Ask all three**.

**Expect:** all three answer **ClickHouse**.

**Show:** open the lookup rows:
- obsidian-mind reads the Redshift, BigQuery and ClickHouse notes in turn;
- Substrate's one search returns the decisions, each marked active or replaced;
- Hindsight returns the facts its LLM extracted.

**Say:** "The engine changed twice and the old decisions read almost the same. In Substrate, 'current' is a field."

### Step 3: a count

**Do:** pick **"[count] How many open tasks does Ben Okafor own?"** and click **Ask all three**.

**Expect:** all three answer **3** (5 is also accepted: "open" can mean status open or not done yet). Substrate does it in one typed query; watch the other two list and read.

### Step 4: a join, the widest gap

**Do:** pick **"[join] Which Data team members own an unfinished task on a project that belongs to a different team?"** and click **Ask all three**.

**Expect:** **Ben Okafor** and **Farah Haddad**. Recorded, with tools up front:

| | obsidian-mind | Substrate | Hindsight |
|---|---|---|---|
| Lookups | 9.3 | 1.6 | 6.9 |
| Time | 21 s | 8 s | 28 s |
| Tokens in | 284k | 87k | 194k |

**Say:** "Three hops: person to team, task to project, project to team. Search finds notes and facts but can't join them; Substrate's typed query can."

### Step 5: the scoreboard

**Do:** press **3**. The menu shows **"253 memories · Claude Code defaults"**.

**Say:**
- "This is the conservative run. Everyone is close on accuracy."
- "Substrate and Hindsight make about half obsidian-mind's lookups."
- "On time, Substrate leads only narrowly here, 9.5 s against 10.6 s, because on Claude Code's defaults its agent fetches the full schema first."

**Then:** switch the menu to **"tools loaded up front, Substrate type overview"**.

**Say:** "Give Substrate's agent a short overview of its types, the way obsidian-mind's hooks describe the vault, and it answers in 6.6 s, with 1.4 lookups and 77k tokens. The others take more than twice as long."

Point at the rewording line under the numbers: "Most of Hindsight's misses were the right items with reworded titles."

### Step 6: one memory for many agents

**Do:** press **4** (Shared). Click **Make the change**.

**Expect:** Substrate finishes in about half a second, Hindsight in about 5 to 20 s (its LLM re-reads the memories), obsidian-mind in about 10 to 25 s (note, re-index, commit).

**Do:** press **1**, pick **"[changed] What is the current target queue for Atlas queue migration?"** and click **Ask all three**.

**Expect:** all three answer **Apache Kafka** on this one machine, graded against the new answer.

**Say:** "On one machine everyone keeps up. What matters for a team is a second machine." Press **4** and point to the recorded scene: obsidian-mind's machine B answered with the old decision until someone pulled and re-indexed; Substrate and Hindsight had the new one at once.

**Then:** click **Put it back** after the meeting, not during it. Substrate and obsidian-mind are back in seconds, but Hindsight rebuilds its observations, which takes 4 to 6 minutes.

### Step 7: ingest and setup, the candid part

**Do:** press **2** (Ingest). Don't click Ingest into all three: it resets the systems and Hindsight's load takes 10 minutes. The bars are the recorded run.

**Say:** "Substrate stores 253 memories in about 30 s with no LLM; obsidian-mind writes files and re-indexes in about 35 s; Hindsight's LLM reads every memory, 5 minutes and 4.3 million tokens."

**Do:** press **5** (Setup).

**Say:**
- "obsidian-mind is the simplest install."
- "Hindsight is one package."
- "Substrate needs a short plugin declaring the types. That plugin is also why it can answer typed questions in one query."

### Close

The one line again, then what you want from the room.

### If something goes wrong

- **A pane shows an error, or runs past 90 s:** refresh the page (it remembers the tab) and ask again, or go straight to the Scoreboard: the recorded runs carry the argument.
- **A live answer comes back Wrong:** say so. Live asks vary; the recorded runs are 69 answers per system in each configuration.
- **A pane fails to connect:** run `scripts/demo-up.sh` again (it restarts only what is down).
- **The page won't load:** `node web/server.ts` in the demo folder.
- **Make the change fails partway:** click **Put it back**; it undoes whatever was done. From a terminal: `node eval/change.ts undo`.

### After

`node eval/change.ts undo` if a live change is still made. `ollama stop bge-m3` releases the pinned model. Then:
- `scripts/substrate-down.sh` stops Substrate and its Postgres; the data stays;
- `scripts/hindsight-down.sh` stops Hindsight.

## Reproduce

```bash
scripts/demo-up.sh                                                    # all three systems, base set, the page
node eval/ingest.ts                                                   # the same memories into all three, timed
node eval/shared.ts                                                   # the shared-memory scene
node eval/run.ts --trials 3 --sequential --defaults --tag defaults-3x # every question, Claude Code's defaults
node eval/run.ts --trials 3 --sequential --tag three-3x               # every question, tools loaded up front
```
