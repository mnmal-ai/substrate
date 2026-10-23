/**
 * GET /substrate/v1/onboard — cold-start agent onboarding endpoint. Spec §5.14.
 *
 * Returns binary topology (loaded coordinators, bridges, auth state), frame
 * grammar, and per-operation instructions in a single response. Behind the
 * `read` gate when auth is on, since the body names every coordinator and
 * namespace; /substrate/v1/whoami is the keyless route. The body is static per boot:
 * `onboardRoute` serialises it once and replies with the cached response.
 */

import type { BridgeRegistry, CoordinatorPlugin, HttpHandler } from '@mnmal-ai/substrate-types';
import { jsonResponse } from './helpers.js';

export interface OnboardDeps {
  version: string;
  coordinators: ReadonlyArray<CoordinatorPlugin>;
  bridges: BridgeRegistry;
  authEnabled: boolean;
  /**
   * Sorted names of substrate-plugin filter operators registered with the
   * shared `@mnmal-ai/substrate-filter` registry (e.g. `embeddingSimilar` from
   * substrate-recall). HTTP consumers read this to branch on "is recall
   * composed?" instead of sniffing error strings from a failed query.
   * Empty array when no substrate plugin contributes one.
   */
  filterOperators: ReadonlyArray<string>;
  /**
   * Sorted namespace names that are substrate-contributed virtual namespaces.
   * No autoCRUD, no storage, one-shot query/mutate only.
   * Empty array when no substrate plugin claims a virtual namespace.
   */
  virtualNamespaces: ReadonlyArray<string>;
}

interface BinaryMetadata {
  coordinators: Array<{ name: string; namespaces: Array<string> }>;
  /** No `baseUrl`: any reader can see onboard, and a peer's address is internal. */
  bridges: Array<{ ns: string; name: string }>;
  authEnabled: boolean;
  filterOperators: ReadonlyArray<string>;
  virtualNamespaces: ReadonlyArray<string>;
}

