import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeStreamFrames, FRAMES_JSON_MIME } from '@mnmal-ai/substrate/pack';
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
  signHs256
} from '@mnmal-ai/substrate/testing';
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
  status: number;
  response: unknown;
}

export interface Transcript {
  example: string;
  steps: StepResult[];
}

export interface ExampleSetup {
  name: string;
  namespaces: NamespaceDefinition[];
  agents?: string[];
  embedder?: 'fake' | 'live';
  dataset?: 'memory' | 'pg';
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
  if (setup.embedder !== undefined && kind === 'pg') {
    throw new Error(`embedder '${setup.embedder}' runs over the memory dataset only.`);
  }

  const sql = kind === 'pg' ? postgres(url as string, { onnotice: () => {} }) : undefined;
  const edges =
    sql === undefined ? new MemoryEdgesStore({ now: () => new Date() }) : new PgEdgesStore({ sql });
  const datasets: Record<string, MemoryDataset | PgDataset> = {};
  for (const ns of setup.namespaces) {
    const name = ns.namespace;
    const fieldDefLookup = (type: string, f: string) => ns.types?.[type]?.fields[f];
    const typeDefLookup = (type: string) => ns.types?.[type];
    const ds =
      sql === undefined
        ? new MemoryDataset({ namespace: name, fieldDefLookup, typeDefLookup, walkReference: true })
        : new PgDataset({
            namespace: name,
            sql,
            edgesStore: edges as PgEdgesStore,
            fieldDefLookup,
            typeDefLookup
          });
    if (ds instanceof PgDataset) {
      for (const type of Object.keys(ns.types ?? {})) await ds.ensureTypeStorage(type);
    }
    datasets[name] = ds;
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
  let composed: ComposeResult | undefined;
  try {
    composed = await compose({
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      datasets,
      edges,
      coordinators: [
        { name: setup.name, contractVersion: '*', namespaces: setup.namespaces } as never
      ],
      ...(kernelPlugins === undefined ? {} : { kernelPlugins }),
      ...(agents === undefined
        ? { systemActor: 'system' }
        : {
            auth: {
              keys: [SYSTEM_KID, ...agents].map((kid) => ({ kid, alg: 'HS256', publicKey: SECRET }))
            }
          })
    });
    await server.start();

    const results: StepResult[] = [];
    for (const step of steps) {
      const result = {
        label: step.label,
        method: step.method,
        path: step.path,
        ...(step.body === undefined ? {} : { body: step.body }),
        ...(step.as === undefined ? {} : { as: step.as }),
        feed: step.feed ?? false,
        ...(step.stream === undefined ? {} : { stream: step.stream }),
        ...(step.receive === undefined ? {} : { receive: step.receive })
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
            capabilities: ['read', 'mutate'],
            ns: setup.namespaces.map((n) => n.namespace)
          },
          SECRET,
          { kid }
        );
        headers.authorization = `Bearer ${token}`;
      }
      const res = await server.inject({
        method: step.method,
        path: step.path,
        headers,
        ...(step.body === undefined ? {} : { body: Buffer.from(JSON.stringify(step.body)) })
      });
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
    return { example: setup.name, steps: results };
  } finally {
    // Not awaited: after a timeout a read is still pending, and shutdown below ends it.
    for (const frames of streams.values()) void frames.return(undefined);
    await composed?.stop();
    await sql?.end({ timeout: 5 });
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const PINNED_TIME = '2026-11-03T09:00:00.000Z';

// Ids and cursors renumber by first appearance (step order, request before
// response) and server timestamps are pinned, so a run is byte-identical to
// the last. A cursor embeds a real timestamp and row id, so it is replaced whole.
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
