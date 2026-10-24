# substrate-recall

Built-in kernel plugin for semantic recall: embeddings in pgvector, a keyword (lexical) arm, and Reciprocal Rank Fusion of the two.

## What it provides

- **`embeddings` and `lexical` tables** (pgvector with an HNSW cosine index; a generated `tsvector`), created by the plugin's migrations
- **Embedding post-writes**: every type that declares `embed.source` is embedded on write; types declaring `lexical.source` are indexed for keyword search
- **`embeddingSimilar` filter operator**: `where: { embeddingSimilar: { to: "..." } }` on any embedded type
- **`POST /substrate/v1/recall`** and the **`recall/Hit`** frame type (via `POST /substrate/v1/query`)
- **`recall` MCP tool**
- **`POST /substrate/v1/embeddings/fetch`**: raw vectors for refs the caller already knows
- **`POST /substrate/v1/salience/boost`**: explicit reinforcement of rows a caller used (see *Salience*)
- **`POST /substrate/v1/crystallise`**: cluster embedded rows into durable `recall/Cluster` rows (see *Crystallisation*)
- **`GET /substrate/v1/embed-stats`**, and the admin routes **`POST /substrate/v1/embed/reindex`** and **`POST /substrate/v1/lexical/reindex`**
- **`embedAndStore`**: an exported primitive for wiring an embedding post-write by hand

[`docs/surface-parity.md`](../../docs/surface-parity.md) §3 describes the recall request and response shapes across surfaces, including what `score` and `arms` mean.

## Activation

Recall is built into `@mnmal-ai/substrate`: it loads whenever the binary sits in `SUBSTRATE_PLUGIN_DIR`, and there is nothing to install. It is a kernel plugin, so it composes before any coordinator. Configure the embedder in `<SUBSTRATE_PLUGIN_DIR>/substrate-recall.config.json`; `substrate init --embedder=…` writes one for you.

With no embedder configured (`embedder.kind: "off"`, the default), recall still answers from the lexical arm.

## Configuration

`config.schema.json` is the authoritative list. The usual knobs:

- `embedder.kind`: `"onnx"` (in-process, needs `fastembed` installed), `"ollama"`, `"fake"` (tests) or `"off"`.
- `embedder.model` and `embedder.dimension`: for example `all-MiniLM-L6-v2` / `384` on onnx, or any Ollama embedding model and its dimension.
- `embedder.baseUrl`: Ollama server URL (`ollama` only; required).
- `embedder.cacheDir`: where `onnx` downloads models. Use an absolute path.
- `embedder.timeoutMs`: per-request timeout for write and reindex embeds (`ollama`; default `120000`).
- `embedder.contextLength`: tokens sent to Ollama as `num_ctx` and `num_batch`. Default: the model's own, read from Ollama's `/api/show`.
- `queryEmbedTimeoutMs`: timeout for embedding a recall or `embeddingSimilar` query, so a stalled embedder answers 503 instead of holding the caller (default `30000`).
- `writeEmbedTimeoutMs`: timeout for the embed that follows a write. The write has already committed, but its reply waits for the embed, so this bounds how long a slow embedder can hold it. A failed or timed-out embed leaves the row with no vector or its previous one, and the backfill below repairs it (default `30000`).
- `embedBackfillIntervalMs`: how often to re-embed rows whose vector is missing or older than the row, which is what a failed or timed-out write-path embed leaves. Each pass re-reads the current row, takes up to 50 rows per embedded type in id order, and stops when the embedder reports itself unavailable. Postgres stores only; `0` disables (default `60000`).
- `hnswM`, `hnswEfConstruction`: HNSW build parameters (defaults 16 and 64).

Pick the model before you have data: changing it means re-embedding every row (`POST /substrate/v1/embed/reindex`).

## Plugin authors

Declaring `embed.source` on a type is normally all you need; the plugin finds it. To wire a post-write yourself:

```ts
import { embedAndStore, type EmbedAndStoreOptions } from '@mnmal-ai/substrate/recall';

const postWrite = async (row) => {
  await embedAndStore(row, {
    namespace: 'myns',
    type: 'MyType',
    fields: ['title', 'body'],          // simple case: concatenate string fields
    // or: serializeRow: (r) => `${r.title}\n${r.body}`,
    embedder,                           // an Embedder (type exported by @mnmal-ai/substrate/recall)
    store                               // an EmbeddingsStore
  });
};
```

## Salience

Every embedded row carries a `salience` float: an attention signal that decays exponentially and is bumped whenever the row is read. Recall can blend it into ranking (`salience.weight > 0`, off by default) so rows that keep proving useful drift upwards.

Three routes touch it, and the split between them is about reach, not verb:

