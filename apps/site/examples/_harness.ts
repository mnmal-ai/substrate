import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeStreamFrames, FRAMES_JSON_MIME } from '@mnmal-ai/substrate/pack';
import {
  createNoopPubSub,
  createProposalsPlugin,
  storageSettled
} from '@mnmal-ai/substrate/proposals';
import { createRecallPlugin, InMemoryEmbeddingsStore } from '@mnmal-ai/substrate/recall';
import type { NamespaceDefinition } from '@mnmal-ai/substrate/sdk';
import {
  assertCannotWriteOutsideTestDatabases,
  assertNotSuperuser,
  assertTestDatabase,
  type ComposeResult,
  compose,
  FakeEmbedder,
  MemoryDataset,
  MemoryEdgesStore,
  MemorySubstrateServer,
  PgDataset,
  PgEdgesStore,
  runMigrations,
  signHs256
} from '@mnmal-ai/substrate/testing';
import { createNlPlugin, type NamespaceRulings } from '@mnmal-ai/substrate-nl';
import postgres from 'postgres';

export interface Step {
  label: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  as?: string;
  feed?: boolean;
  /** Hold this request open as a frame stream under this name. Its response is the first frame. */
  stream?: string;
  /** Send nothing: the response is the next frame on the stream an earlier step opened. */
  receive?: string;
  /** Send the request this many times; the result is the last response. */
  repeat?: number;
  /**
   * pg with `advisor`, before the request: a demo directive, echoed in the result. Insert `rows`
   * rows straight into the dataset with `field` set to `otherwise`, then `matching` more with it
   * set to `value`, one write each so their `createdAt` values differ, then ANALYZE.
   */
  fill?: {
    namespace: string;
    type: string;
    field: string;
    value: string;
    otherwise: string;
    rows: number;
    matching: number;
  };
  /**
   * pg with `advisor`, before the request, echoed in the result: from now on every read of the
   * advisor's owned namespaces takes at least this many ms, so the advisor sees a slow shape.
   */
  slow?: number;
  /** pg with `advisor`: keep the SQL the request makes, and EXPLAIN it (no ANALYZE) into `plans`. */
  explain?: boolean;
  /** pg with `advisor`, before the request, echoed in the result: run one index-advisor pass. */
  advise?: boolean;
}

export interface StepResult {
  label: string;
  method: string;
  path: string;
  body?: unknown;
  as?: string;
  feed: boolean;
  stream?: string;
  receive?: string;
  repeat?: number;
  fill?: Step['fill'];
  slow?: number;
  advise?: boolean;
  status: number;
  response: unknown;
}

export interface Transcript {
  example: string;
  steps: StepResult[];
  /** The plan of each `explain` step's own SQL, by label. Not part of the page's transcript. */
  plans?: Record<string, string>;
}

export interface ExampleSetup {
  name: string;
  namespaces: NamespaceDefinition[];
  agents?: string[];
  embedder?: 'fake' | 'live';
  dataset?: 'memory' | 'pg';
  /**
   * pg only: the proposals plugin owns these namespaces, the index advisor runs over them
   * under this store profile.
   */
  advisor?: { owned: string[]; storeProfile: 'scale' };
  /**
   * The proposals plugin owns these namespaces and every agent is granted `substrate.propose`.
   * Over pg only: a memory server wires one store per namespace, so a proposed type could not
   * walk to a code-defined one there. `advisor` implies it, over its own `owned`.
   */
  proposals?: { owned: string[] };
  /**
   * Serve `POST /substrate/v1/nl` over the namespaces, parser only: no judge, no network.
   * `rulings` are the operator's per-namespace overrides.
   */
  ask?: { rulings?: Record<string, NamespaceRulings> };
}

const PACKAGE_NAME = '@mnmal-ai/substrate-site';
// Throwaway HS256 secret for in-process signing; it guards nothing.
// Kid an unsigned step signs as when auth is on: compose has no system actor under auth
// (`systemActor` is ignored there), so the system actor is a registered key of its own.
export const SYSTEM_KID = 'system';
const SECRET = 'substrate-site-example-signing-secret-0123456789';
// In process a frame lands in milliseconds; this only turns a missing one into a named failure.
const FRAME_WAIT_MS = 5000;

