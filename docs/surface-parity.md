# Access-surface parity: what each surface can do, and where the shapes differ

Substrate is reachable four ways: **HTTP** routes, the **MCP** tools of `substrate mcp`,
the **WebSocket** frame channel (JSON or `substrate-pack`), and **SSE**. They are not
interchangeable. This is the map, so a consumer that knows one surface does not
have to guess at the next.

Every row was measured by issuing the request against a running server
(`SUBSTRATE_AUTH_MODE=attribute`) and reading the answer, not transcribed from the
router source. A matrix built from the source checks the source's intent rather
than its behaviour.

## Capability matrix

`—` means the surface does not offer the operation at all.

| capability | HTTP | MCP | WS (`/substrate/v1/ws`) | SSE |
|---|---|---|---|---|
| health | `GET /health` | — | — | — |
| **whoami** | `GET /substrate/v1/whoami` | `whoami` | `{op:"whoami"}` | — |
| onboarding doc | `GET /substrate/v1/onboard` | — | — | — |
| schema: all namespaces | `GET /substrate/v1/federated-schema` | `schema` (no args) | — | — |
| schema: one namespace | `GET /substrate/v1/schema/<ns>` | `schema {namespace}` | — | — |
| schema: one type | `GET /substrate/v1/schema/<ns>/<Type>[?shape=]` | `schema {namespace,type,shape}` | — | — |
| schema: default namespace | `GET /substrate/v1/schema` | — | — | — |
| operator contract | `operators` + `extensionOperators` + `metadataFields` + `metadataAuthorFields`, on each namespace-scoped schema response | same body — `schema` proxies it verbatim | — | — |
| namespace annotations | `annotations` (opaque per-consumer namespace metadata, e.g. `nl` rulings) on `GET /substrate/v1/schema/<ns>` and `/substrate/v1/federated-schema`; not on the per-type route | same body via `schema` | — | — |
| query | `POST /substrate/v1/query` | `query` | — (`op` allowlist is subscribe/stream/cancel/whoami) | — |
| mutate | `POST /substrate/v1/mutate` | `mutate` | — | — |
| subscribe | — | — | `{op:"subscribe"}` | `GET`/`POST /substrate/v1/subscribe` |
| stream | — | — | `{op:"stream"}` | `GET`/`POST /substrate/v1/stream` |
| cancel | — | — | `{op:"cancel"}` | disconnect (no op) |
| recall | `POST /substrate/v1/recall` **and** `recall/Hit` through `POST /substrate/v1/query` | `recall` | refused (`subscription_unsupported_frame`) | refused, same code — in-band as `event: error` under HTTP 200 |
| metrics | `GET /substrate/v1/metrics` (needs `read`): request counts, per-key `resolvers` (latency histogram, errors), `process` (rss, heap, cpu, event-loop lag, `inFlight`), `slowest`; no error text; per-key fields filtered by the caller's namespace grant (read in that namespace; anonymous callers get none) | — | — | — |
| errors | `GET /substrate/v1/errors` (needs `admin`): last 50 failed resolves with truncated messages, each naming its caller (its kid, the key id it signed with, or `anonymous`) | — | — | — |
| config knobs | `GET /substrate/v1/config` (needs **`admin`**, not `read`) | — | — | — |
| embed stats | `GET /substrate/v1/embed-stats` — answers about **both** retrieval arms despite the name | — | — | — |
| admin: invites, drop-namespace, drop-type | `POST /substrate/v1/_system/*` | `drop_namespace`, `drop_type` | — | — |
| register a key | `POST /substrate/v1/_system/register` | — | — | — |
| schema proposals | plugin routes | `propose_type`, `propose_field` | — | — |
| NL query | `POST /substrate/v1/nl` `{ namespace, question, project?, type? }` — JSON `{ outcome, trail }` by default; **`Accept: text/event-stream` selects an SSE encoding** (`parsed`, `judging`, `judged`, then the outcome named by its kind — `rows` \| `recall` \| `clarify` \| `refuse` — then `done`; a failure is an in-band `event: error` under HTTP 200). Plus **`GET /substrate/v1/nl/pack/<ns>`**: the namespace pack, built under the caller, `etag` / `304`, `vary: authorization`. Both need `read`. **404 when `@mnmal-ai/substrate-nl` is not installed** | `ask` — advertised regardless; **JSON only** (no SSE, no pack), accepts `type` to resubmit a clarify option | — | — |