const HTTP_INSTRUCTIONS = {
  query: {
    method: 'POST',
    path: '/substrate/v1/query',
    body: '{ "<ns>/<TypeName>": { "params": { "id": 1 }, "fields": { "field": true } } }',
    notes: [
      'op-keys are qualified as <ns>/<TypeName> — the namespace segment is mandatory',
      'multiple op-keys in one request resolve in parallel',
      'fields: true=include scalar, nested object=resolve related type',
      'empty params returns the full list; params.id returns a single entity or null',
      "PROJECTION IS NOT VALIDATED THE WAY `where` IS, and the asymmetry is worth knowing: an undeclared name in `where` is REJECTED with `unknown_field`, while an undeclared name in `fields` returns `null` on every row — which looks identical to a declared field that is null everywhere. Those keys are named in the envelope's `_diagnostics.<op-key>.unknownProjectionFields` (and an `engine_unknown_projection_field` metric), so a projection typo is visible on the first request instead of never. It is a DIAGNOSTIC, not an error: the read succeeds and `errors` stays absent, because a rolling deploy can legitimately project a field a not-yet-restarted substrate has not learned.",
      "IF YOU MAP ROWS INTO TYPED OBJECTS, SURFACE `_diagnostics` — not merely 'do not discard it'. A mapping layer does worse than drop the diagnostic: it MANUFACTURES A PLAUSIBLE VALUE FROM THE ERROR. The unknown key arrives as `null`, satisfies the declared shape, and every null-guard downstream fires as though the field were genuinely empty — so the consumer takes the absent-value branch it was written to take, indefinitely, while the metric records one successful request. Log the named keys, attach them to the mapped result, or fail loudly in development. A consumer that never exposes the slot cannot ignore it, which is why its silence looks like health."
    ]
  },
  mutate: {
    method: 'POST',
    path: '/substrate/v1/mutate',
    body: '{ "<ns>/<mutationName>": { "params": { "field": "value" }, "fields": { "id": true } } }',
    notes: [
      'op-keys are qualified as <ns>/<mutationName>',
      "CONTEXT-MINING (do this before any create/update on a type you have not just inspected): GET /substrate/v1/schema/<ns>/<Type> and send ONLY its declared fields. Do not rely on remembered field names — the schema is the contract and it is queryable. autoCRUD hard-rejects undeclared fields with code `unknown_field` (the error's `allowed: [...]` lists the valid fields, so a miss is self-correcting).",
      'batched form: op-key value may be an Array<FrameEntry> — serial inside one transaction, all-or-nothing per op-key',
      'cross-op-key atomicity is not a goal — each op-key commits independently',
      'pass params.idempotencyKey on a frame to opt into §5.13 dedup; repeats within TTL replay the cached envelope verbatim'
    ]
  },
  schema: {
    method: 'GET',
    path: '/substrate/v1/schema',
    notes: [
      'returns the `default` namespace schema only — compatibility surface for pre-federation clients',
      'MANY DEPLOYMENTS DO NOT HOST A `default` NAMESPACE, and this route then answers 404 with `availableNamespaces` — that is a configuration answer, not a fault. Do not read it as the server being unhealthy; pick a namespace from the list and use the scoped forms below.',
      'multi-namespace clients should use /substrate/v1/federated-schema instead',
      "SCOPED + CHEAP: GET /substrate/v1/schema/<namespace> returns one namespace; GET /substrate/v1/schema/<namespace>/<Type> returns one type's write contract (its field defs + the create/update mutation param shapes). Prefer these over the full federated schema.",
      'NAMESPACE AND TYPE ARE PATH SEGMENTS, not query parameters. `?namespace=<ns>` is refused with 400 rather than silently ignored — the MCP tool `schema` takes them as arguments, and carrying that shape over to HTTP is the guess this route now names instead of answering about `default`.'
    ]
  },
  schemaForType: {
    method: 'GET',
    path: '/substrate/v1/schema/<namespace>/<Type>',
    notes: [
      "cheapest way to learn a type's exact write shape before a create/update",
      'response: { schemaVersion, namespace, type, fields, mutations } — `fields` is the declared FieldDef map (the write allow-list), `mutations` carries the matching create<Type>/update<Type> param + return shapes',
      '404 lists availableTypes when the type is unknown',
      'the declared fields ARE the contract: autoCRUD rejects any undeclared field on write with code `unknown_field` (details carry `allowed: [...]`)'
    ]
  },
  whoami: {
    method: 'GET',
    path: '/substrate/v1/whoami',
    notes: [
      "answers 'am I authenticated, and as whom?' — returns { authEnabled, identity }, where identity is null for an anonymous caller and otherwise { id, grants } — `grants` is a namespace -> capabilities map, the only grant surface",
      'ANSWERS WITHOUT A CREDENTIAL, deliberately: the caller with no token is the one with the most urgent question. A present-but-INVALID token still 401s, and that difference is the point — "you sent nothing" and "what you sent is broken" need different fixes',
      '`authEnabled: false` means this deployment verifies nothing, which is NOT the same as you being anonymous',
      'USE IT BEFORE CONCLUDING A CREDENTIAL WORKS: on a reads-open stack an authenticated read and an anonymous one return byte-identical results, so a successful query is never evidence of identity',
      'the grant is returned AS RECORDED — a wildcard stays a `"*"` key in `grants` rather than expanding into every namespace',
      'also available as the MCP tool `whoami`, and as a WS frame `{ id, op: "whoami" }` — ask on the SOCKET when the socket is what you are asking about, since its auth is a separate code path from HTTP'
    ]
  },
  federatedSchema: {
    method: 'GET',
    path: '/substrate/v1/federated-schema',
    notes: [
      'returns `Record<namespace, Schema>` for every active namespace',
      'cache at cold-start + rebuild when a response signals a federatedVersion mismatch',
      'build the WS nsIndex map from sorted(federatedSchema keys)'
    ]
  }
} as const;

/**
 * The live subscription surfaces: WS and SSE carry the same engine operations
 * in different envelopes, so both are described.
 *
 * Every string here is a claim about the wire, held to the real routes by
 * `onboard-wire-shapes.test.ts`. A claim conditioned on an auth mode is only
 * defended if that test composes a server in that mode.
 */
