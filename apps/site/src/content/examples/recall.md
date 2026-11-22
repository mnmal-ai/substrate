---
order: 7
name: recall
promise: Declare which text to embed, and every write becomes searchable by meaning.
shows:
  - A type that names the text to embed, with no sync code
  - Customers found by what their notes mean, ranked by score
  - Hits carrying only the fields asked for, names but not notes
---

## Elsewhere

Search by meaning usually adds a vector store beside the database, such as [Pinecone](https://docs.pinecone.io/guides/index-data/indexing-overview), [Qdrant](https://qdrant.tech/documentation/concepts/hybrid-queries/) or [Weaviate](https://docs.weaviate.io/weaviate/search/hybrid). Each row's text goes there as a vector, under the row's id and with whatever fields the search needs, and every edit and delete has to follow it. Keeping the two stores in step, so that a changed row isn't still found by its old meaning, is glue the app writes.

These stores do real work. [Pinecone generates the vectors itself](https://docs.pinecone.io/guides/index-data/indexing-overview) from a field's text when you upsert and when you search. [Weaviate's hybrid search](https://docs.weaviate.io/weaviate/search/hybrid) fuses a vector search with a keyword (BM25F) search, and [Qdrant](https://qdrant.tech/documentation/concepts/hybrid-queries/) fuses dense and sparse queries, with Reciprocal Rank Fusion among its methods.

Or the vectors stay in Postgres. [pgvector](https://github.com/pgvector/pgvector) stores them with the rest of your data, and [its README](https://github.com/pgvector/pgvector) suggests pairing it with Postgres full-text search, combining the two with Reciprocal Rank Fusion. The embedding calls, the vector and text-search columns, their indexes and the fusion query are code you write and keep current.

## On substrate

The scenario is a small invoicing app: three customers and eight invoices, all invented, seeded from [`_scenario.ts`](https://github.com/mnmal-ai/substrate/blob/main/apps/site/examples/_scenario.ts), which most of the examples share. Here each customer also gains a free-text service note, embedded on every write.

Give a type an `embed.source` and every write is embedded. A `recall/Hit` frame then searches that type by meaning, and returns the rows it found with a score. A type that also declares a `lexical.source` gets keyword ranking fused in, and embedded rows can be clustered into durable `recall/Cluster` rows. Recall is built into substrate. On Postgres it keeps the vectors in [pgvector](https://github.com/pgvector/pgvector), in the same database as the rows.

The run records three service notes, then asks for customers unhappy about late delivery. On the published site, its steps come from a run made when the site is deployed, with a real embedder (bge-base). A build of the site without that run shows the code alone.

## Where it stops

- **On the published site, the run shown is in memory.** Its hits come from a real embedder (bge-base), run at deploy, with the rows and vectors kept in memory. On Postgres, the vectors live in [pgvector](https://github.com/pgvector/pgvector), beside the rows.
- **substrate's CI checks the mechanics, not the ranking.** It runs this example with a test embedder whose ranking is noise, and checks that every step succeeds and that every hit is a `Customer` row without its notes. That run's output never reaches this page.
- **This run ranks by meaning alone.** `Customer` declares no `lexical.source`, so no keyword ranking is fused in.
- **A write waits for its embed but doesn't depend on it.** The row commits first. If the embed fails or times out, the row keeps no vector, or its old one, until a backfill re-embeds it, and the backfill runs on Postgres stores only.