**The subscribe/stream row is the one that surprises people.** Live updates are
WS- and SSE-only; there is no MCP subscription tool, so an MCP-only agent polls
or does without.

**About the operator contract.** Three things are worth knowing before you consume it:

- `operators` is keyed by **field kind**, not by field name. Each field already
  carries its `kind`, so the caller joins the two; that keeps the map one copy
  per response instead of one per field.
- The valid set for a field is `operators[kind]` **∪** `extensionOperators`.
  Extension operators (substrate-recall's `embeddingSimilar`, say) register
  per-operator rather than per-kind and skip the dataset capability check, so
  they are valid against every kind and cannot be folded into the map.
- **An absent key is UNKNOWN, never "no operators".** A namespace with no
  host-registered dataset — bridges, virtual namespaces — has no capabilities
  to report, and the server omits the keys rather than serving `{}`, which
  would read as a refusal. Same distinction `_enumVerdicts` draws on the
  federated route.
- `metadataFields` lists the row-metadata columns every type can filter and
  order on without declaring them: `id`, `createdAt`, `updatedAt`,
  `createdById`, `createdByKind`, `updatedById`, `updatedByKind`.
  `metadataAuthorFields` maps the author names `_metadata` returns onto them.
  So the spellings a reader learns from a row are accepted too: `createdBy`
  with a plain operand matches the id (`{ createdBy: { eq: '<kid>' } }`), an
  object operand `{ kind, id }` matches both halves, and `createdBy.id`,
  `createdBy: { id: …, kind: … }`, a `path: ['kind']` predicate and the
  `_metadata` nesting (`{ _metadata: { createdBy: … } }`,
  `'_metadata.createdAt'`) all resolve to the same columns, in `where`,
  `orderBy` and subscriptions alike. A metadata-looking name none of these
  covers is refused as `unknown_field` naming the columns.

`GET /substrate/v1/onboard` publishes the extension list under a different name,
`filterOperators`. Same data, two spellings — the kind of shape mismatch this
document exists to record.

**`GET /substrate/v1/config` is the one route here gated on `admin` rather than
`read`.** The asymmetry with `/substrate/v1/metrics` is deliberate: throughput
counters say how BUSY a deployment is, the knob report says how it is BUILT —
store kind, auth mode, trusted-proxy list. Two further properties:

- **It does not exist on every deployment.** The route mounts only when the
  caller passes a knob report to `compose`, which the binary does and an
  embedder configuring compose programmatically does not. A `404` here means
  "this process was not configured from the environment", which is a different
  fact from the route being unavailable to you — that is a `401` or `403`.
- **Secret-valued knobs report presence, never value.** They carry
  `redacted: true` with `value: '<set>' | null`, so "is a stream-ticket secret
  configured" is answerable and the secret does not travel. `redacted` is
  flagged rather than the key omitted, so a reader can tell a hidden value
  from a genuinely unset one.

## The shape differences, stated

Same operation, different spelling, per surface.

### 1. Schema scoping: arguments vs path segments

MCP `schema` takes `namespace` and `type` as **arguments**. HTTP takes them
as **path segments**. Carrying the MCP shape over, as
`GET /substrate/v1/schema?namespace=<ns>`, answers `400` naming the path form
rather than silently answering about the default namespace.

**The type form takes `shape` on BOTH surfaces** — `?shape=fields` over HTTP,
`schema {namespace, type, shape}` over MCP. It is the one place the two
spell a parameter the same way, because it is a projection rather than scoping.
`full` is the default and inlines every mutation's params and returns; `fields`
returns the field defs plus `mutationNames` at roughly a sixth the size.

Reach for `fields` whenever the question is "what fields does this type have".
For an autoCRUD type the mutations restate the field block five times over, so
the full shape grows several times faster than the fields themselves.

An unrecognised `shape` is **refused**, not ignored.

### 2. `whoami` is on three surfaces, and the WS one is not redundant

`GET /substrate/v1/whoami`, the MCP tool `whoami`, and the WS frame
`{ id, op: "whoami" }` all return the same `{ authEnabled, identity }`, built by
one shared projection.

The obvious objection to the WS op is that a client could just call the HTTP
route. It can't, quite: **a socket's auth is a different code path from
HTTP's** (see §8), so "am I authenticated over HTTP" is not guaranteed to be the
same question as "am I authenticated on this socket". Ask on the connection you
are asking about.

Whichever surface you use:

- **It answers without a credential** (`200`, `identity: null`). The caller with
  no token has the most urgent question, so it is not behind a capability gate.
- **A present-but-invalid token still `401`s.** That asymmetry is deliberate:
  "you sent nothing" and "what you sent is broken" need different fixes.
- **The gated routes say which of the two it is.** A tokenless caller refused by
  `withAuth` gets `{ code: 'unauthorized', detail }`, where `detail` names the
  absent header and points at `/substrate/v1/whoami`. Once auth is on, onboard
  and the schema routes need a `read` key too, leaving `/health`,
  `/substrate/v1/whoami` and `/substrate/v1/_system/register` as the keyless
  routes. A REJECTED credential carries `reason` instead. An unknown kid stays
  bare, so the response cannot be used to probe which kids exist.
- **`authEnabled` is separate from `identity`** because `identity: null` alone
  is ambiguous — it means both "auth is on and you are anonymous" and "this
  deployment verifies nothing".

**Use it before concluding a credential works.** On a reads-open deployment an
authenticated read and an anonymous one return byte-identical results, so a
successful query is never evidence of identity.

### 3. Recall: `query` here, `to` there — and each rejects the other

Recall has two HTTP spellings and they do not agree:

| | parameter | shape | response |
|---|---|---|---|
| `POST /substrate/v1/recall` | `query` | request body | `{ rows: [{ row, score, _salience, … }] }` |
| `recall/Hit` via `POST /substrate/v1/query` | `to` | `params`, **not** `where` | ordinary frame data: `{ data: { "recall/Hit": [ … ] } }`, field-projectable |
| MCP `recall` | `query` | tool arguments | as the route |

Measured: `params.query` on the frame → `"to" must be a non-empty string`;
`body.to` on the route → `"query" must be a non-empty string`. Note also that
`to` sits in `params` and not in `where`, against the usual "filters live in
`where`" convention — `recall/Hit` is a virtual type whose params are a search
input, not a filter.

Every spelling needs `type`, the type to search; there is no default. An
omitted `namespace` falls back to the server's `SUBSTRATE_NAMESPACE`, and is
refused as `missing_namespace` when that is unset.

**All three REFUSE unknown parameters** and name the allowed set, matching
subscribe. With a mode toggle in the API, silently dropping an unknown
parameter would make "the arm contributed nothing" and "my toggle was never
read" the same bytes.

The allowed sets differ by surface exactly as the spellings do: the frame's
names `to`, the route's and the MCP tool's name `query`. Each refusal is
generated from the array its own parser uses, so the message cannot drift from
the behaviour.

**`where` scopes recall by row fields, on all three surfaces** (and the binary's
`recall` proxy). It is the equality family only — field → `{ eq }` or
`{ in }`, every field must match, `eq: null` matches a missing or null field —
e.g. `{ "project": { "in": ["my-project", null] } }`. It is applied INSIDE every
candidate source (dense kNN, lexical search, crossRef expansion), so `k` fills
with matching rows rather than being spent on rows a caller would drop. On the
frame it is a recall param (`params.where`), not a frame-level filter. The core
validates its shape once for every surface; a malformed filter is refused
`bad_request` naming `"where"`. Pg rows come back with their promoted columns
(`archived`, `project`, `status`, `priority`) merged in, as the dataset read
path returns them. Limit: under the HNSW iterative scan, a very selective filter
behind more than `hnsw.max_scan_tuples` nearer non-matching rows can still
return fewer than `k`.

**A hit's `row` carries `id` plus its handle fields unless you ask for more.**
The handle fields are `name`, `title`, `topic`, `synopsis` and `description`,
whichever the row has. They are short by design and are usually enough to
decide whether a hit is the one you want. Ask for more on the hits you will
actually read:

| Surface | Handles (default) | Chosen fields | Whole body |
|---|---|---|---|
| route, MCP `recall` | omit `rowFields` | `rowFields: { "synopsis": true, "body": true }` | `rowFields: true` |
| `recall/Hit` frame | no `row` selection in `fields`, or no `fields` | `fields: { …, "row": { "synopsis": true, "body": true } }` | `fields: { …, "row": true }` |

Chosen fields are exactly those plus `id` on the route and the MCP tool. On the
frame the engine projects `row` to exactly what is named, with the hit's `id`
beside it. Row filters and read policy still see the full body, so projection
saves bytes and tokens, not the server's read. A malformed `rowFields` is
refused `bad_request` naming `"rowFields"`.

### 3b. The lexical arm, and what `score` means

Where a type declares `lexical.source` and a lexical store is wired, recall
fuses a keyword arm with the dense one by Reciprocal Rank Fusion. Consequences
a caller can see:

| | |
|---|---|
| `score` | cosine similarity unless the lexical arm actually **returned rows**; an **RRF sum** when it did and the two were fused. It has to change meaning in that case: a row the dense arm never returned has no cosine, and surfacing exactly those rows is the point. It does NOT change meaning otherwise. |
| `arms` | what ACTUALLY ran — `{ dense, denseWhy, lexical, lexicalWhy }`. `lexicalWhy` is `ran` / `no-store` / `no-source` / `disabled-by-request`; `denseWhy` is `ran` / `no-embedder` / `no-store` / `no-source`. Both `arms` and `denseWhy` are optional: absent means an older server, never `ran`. |
| `arms.dense` on an **unembedded type** | `false`, with `denseWhy: 'no-source'`. A type declaring no `embed.source` has no vectors, so kNN cannot match and never will. Reporting `true` would make "this type is never embedded" indistinguishable from "nothing matched". |
| `lexical: false` | turns the arm OFF for one request. It exists to disable, never to enable — the type DECLARATION is the opt-in, so there is one switch rather than two that can disagree. |
| `explain: true` | adds `_arms` (per-arm ranks, `null` for an arm that did not return the row) and `_denseScore` (`null` for a row the dense arm never ranked) to each row. A fused score alone cannot say which arm put a row where it is. |

What the arm reports, on the edge cases:

| | value |
|---|---|
| `score` on a type with **no `lexical.source`** | the cosine |
| `score` when the arm ran and **matched nothing** | the cosine |
| `_denseScore` on a **lexical-only** row | `null` |
| `arms.lexicalWhy` on a type with no source | `no-source` |

The scores matter because a consumer's floors are calibrated in the cosine
domain. An RRF value is roughly `1/61` where a cosine would be `0.44`, so an RRF
value with no lexical information in it would pass a floor as *irrelevant*,
silently, on every row. `_denseScore` is `null` rather than `0` for the same
reason pointed the other way: `0` is a cosine a row could genuinely have, so a
floor comparison would ADMIT a lexical-only row rather than declining to judge
it. `no-source` matters because an arm that **cannot** match is otherwise
indistinguishable, from the outside, from an arm that matched nothing.

Explain output keeps its shape when the arm matched nothing — rows still carry
`_arms` with `lexical: null`, so the per-row diagnostic is there when you need
it. All of the above reaches the route, the frame and the MCP tool.

##### The keyword arm degrades instead of vanishing

`websearch_to_tsquery` ANDs every non-stopword term, so one absent term would
zero the whole arm — and the queries that hit it are the natural ones:

```
'Las Vegas'                   rank 2
'what happened in Vegas'      zero under AND — 'happened' is not in the row
```

Recall runs the strict query first and falls back to an OR-joined form
**only when it matched nothing**. That is strictly additive: the fallback
fires only where the arm would contribute nothing and can never displace a
strict hit, so precision is unchanged. Always-OR was rejected because nothing
bounds lexical admission by default — with no `threshold` set, every extra row
an OR pass admits reaches the fused result unfiltered. A `threshold` is applied
to lexical-only rows too, by scoring their stored vectors, and
`lexicalThreshold` sets that floor separately (`0` leaves lexical-only rows
unfloored).

Two limits:

- **A query carrying an exclusion never falls back.** `Stockholm -Vasa` parses
  to `'stockholm' & !'vasa'`, and rewriting `&` to `|` yields `'stockholm' |
  !'vasa'` — every row *not* mentioning Vasa. A query that returned nothing
  would come back with nearly everything.
- **It does not fix `go` → `went`.** The English stemmer relates suffixes, not
  irregular stems, so a query matching on a VERB is out of reach for a lexical
  arm under either pass. That is the dense arm's job.

#### The dense arm is optional, and availability is decided in one place

A deployment with no embedder configured still answers recall from the lexical
arm. `lexical.tsv` is `GENERATED ALWAYS` and its write hook is wired outside the
embedder gate, so the rows are indexed either way.

Two things a caller can see:

| | |
|---|---|
| `model` | the DENSE arm's model, **empty when no dense arm ran** — including when the arm was skipped because the type declares no `embed.source`, since naming a model over a type that was never embedded reads as though that model searched and found nothing. Required and empty rather than absent, because absent would read as "this server predates the field". `arms.dense` is the authoritative statement; this is its consequence. |
| `timings.embed_ms` / `knn_ms` | zero when the dense arm did not run — no step, no time. `arms.dense` says which reading a zero is. |

And two refusals, which are **different faults with different fixes** and so
carry different codes: `embedder_unavailable` (503 on the route) means no arm
is wired at all and an operator has to change that; `no_retrieval_arm` (400)
means the deployment has a lexical arm and the request switched it off with
`lexical: false`, which the caller can fix by retrying without the flag.

All three surfaces use the same codes. The "can recall run?" decision lives in
`handleRecallRequest`, which all three reach, and the surfaces only map its code
to their transport.

### 4. Subscribe params are a strict subset of query params

`limit` is a query param. On subscribe it is refused:

```
subscribe('<ns>/<Type>'): unknown param 'limit'. Allowed: _allowTableScan, orderBy, where.
```

The allowlist is engine-wide (`KNOWN_SUBSCRIBE_PARAMS`), not a namespace quirk.
A consumer that reuses its query params for a subscription gets `unknown_param`.

### 5. `stream` is single-key; `subscribe` is not

Two keys under a `stream` op → `stream_multi_key`. The same two keys under
`subscribe` return a snapshot for each. The asymmetry is deliberate and kept.

### 6. WS and SSE carry the same frames in different envelopes

| | snapshot |
|---|---|
| WS | `{ id, kind: "snapshot", data: { "<ns>/<Type>": rows }, shapes }` |
| SSE | `event: snapshot` + `data: { key, rows }` |

Per-kind on SSE: `remove` carries `{ removedId }`, `end` carries `{ reason }`,
`error` carries `{ code, message }`. A client written against one does not read
the other.

### 7. `substrate-pack`: where to opt in

`substrate-pack` is MessagePack with positional rows, an opt-in alternative to
JSON with the same semantics. What it encodes and why is in
[first principles §7](substrate-from-first-principles.md#7-wire-format-substrate-pack).
Which surfaces carry it:

| surface | opt in with | client option |
|---|---|---|
| HTTP `query`, `mutate` | `Accept: application/vnd.substrate.pack` | `client.query(frame, { wire: 'pack' })` |
| WebSocket | `Sec-WebSocket-Protocol: substrate-pack` at the handshake | `new SubstrateClient({ wsEncoding: 'pack' })` |
| MCP, SSE | not available | — |

Its purpose is decode speed on multi-thousand-row responses, not size. It does
not make payloads much smaller. Over HTTP against a live `cortext` store:

| `cortext/SessionLog` | JSON | pack | pack / JSON | after gzip |
|---|---|---|---|---|
| 500 rows, 3 short fields | 138 KB | 123 KB | 0.89 | 1.00 |
| 500 rows, 6 fields incl. `summary` | 1,170 KB | 1,133 KB | 0.97 | 1.00 |

So turn it on for a client that decodes large result sets or a busy
subscription, not to save bandwidth. For small reads JSON costs nothing extra
and is easier to debug.

#### Negotiation is symmetric

On WebSocket, advertise `Sec-WebSocket-Protocol: substrate-pack` and the server sends MessagePack
with positionally-encoded `data` — and then expects **your** frames in
MessagePack too. Sending JSON text on a pack-negotiated socket is refused with
`invalid_frame`, which looks like a grammar error and is an encoding one.

### 8. Anonymous access differs by surface AND by layer

Under `SUBSTRATE_AUTH_MODE=attribute`, a missing bearer is allowed on non-admin
HTTP routes. But "allowed by the route" is not "allowed", because a namespace
can impose its own write policy above the route gate. In the table, `open/…` is
a namespace with no write policy and `strict/…` is one whose
policy requires an authenticated identity for writes:

| request | anonymous | authenticated |
|---|---|---|
| `POST /substrate/v1/query`, `strict/<Type>` | **200**, rows | 200, rows |
| `POST /substrate/v1/mutate`, `open/create<Type> {}` | **200** `missing_required_field` | 200 `missing_required_field` |
| `POST /substrate/v1/mutate`, `strict/create<Type> {}` | **200** `policy_denied` (writes require an authenticated identity; reads stay open) | 200 `missing_required_field` |
| `POST /substrate/v1/subscribe` (SSE) | **200**, `event: snapshot` | 200 |
| `/substrate/v1/ws` | **connects**, reads as anonymous — `whoami` answers, `subscribe` returns a snapshot | connects |
| `POST /substrate/v1/_system/invites` | 401 | 403 `{required:"admin", have:["read","mutate"]}` |

Read the two mutate rows together: same route, same verb, same anonymous
caller, differing only in the namespace. The route gate (`withAuth` under
`attribute` mode) admits the anonymous write in both — `plane` reaching
`missing_required_field` is what that looks like. The strict namespace then
refuses it at its write policy. **Two independent layers, and only the second
is namespace-specific.** So there is no single answer to "can anonymous
write?"; there is one answer per namespace.

The WS row matches `withAuth`: `ws.ts` computes `anonymousAllowed =
auth.mode === 'attribute' && token === null` and skips the close for that case,
so a tokenless socket under `attribute` connects and reads as anonymous. A token
that is PRESENT but invalid still gets the `unauthorized` frame and the 4001
close, in either mode — the same distinction `/substrate/v1/whoami` draws. What
this does not open: the socket carries `subscribe` / `stream` / `cancel` /
`whoami` and there is no WS mutate, so the effect is anonymous SUBSCRIPTIONS,
which SSE also permits — and they still meet the namespace read policy, which
answers `policy_denied` on its own terms.

#### Two probes that answer a narrower question than they appear to

**A mutation name that does not exist never reaches the gate.** A probe like
`<ns>/createNothingXYZ` returns 200 with `unknown_name`, which can read as
"reached validation, therefore past the gate". It was stopped *before* the gate,
at name resolution, which happens ahead of the write policy. A probe intended to
test authorisation has to name an operation that exists, or it tests the name
table instead.

**The stream ticket's `capabilities` field is constant and describes nothing.**
`POST /substrate/v1/stream/ticket` returns `capabilities: ["read"]` for an
anonymous caller and for an authenticated one with `["read","mutate"]` alike:
the mint route sets it to a constant (`STREAM_CAPABILITY`). It is the ticket's
authority, not the principal's. The `identity` field beside it is the
informative one — `null` versus the full principal, including its `namespaces`
grant — which makes the ticket route a useful anonymity probe, just not through
that field.

## Where this is published

The same information reaches consumers through **`GET /substrate/v1/onboard`**,
which carries the WS grammar, the `substrate-pack` negotiation rule, an SSE
section, and the schema path-vs-query note.
`packages/substrate-compose/test/onboard-wire-shapes.test.ts` holds the onboard
document to the routes by driving the claims it serves, so the document cannot
silently describe a grammar the routes do not accept.