const WS_INSTRUCTIONS = {
  subscribe: {
    transport: 'ws',
    path: '/substrate/v1/ws',
    frame:
      '{"id":"1","op":"subscribe","frame":{"<ns>/<TypeName>":{"params":{"where":{}},"fields":{"id":true}}}}',
    /**
     * Structured rather than prose: each field is one cell of the
     * {mode} × {token} matrix, so `onboard-wire-shapes.test.ts` can read a cell
     * and drive that cell.
     */
    authByMode: {
      required:
        'DEFAULT. A tokenless upgrade receives one { id:"", kind:"error", errors:[{ code:"unauthorized" }] } frame and is closed with code 4001',
      attribute:
        'A tokenless upgrade is ADMITTED and runs anonymously, matching the HTTP routes under this mode — send `{ id, op:"whoami" }` and `identity` comes back null.',
      invalidToken:
        'Closed 4001 in BOTH modes. This is the distinction to design against rather than the mode: `attribute` relaxes "you sent nothing", never "what you sent is broken", so a caller that always sends a token sees identical behaviour either way'
    },
    notes: [
      'ops are `subscribe` | `stream` | `cancel` | `whoami` — any other `op`, and any frame missing a string `id`, is refused with { id:"", kind:"error", errors:[{ code:"invalid_frame" }] }',
      'server replies { id, kind:"snapshot", data:{ "<ns>/<TypeName>": rows }, shapes } immediately, then pushes kind:"add" | "update" | "remove" (a remove carries `removedId`, no `data`)',
      'PARAMS ARE NARROWER THAN QUERY: subscribe accepts only `where`, `orderBy` and `_allowTableScan`. `limit` is a POST /substrate/v1/query param and is refused here with code `unknown_param` — the allowlist is in the message',
      'multi-key subscribe IS supported (unlike stream); one socket multiplexes many sessions, keyed by your `id`',
      'cancel with { id, op:"cancel" } — the server acknowledges a cancelled SUBSCRIBE with { id, kind:"end", final:true }',
      '`{ id, op:"whoami" }` answers { id, kind:"whoami", data:{ authEnabled, identity } } without opening a session — ask it on the socket rather than over HTTP when the socket is what you are asking about',
      'subscriptions are connection-scoped — cancelled automatically on disconnect',
      'virtual namespaces cannot be subscribed: a `recall/*` key is refused with code `subscription_unsupported_frame` (one-shot query/mutate only)',
      'AUTH FOLLOWS `mode` — see `authByMode` on this section for the cell-by-cell answer. The short version: the DEFAULT mode refuses a tokenless socket, `attribute` admits one, and neither mode admits a broken token',
      'ANONYMOUS IS NOT PERMITTED — it is only ADMITTED. An anonymous socket still meets the namespace read policy inside `engine.subscribe`, which answers `policy_denied` on its own terms; the upgrade gate decides nothing except whether a tokenless caller reaches it'
    ]
  },
  stream: {
    transport: 'ws',
    path: '/substrate/v1/ws',
    frame:
      '{"id":"1","op":"stream","frame":{"<ns>/<TypeName>":{"params":{},"fields":{"id":true}}}}',
    notes: [
      'single op-key only — two keys are refused with code `stream_multi_key`',
      'server pushes { id, kind:"chunk", data:{ "<ns>/<TypeName>": <entity> } } per chunk',
      'terminates with { id, kind:"end", final:true } — errors terminate too, no partial-error-then-resume',
      'streaming needs a resolver returning an async iterable; autoCRUD types are not streamable and answer code `not_streamable`'
    ]
  },
  substratePack: {
    transport: 'ws',
    path: '/substrate/v1/ws',
    notes: [
      'advertise `Sec-WebSocket-Protocol: substrate-pack` at handshake to negotiate MessagePack frames with positionally-encoded `data`',
      'the negotiation is SYMMETRIC: on a pack socket your REQUEST frames must be MessagePack too — sending JSON text there is refused with code `invalid_frame`',
      'positional `data` decodes against the field selection you sent, in declared field order — see @mnmal-ai/substrate-pack (encodeWsFrame / decodeWsEnvelope)'
    ]
  },
  sse: {
    transport: 'sse',
    paths: ['/substrate/v1/subscribe', '/substrate/v1/stream', '/substrate/v1/stream/ticket'],
    notes: [
      'same two engine operations as WS, one session per HTTP response — cancellation IS disconnection, so there is no `cancel` op and no session id',
      'POST /substrate/v1/subscribe (or /substrate/v1/stream) with the frame object as the BODY — the qualified-frame-keyed payload, exactly as POST /substrate/v1/query takes it',
      'GET the same paths with ?frame=<url-encoded JSON> for EventSource, which cannot send an Authorization header: mint a ticket first with POST /substrate/v1/stream/ticket (body = the same frame) and pass ?ticket=<ticket>. A ticketless GET is 401 `ticket_missing`; the ticket is bound to that exact frame',
      'THE EVENT ENVELOPE DIFFERS FROM WS: SSE emits `event: <kind>` with a per-frame payload — snapshot/add/update carry { key, rows } or { key, row }, remove carries { removedId }, end carries { reason }, error carries { code, message }. WS instead sends one object per frame carrying `data` keyed by the frame key',
      'failures BEFORE the stream opens are ordinary HTTP status codes; once bytes are on the wire the status is spent and errors arrive in-band as `event: error`'
    ]
  }
} as const;

