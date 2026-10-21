# Measuring substrate-recall's crystallisation baseline

No published figure describes this plugin's numerical path against your data. Measure it, and record BOTH axes — regime and backend — with every number.

## This plugin's cell

- **backend:** wasm (`@mnmal-ai/holomap-clusterer`, version per `CLUSTERER_BACKEND_VERSION` in `src/clusterer-version.ts`)
- **regime:** normalised — stored vectors are L2-normalised by `l2normalize` before clustering, whatever the embedder returned.

The nearest published figure for wasm × normalised is 36 clusters / 27.0% noise **on the reference corpus** used by the corpus regression gate. Your store has a different corpus, possibly a different embedder and dimension. It is an analogue, not a prediction. Figures for other cells (native backend, or raw vectors) describe different conditions and should not be quoted for this plugin.

## Procedure

Against a running server, after a dry structural count:

```bash
BASE=http://localhost:3100

# 1. Which types are embedded, and how embedding writes have gone since restart.
curl -s $BASE/substrate/v1/embed-stats

# 2. Form, with an explicit selection. Exclude synthetic or near-duplicate
#    rows (fixtures, seeded test data): they form the densest regions and
#    distort the count.
curl -s -X POST $BASE/substrate/v1/crystallise \
  -H 'content-type: application/json' \
  -d '{
        "mode": "form",
        "select": {
          "scopes": [
            { "namespace": "<ns>", "type": "<Type>" }
          ],
          "excludeTextPrefixes": [
            { "field": "title", "prefix": "seed-" }
          ]
        }
      }'
```

Add an `authorization` header when auth is enabled. `form` writes clusters that are never re-derived, so run it against a store you can clean up (see *Rollback and recovery* in the plugin README).

From the response, record `candidates`, `considered`, `clustersFormed`, `noise`, and the noise RATE (`noise / considered`). Sample a handful of cluster labels and note how many read as coherent topics.

## Recording

Wherever you keep the result, record:

- both axes (`wasm × normalised`), the clusterer version, the embedder model and dimension, the seed and parameters
- the measured cluster count and noise rate
- the corpus it was measured on: your store, at a stated date and row count, not the reference corpus

A figure recorded without both axes is not usable by the next reader.
