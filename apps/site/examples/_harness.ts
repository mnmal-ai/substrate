import { writeFile } from 'node:fs/promises';
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
}

export interface StepResult {
  label: string;
  method: string;
  path: string;
  body?: unknown;
  as?: string;
  feed: boolean;
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

export async function runExample(setup: ExampleSetup, steps: Step[]): Promise<Transcript> {
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
  if (setup.embedder === 'live') {
    throw new Error(
      "embedder 'live' is not available in this build: no ONNX embedder is exported."
    );
  }
  if (setup.embedder === 'fake' && kind === 'pg') {
    throw new Error("embedder 'fake' runs over the memory dataset only.");
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

  const agents = setup.agents;
  const kernelPlugins =
    setup.embedder === 'fake'
      ? [
          createRecallPlugin({
            embedder: new FakeEmbedder({ dimension: 8 }),
            store: new InMemoryEmbeddingsStore({ datasetFor: (ns) => datasets[ns] })
          })
        ]
      : undefined;
  const server = new MemorySubstrateServer();
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
      const headers: Record<string, string> = { 'content-type': 'application/json' };
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
      results.push({
        label: step.label,
        method: step.method,
        path: step.path,
        ...(step.body === undefined ? {} : { body: step.body }),
        ...(step.as === undefined ? {} : { as: step.as }),
        feed: step.feed ?? false,
        status: res.status,
        response
      });
    }
    return { example: setup.name, steps: results };
  } finally {
    await composed?.stop();
    await sql?.end({ timeout: 5 });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PINNED_TIME = '2026-11-03T09:00:00.000Z';

// Ids renumber by first appearance (step order, request before response) and
// server timestamps are pinned, so a run is byte-identical to the last.
export function normalise(t: Transcript): Transcript {
  const ids = new Map<string, string>();
  const walk = (v: unknown, key?: string): unknown => {
    if (key === 'createdAt' || key === 'updatedAt') return PINNED_TIME;
    if (typeof v === 'string' && UUID.test(v)) {
      let out = ids.get(v);
      if (out === undefined) {
        out = `0197a000-0000-7000-8000-${String(ids.size + 1).padStart(12, '0')}`;
        ids.set(v, out);
      }
      return out;
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