const CODE_MODE_INSTRUCTIONS = {
  command:
    'substrate run <script.mts> [--args <json>] [--dry-run | --write] [--max-writes <n>] [--out <file>]',
  summary:
    'For an agent with a shell: run a TypeScript script whose default export receives a signed client, so many reads and writes cost one call and return one small JSON report. It composes the operations above; it adds none, and every call meets the same grants and policy.',
  when: 'a count or census over many rows, a join across types, recall followed by fetching the bodies of the hits worth reading, or a batch of writes chosen by what a read found. One lookup or one write is simpler as a direct query or mutate',
  context:
    'the default export gets `s` with `args`, `query(frame)`, `queryAll(key, { params, fields })`, `recall({ query, namespace, type, ... })`, `mutate(payload)` and `log(...)`; return a reduced result (counts, ids, a verdict), not whole rows',
  notes: [
    'signs from SUBSTRATE_URL, SUBSTRATE_AGENT_KEY_ID and SUBSTRATE_AGENT_KEY_PATH, and refuses to run unsigned',
    'read-only by default: `mutate` throws unless `--dry-run` (records each payload and sends nothing) or `--write` (sends up to `--max-writes` frames, default 50). Dry-run first, read the recorded mutations, then write',
    'a frame the server rejected fails the run with its error rather than reading as empty; a truncated `query` is reported in `warnings`, and `queryAll` pages to the end',
    'stdout is one report `{ ok, kid, mode, args, result, error?, mutations, warnings, stats }`; `mutations` lists every payload with `applied`, including those sent before a failure. Exit codes: 0 ok, 1 the script failed, 2 usage or configuration'
  ]
} as const;

const AUTH_INSTRUCTIONS = {
  summary:
    'Bearer-JWT auth (§5.12). Present `Authorization: Bearer <jwt>` on every request, onboard included. Only /health, /substrate/v1/whoami and /substrate/v1/_system/register answer without one. Two paths to a token: (a) the invite→register exchange for a namespace-scoped JWT, or (b) a pre-registered per-principal key you sign with directly (the agent-identity path — see `identity`). How a MISSING token is treated depends on `mode`.',
  modes: {
    note: 'active mode is operator-configured via SUBSTRATE_AUTH_MODE; binary.authEnabled reports whether auth is on at all.',
    required: 'default — any missing or invalid token on a non-open route → 401.',
    attribute:
      'identify-if-present, allow-if-absent for READS: a MISSING token is admitted to read routes (you read anonymously, and the server logs it as an anonymous read), a VALID token is attributed to its principal, an INVALID token still → 401. Writes and admin routes always require a token. This is the mode used to roll out agent identity without locking out keyless readers.'
  },
  identity: {
    summary:
      'A per-principal Ed25519 keypair makes your writes attribute as `createdBy`. The PUBLIC key is registered in the stack key registry as { kid, alg:"EdDSA", publicKey, kind:"agent"|"user" }; you sign a short-TTL EdDSA JWT with the PRIVATE half (claims: sub=kid, exp, ns, capabilities) and present it as the Bearer token. `exp` and `ns` are MANDATORY on EdDSA tokens — omit either and the token rejects; keep TTLs short and refresh before expiry.',
    attribution:
      'kind:"agent" → createdBy:{kind:"agent", id:<kid>}; kind:"user" or omitted → kind:"user". A registry-backed token cannot inflate its ns/capabilities beyond what the registered key authorises (claim-vs-row intersection).',
    mcp: 'For the bundled MCP server, set SUBSTRATE_AGENT_KEY_PATH (private PEM path) + SUBSTRATE_AGENT_KEY_ID — it mints + refreshes the JWT and attaches the Bearer header automatically. Unset → anonymous, which only a stack in attribute mode will answer, and then for reads only.',
    operatorRunbook:
      'Agent identity: generate a keypair → register its public key → set SUBSTRATE_AUTH_MODE=attribute → restart → point MCP at the private key and kid → check createdBy on a write.'
  },
  register: {
    method: 'POST',
    path: '/substrate/v1/_system/register',
    body: '{ "inviteToken": "<token>", "publicKey": "<pem>", "algorithm": "EdDSA" }',
    notes: [
      'public route — rate-limited per peer IP (10 requests/60s default)',
      'returns { kid, namespaces, capabilities } on success — no JWT is issued; you sign your own short-TTL EdDSA JWT with the private key whose public half you just registered'
    ]
  },
  invites: {
    method: 'POST',
    path: '/substrate/v1/_system/invites',
    body: '{ "namespaces": ["<ns>"], "capabilities": ["read", "mutate"], "ttlMs": 3600000 }',
    notes: [
      'admin-only — requires a JWT carrying the admin capability',
      'returns { inviteToken, expiresAt } for one-time handoff to the registering agent'
    ]
  },
  header: 'Authorization: Bearer <jwt>',
  capabilities: {
    read: 'query, schema, NL within an authorised namespace',
    mutate: 'create/update/soft-delete within an authorised namespace',
    admin: 'invite mint, purge, compact, drop, _system namespace access'
  }
} as const;