| route | capability | what it may reinforce |
|---|---|---|
| `POST /substrate/v1/recall` | `read` | the rows it just returned |
| `POST /substrate/v1/embeddings/fetch` | `read` | the rows it just returned |
| `POST /substrate/v1/salience/boost` | `mutate` | any target the caller names |

The two read routes reinforce automatically and fire-and-forget, so the `_salience` they report is the value *before* that call. Both accept `boost: false` to run read-only, for a consumer that would rather reinforce what it **used** than what it **retrieved**, by calling the boost route once it knows. Only the boost route lets a caller name rows it never read, which is why it alone is gated `mutate`.

Every read path reinforces, deliberately: a ranking signal that learns from reads stays at zero for any type that is only ever read through a path that does not feed it.

## Crystallisation

`POST /substrate/v1/crystallise` clusters embedded rows into first-class `recall/Cluster` + `recall/ClusterMember` rows with provenance, turning vector similarity into durable, addressable identity. It uses the same read-policy check as recall, fetch and boost, and is mutually exclusive with itself: a second call while one is in flight is refused with 409 rather than queued, because two concurrent passes over the same unclaimed rows would form duplicate clusters.

**The selection filter (`select`) is mandatory.** A request without `select.scopes` naming at least one `{ namespace, type }` is refused as `bad_request`. The caller decides what gets crystallised; recall owns only the mechanism.

**Two modes**, and only the first runs the clusterer:

- **`form`**: cluster the *unclaimed* candidates matched by `select` and write new clusters. Rare and deliberate. A cluster is formed once and never re-derived: UMAP is seed-sensitive (adjusted Rand index around 0.5 across runs), so re-clustering would reassign identity for reasons unrelated to the data.
- **`accrete`**: kNN unclaimed rows against stored cluster centroids; attach each to the nearest cluster within a cosine threshold, else leave it unclaimed. Cheap and incremental; the steady-state path once clusters exist.

Clustering uses `@mnmal-ai/holomap-clusterer` (UMAP + HDBSCAN, run on L2-normalised vectors).

### Rollback and recovery

The cluster migration is additive (`IF NOT EXISTS`): a binary built without crystallisation ignores `recall_clusters` / `recall_cluster_members`. Rolling back does not remove the rows, and there is no delete mutation, so a bad `form` pass is cleaned up directly in Postgres:

```sql
DELETE FROM recall_clusters WHERE id IN ('<cluster-id>', ...);
-- members cascade (ON DELETE CASCADE on cluster_id)
```

Deleting a cluster releases its members: the next `form` or `accrete` pass sees them as unclaimed again.

### The corpus regression gate

`test/corpus-regression.test.ts` runs the real clusterer against a fixed reference corpus (723 rows, 1024-d) and asserts the cluster count and noise rate land in a band around a measured baseline. A second test clusters the corpus with and without L2 normalisation and asserts the results differ, which pins the normalised regime the band alone cannot distinguish. The corpus is not in this repository, so the file skips cleanly unless it is pointed at one:

```bash
HOLOMAP_CLUSTERER_FIXTURE=/path/to/corpus.tsv \
HOLOMAP_CLUSTERER_SRC=/path/to/holomap/npm/test/fixture.ts \
  pnpm --filter @mnmal-ai/substrate-recall test corpus-regression
```

- `HOLOMAP_CLUSTERER_FIXTURE`: the reference corpus TSV. Its sha256 is checked first, so a regenerated corpus cannot silently move the figures.
- `HOLOMAP_CLUSTERER_SRC`: optional path to upstream holomap's `npm/test/fixture.ts`; when set, this plugin's `l2normalize` is compared against upstream's byte for byte.

To measure the plugin's own path against a live store rather than the reference corpus, see [`scripts/measure-baseline.md`](scripts/measure-baseline.md).

## Source layout

```
src/
  index.ts                 default export createRecallPlugin; named-export primitives
  bootstrap.ts             config schema + defineBootstrap.kernel
  plugin.ts                plugin factory wiring the KernelPlugin slots
  recall/                  the shared recall core every surface calls
  recall-route.ts          POST /substrate/v1/recall
  frame-surface.ts         recall/Hit frame type
  mcp-tool.ts              recall MCP tool
  filter-operator.ts       embeddingSimilar
  embed-and-store.ts       embedding post-write primitive
  embeddings-store.ts      EmbeddingsStore interface (+ pg and in-memory impls)
  lexical-store.ts         LexicalStore interface (+ pg and in-memory impls)
  crystallise-*.ts         crystallisation route, core and guard
  migrations/              0001–0006: embeddings, salience, HNSW, dimension, clusters, lexical
```