type Frames = AsyncGenerator<Uint8Array>;

async function nextFrame(frames: Frames, label: string, name: string): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Step '${label}' got no frame on '${name}' in ${FRAME_WAIT_MS}ms.`)),
      FRAME_WAIT_MS
    );
  });
  try {
    const { value, done } = await Promise.race([frames.next(), timeout]);
    if (done === true) throw new Error(`Step '${label}' got no frame on '${name}': it ended.`);
    return JSON.parse(new TextDecoder().decode(value));
  } finally {
    clearTimeout(timer);
  }
}

export async function runExample(setup: ExampleSetup, steps: Step[]): Promise<Transcript> {
  const agents = setup.agents;
  if (setup.ask !== undefined && agents !== undefined) {
    // The NL route is mounted outside compose's auth, so a signature on it would go unchecked.
    throw new Error('ask runs unsigned: its route is outside auth, so set no agents.');
  }
  if (agents?.includes(SYSTEM_KID)) {
    throw new Error(
      `agents must not contain '${SYSTEM_KID}': it is reserved for the system actor.`
    );
  }
  for (const step of steps) {
    if (step.as === undefined) continue;
    if (agents === undefined) {
      throw new Error(`Step '${step.label}' sets as '${step.as}' but the setup has no agents.`);
    }
    if (!agents.includes(step.as)) {
      throw new Error(`Step '${step.label}' signs as '${step.as}', which is not in agents.`);
    }
  }
  const kind = setup.dataset ?? 'memory';
  const url = process.env.POSTGRES_URL;
  if (kind === 'pg') {
    if (url === undefined || url === '') {
      throw new Error(`Example '${setup.name}' uses dataset 'pg' and needs POSTGRES_URL.`);
    }
    assertTestDatabase(url, { packageName: PACKAGE_NAME });
    await assertNotSuperuser(url, { packageName: PACKAGE_NAME });
    await assertCannotWriteOutsideTestDatabases(url, { packageName: PACKAGE_NAME });
  }
  if (setup.proposals !== undefined && kind !== 'pg') {
    throw new Error("proposals run over the pg dataset only: set dataset 'pg'.");
  }
  if (setup.embedder !== undefined && kind === 'pg') {
    throw new Error(`embedder '${setup.embedder}' runs over the memory dataset only.`);
  }

  let slowMs = 0;
  // Statements the engine sends, kept only while an `explain` step runs.
  let sent: { query: string; params: unknown[] }[] | undefined;
  const sql =
    kind === 'pg'
      ? postgres(url as string, {
          onnotice: () => {},
          debug: (_c, query, params) => sent?.push({ query, params })
        })
      : undefined;
  if (sql !== undefined) await runMigrations(sql);
  const edges =
    sql === undefined ? new MemoryEdgesStore({ now: () => new Date() }) : new PgEdgesStore({ sql });
  const advisor = setup.advisor;
  if (advisor !== undefined && kind !== 'pg') {
    throw new Error("advisor runs over the pg dataset only: set dataset 'pg'.");
  }
  const owned = advisor?.owned ?? setup.proposals?.owned;
  const proposals =
    owned === undefined
      ? undefined
      : createProposalsPlugin({ ownedNamespaces: owned, pubsub: createNoopPubSub() });
  const defs = [...setup.namespaces, ...(proposals?.namespaces ?? [])];
  let composed: ComposeResult | undefined;
  // A type proposed at run time is in the registry, not in `defs`.
  const live = (namespace: string, type: string) => {
    const entry = composed?.engine.registryFor(namespace)?.get(type);
    return entry?.kind === 'type' ? entry : undefined;
  };
  const typeDefLookup = (type: string, namespace: string) => {
    const declared = defs.find((d) => d.namespace === namespace)?.types?.[type];
    const entry = live(namespace, type);
    if (declared !== undefined || entry === undefined) return declared;
    return {
      fields: entry.fields,
      ...(entry.expectedSize === undefined ? {} : { expectedSize: entry.expectedSize }),
      ...(entry.indexes === undefined ? {} : { indexes: entry.indexes })
    };
  };
  const datasets: Record<string, MemoryDataset | PgDataset> = {};
  for (const ns of defs) {
    const name = ns.namespace;
    const fieldDefLookup = (type: string, f: string) => typeDefLookup(type, name)?.fields[f];
    const ds =
      sql === undefined
        ? new MemoryDataset({
            namespace: name,
            fieldDefLookup,
            typeDefLookup: (type: string) => typeDefLookup(type, name),
            walkReference: true
          })
        : new PgDataset({
            namespace: name,
            sql,
            edgesStore: edges as PgEdgesStore,
            fieldDefLookup,
            // A walk out of a proposed type into `app` types the other namespace's fields.
            ...(proposals === undefined
              ? {}
              : {
                  fieldDefLookupFor: (ns: string) => (type: string, f: string) =>
                    typeDefLookup(type, ns)?.fields[f]
                }),
            typeDefLookup: (type: string) => typeDefLookup(type, name)
          });
    if (ds instanceof PgDataset) {
      for (const type of Object.keys(ns.types ?? {})) await ds.ensureTypeStorage(type);
    }
    datasets[name] = ds;
  }
  if (sql !== undefined && advisor !== undefined) {
    datasets._system = new PgDataset({
      namespace: '_system',
      sql,
      edgesStore: edges as PgEdgesStore,
      typeDefLookup
    });
    // A step's `slow` sets the delay: the scale profile counts 50 ms as slow, which a table
    // this small never reaches on its own.
    for (const name of advisor.owned) {
      const ds = datasets[name] as PgDataset;
      const read = ds.read.bind(ds);
      ds.read = async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, slowMs));
        return read(...args);
      };
    }
  }

  // Imported on demand so a CI run that never goes live never loads it.
  // `fastembed` is undeclared and is resolved from the embedder package's own real path.
  const embedder =
    setup.embedder === 'live'
      ? new (await import('@mnmal-ai/substrate-embedder')).OnnxEmbedder({
          model: 'bge-base-en',
          dimension: 768,
          // Absolute: fastembed's default is relative to the working directory.
          cacheDir: join(tmpdir(), 'substrate-site-embed-cache')
        })
      : setup.embedder === 'fake'
        ? new FakeEmbedder({ dimension: 8 })
        : undefined;
  // The first embed downloads the model, far past the plugin's 30s write timeout.
  if (setup.embedder === 'live') await embedder?.embed('warm up');
  const kernelPlugins =
    embedder !== undefined
      ? [
          createRecallPlugin({
            embedder,
            store: new InMemoryEmbeddingsStore({ datasetFor: (ns) => datasets[ns] })
          })
        ]
      : undefined;
  const server = new MemorySubstrateServer();
  const streams = new Map<string, Frames>();
  try {
    composed = await compose({
      server,
      // On pg the default dataset is the one the advisor reads statistics through.
      dataset:
        sql === undefined
          ? new MemoryDataset({ namespace: 'default' })
          : new PgDataset({
              namespace: 'default',
              sql,
              edgesStore: edges as PgEdgesStore,
              typeDefLookup
            }),
      datasets,
      edges,
      coordinators: [
        { name: setup.name, contractVersion: '*', namespaces: setup.namespaces } as never,
        ...(proposals === undefined ? [] : [proposals])
      ],
      ...(advisor === undefined
        ? {}
        : { advisor: { intervalMs: 3_600_000, storeProfile: advisor.storeProfile } }),
      ...(kernelPlugins === undefined ? {} : { kernelPlugins }),
      ...(agents === undefined
        ? { systemActor: 'system' }
        : {
            auth: {
              // An agent key stamps `kind: 'agent'` on what it writes, as a served binary's does.
              keys: [
                { kid: SYSTEM_KID, alg: 'HS256' as const, publicKey: SECRET },
                ...agents.map((kid) => ({
                  kid,
                  alg: 'HS256' as const,
                  publicKey: SECRET,
                  kind: 'agent' as const
                }))
              ]
            }
          })
    });
    if (setup.ask !== undefined) {
      // compose mounts no kernel routes; the binary does, so the demo does the same here.
      const nl = createNlPlugin({
        ...(setup.ask.rulings === undefined ? {} : { rulings: setup.ask.rulings }),
        engine: {
          federatedSchema: () => composed?.engine.federatedSchema() ?? {},
          operators: (n) => composed?.engine.datasetFor(n)?.capabilities.operators,
          // The demo's own system identity: the request's auth is not what is on show.
          query: (frame) =>
            composed?.engine.query({
              frame,
              ctx: {
                identity: { kind: 'system', id: SYSTEM_KID, grants: { '*': ['read', 'mutate'] } },
                now: new Date(),
                headers: {},
                meta: {}
              }
            } as never) as never
        }
      });
      for (const r of nl.kernelRoutes ?? [])
        server.route(r.method, `/substrate/v1/${r.path}`, r.handler);
    }
    await server.start();
    if (proposals !== undefined && sql !== undefined) {
      // Tables and unique indexes for every registered type, as the binary's boot does.
      for (const ns of Object.keys(composed.engine.federatedSchema())) {
        if (!composed.datasets.has(ns)) continue;
        for (const [type, entry] of composed.engine.registryFor(ns)?.all() ?? []) {
          if (entry.kind === 'type') {
            await composed.datasets.get(ns)?.ensureTypeStorage?.(type, { indexes: 'unique' });
          }
        }
      }
    }

    const results: StepResult[] = [];
    const plans: Record<string, string> = {};
    for (const step of steps) {
      const result = {
        label: step.label,
        method: step.method,
        path: step.path,
        ...(step.body === undefined ? {} : { body: step.body }),
        ...(step.as === undefined ? {} : { as: step.as }),
        feed: step.feed ?? false,
        ...(step.stream === undefined ? {} : { stream: step.stream }),
        ...(step.receive === undefined ? {} : { receive: step.receive }),
        ...(step.repeat === undefined ? {} : { repeat: step.repeat }),
        ...(step.fill === undefined ? {} : { fill: step.fill }),
        ...(step.slow === undefined ? {} : { slow: step.slow }),
        ...(step.advise === undefined ? {} : { advise: step.advise })
      };
      if (step.receive !== undefined) {
        const frames = streams.get(step.receive);
        if (frames === undefined) {
          throw new Error(
            `Step '${step.label}' receives from '${step.receive}', which no earlier step opened.`
          );
        }
        // Streams open only on a 200, and every frame after it rides that response.
        const response = await nextFrame(frames, step.label, step.receive);
        results.push({ ...result, status: 200, response });
        continue;
      }
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (step.stream !== undefined) headers.accept = FRAMES_JSON_MIME;
      if (agents !== undefined) {
        const kid = step.as ?? SYSTEM_KID;
        const token = signHs256(
          {
            sub: kid,
            exp: Math.floor(Date.now() / 1000) + 600,
            capabilities:
              advisor !== undefined
                ? ['read', 'mutate', 'substrate.propose', 'substrate.index']
                : proposals !== undefined
                  ? ['read', 'mutate', 'substrate.propose']
                  : ['read', 'mutate'],
            ns: defs.map((n) => n.namespace).concat(advisor === undefined ? [] : ['_system'])
          },
          SECRET,
          { kid }
        );
        headers.authorization = `Bearer ${token}`;
      }
      if (step.slow !== undefined) slowMs = step.slow;
      if (step.fill !== undefined && sql !== undefined) {
        const { namespace, type, field, value, otherwise, rows, matching } = step.fill;
        const ds = datasets[namespace] as PgDataset;
        const id = (i: number) => `0197a400-0000-7000-8000-${String(i + 1).padStart(12, '0')}`;
        await ds.write(
          type,
          Array.from({ length: rows }, (_, i) => ({ id: id(i), [field]: otherwise }))
        );
        // Each matching row gets its own write and second, so their order cannot tie.
        const base = Date.now();
        for (let i = 0; i < matching; i++) {
          await ds.write(type, [{ id: id(rows + i), [field]: value }], {
            now: new Date(base + (i + 1) * 1000)
          });
        }
        await sql.unsafe('ANALYZE');
      }
      if (step.advise === true) await composed.runAdvisorNow?.();
      if (step.explain === true) sent = [];
      const send = () =>
        server.inject({
          method: step.method,
          path: step.path,
          headers,
          ...(step.body === undefined ? {} : { body: Buffer.from(JSON.stringify(step.body)) })
        });
      let res = await send();
      for (let i = 1; i < (step.repeat ?? 1); i++) res = await send();
      // An approved index builds in the background; the next step should find it built.
      if (proposals !== undefined && sql !== undefined) await storageSettled();
      if (step.explain === true && sql !== undefined) {
        const mine = sent ?? [];
        sent = undefined;
        // The read's own SELECT on the type table, not the statements around it.
        const read = mine.findLast(
          (q) => /^\s*(select|with)\b/i.test(q.query) && q.query.includes('f_')
        );
        if (read === undefined) throw new Error(`Step '${step.label}' sent no read to EXPLAIN.`);
        const plan = await sql.unsafe(`EXPLAIN ${read.query}`, read.params as never);
        plans[step.label] = plan.map((r) => String(r['QUERY PLAN'])).join('\n');
      }
      if (step.stream !== undefined && res.status === 200) {
        const frames = decodeStreamFrames(res.body as ReadableStream<Uint8Array>);
        streams.set(step.stream, frames);
        const response = await nextFrame(frames, step.label, step.stream);
        results.push({ ...result, status: res.status, response });
        continue;
      }
      const raw =
        res.body === undefined || res.body === null
          ? ''
          : Buffer.from(res.body as never).toString('utf8');
      let response: unknown = raw;
      try {
        response = JSON.parse(raw);
      } catch {
        // A non-JSON body is kept as text.
      }
      results.push({ ...result, status: res.status, response });
    }
    return {
      example: setup.name,
      steps: results,
      ...(Object.keys(plans).length === 0 ? {} : { plans })
    };
  } finally {
    // Not awaited: after a timeout a read is still pending, and shutdown below ends it.
    for (const frames of streams.values()) void frames.return(undefined);
    await composed?.stop();
    await sql?.end({ timeout: 5 });
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const PINNED_TIME = '2026-11-03T09:00:00.000Z';
const PINNED_SCHEMA = 'schema';

// Ids and cursors renumber by first appearance (step order, request before
// response) and server timestamps and schema versions are pinned, so a run is
// byte-identical to the last. A cursor embeds a real timestamp and row id, so it
// is replaced whole.
export function normalise(t: Transcript): Transcript {
  const ids = new Map<string, string>();
  const cursors = new Map<string, string>();
  const token = (map: Map<string, string>, key: string, make: (n: number) => string): string => {
    let out = map.get(key);
    if (out === undefined) {
      out = make(map.size + 1);
      map.set(key, out);
    }
    return out;
  };
  const walk = (v: unknown, key?: string): unknown => {
    if (key === 'createdAt' || key === 'updatedAt') return PINNED_TIME;
    // A hash of the whole schema: any engine change would otherwise churn every snapshot.
    if (key === 'schemaVersion') return PINNED_SCHEMA;
    if (key === 'nextCursor' && typeof v === 'string') {
      return token(cursors, v, (n) => `cursor-${n}`);
    }
    if (typeof v === 'string') {
      return v.replace(UUID, (id) =>
        token(
          ids,
          id.toLowerCase(),
          (n) => `0197a000-0000-7000-8000-${String(n).padStart(12, '0')}`
        )
      );
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    }
    return v;
  };
  return {
    example: t.example,
    steps: t.steps.map((s) => {
      const out: Record<string, unknown> = { ...s };
      // Request first, then response, whatever order the keys sit in.
      if ('body' in s) out.body = walk(s.body);
      out.response = walk(s.response);
      return out as unknown as StepResult;
    })
  };
}

export async function writeTranscript(t: Transcript, file: string): Promise<void> {
  await writeFile(file, `${JSON.stringify(t, null, 2)}\n`);
}