/**
 * Frame grammar with a runnable `example`. The example namespace is the first
 * loaded coordinator's first namespace, since most deployments host no
 * `default`. Falls back to `default` only when no coordinator is loaded
 * (admin-only boot).
 */
function buildFrameGrammar(coordinators: ReadonlyArray<CoordinatorPlugin>): Record<string, string> {
  const exampleNs = coordinators[0]?.namespaces[0]?.namespace ?? 'default';
  return {
    queryKey: '<ns>/<TypeName>',
    mutationKey: '<ns>/<mutationName>',
    batched:
      'A mutate op-key MAY carry an Array<FrameEntry>. All frames under one array op-key run serially inside the same transaction (all-or-nothing per op-key), and each array op-key commits independently of every other op-key. The single-frame op-keys of one call share their own transaction: if any of them is refused, all of them roll back with `frame_rolled_back`. Query/subscribe/stream op-keys reject array values.',
    example: `{ "${exampleNs}/Todo": { "params": {"where": {"status": {"eq": "open"}}}, "fields": {"id": true, "title": true} }, "${exampleNs}/createTodo": [{ "params": {"title": "first"}, "fields": {"id": true} }, { "params": {"title": "second"}, "fields": {"id": true} }] }`
  };
}

function buildPluginContributions(
  plugins: ReadonlyArray<CoordinatorPlugin>
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const p of plugins) {
    if (p.onboardInstructions !== undefined) {
      out[p.name] = p.onboardInstructions;
    }
  }
  return out;
}

function buildPluginRoutes(
  plugins: ReadonlyArray<CoordinatorPlugin>
): Array<{ name: string; onboardPath: string }> {
  const out: Array<{ name: string; onboardPath: string }> = [];
  for (const p of plugins) {
    if (p.onboardInstructions !== undefined) {
      out.push({ name: p.name, onboardPath: `/substrate/v1/plugins/${p.name}/onboard` });
    }
  }
  return out;
}

function buildBinaryMetadata(deps: OnboardDeps): BinaryMetadata {
  return {
    coordinators: deps.coordinators.map((p) => ({
      name: p.name,
      namespaces: p.namespaces.map((n) => n.namespace)
    })),
    bridges: deps.bridges.entries().map(([ns, client]) => ({ ns, name: client.name })),
    authEnabled: deps.authEnabled,
    filterOperators: deps.filterOperators,
    virtualNamespaces: deps.virtualNamespaces
  };
}

export function buildOnboardBody(deps: OnboardDeps): Record<string, unknown> {
  const instructions: Record<string, unknown> = {
    query: HTTP_INSTRUCTIONS.query,
    mutate: HTTP_INSTRUCTIONS.mutate,
    schema: HTTP_INSTRUCTIONS.schema,
    schemaForType: HTTP_INSTRUCTIONS.schemaForType,
    federatedSchema: HTTP_INSTRUCTIONS.federatedSchema,
    whoami: HTTP_INSTRUCTIONS.whoami,
    subscribe: WS_INSTRUCTIONS.subscribe,
    stream: WS_INSTRUCTIONS.stream,
    substratePack: WS_INSTRUCTIONS.substratePack,
    sse: WS_INSTRUCTIONS.sse,
    codeMode: CODE_MODE_INSTRUCTIONS,
    plugins: buildPluginContributions(deps.coordinators),
    pluginRoutes: buildPluginRoutes(deps.coordinators)
  };
  if (deps.authEnabled) {
    instructions.auth = AUTH_INSTRUCTIONS;
  }
  return {
    substrate: 'agent-onboard',
    version: deps.version,
    binary: buildBinaryMetadata(deps),
    frameGrammar: buildFrameGrammar(deps.coordinators),
    instructions
  };
}

export function onboardRoute(deps: OnboardDeps): HttpHandler {
  const cached = jsonResponse(200, buildOnboardBody(deps));
  return async () => cached;
}
