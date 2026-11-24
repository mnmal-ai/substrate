/**
 * Every HTTP route the composed server registers, against a grid of grants.
 *
 * The routes are discovered from the server as `substrate serve` composes it
 * with the built-in plugins, and each must have an entry in `EXPECTED`: a route
 * with none fails the suite, so a new route cannot ship without saying who may
 * call it. Each cell asserts only admitted or refused, by status and error
 * code. `in: 'any'` is the HTTP gate's own question, "is the capability held in
 * some namespace"; the frame streams answer per key in-band after that, which
 * this grid does not read.
 */

import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type AuthConfig, signHs256 } from '@mnmal-ai/substrate-compose';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import type { CoordinatorPlugin, HttpMethod, PluginRouter } from '@mnmal-ai/substrate-types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type BootedStore, bootStore } from '../src/serve/boot-store.js';
import { parseEnv } from '../src/serve/config.js';

const TARGET = 'grid';
const OTHER = 'elsewhere';

const gridPlugin = (name: string, ns: string): CoordinatorPlugin =>
  ({
    name,
    contractVersion: '>=1.0.0-alpha.0 <2.0.0',
    namespaces: [defineNamespace(ns, { Note: { fields: { text: field.string() } } })]
  }) as unknown as CoordinatorPlugin;

// The built-in plugins load from this package's manifest, their entries from source.
vi.mock('../src/plugin-dir-loader.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/plugin-dir-loader.js')>();
  return {
    ...real,
    loadPluginsFromDir: async (opts: Parameters<typeof real.loadPluginsFromDir>[0]) => {
      const loaded = await real.loadPluginsFromDir({
        ...opts,
        importResolver: (entry) => {
          if (entry.endsWith('recall-bootstrap.js')) {
            return import('../src/exports/recall-bootstrap.js');
          }
          if (entry.endsWith('proposals-bootstrap.js')) {
            return import('../src/exports/proposals-bootstrap.js');
          }
          throw new Error(`no source for plugin entry ${entry}`);
        }
      });
      return {
        ...loaded,
        coordinators: [
          ...loaded.coordinators,
          gridPlugin('grid-target', TARGET),
          gridPlugin('grid-other', OTHER)
        ]
      };
    }
  };
});

const SECRET = 'route-grid-secret-long-enough-for-hs256';
const KID = 'route-grid';
const auth: AuthConfig = {
  mode: 'required',
  keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }]
};

type Route = { method: HttpMethod; path: string };
const routes: Route[] = [];
let booted: BootedStore;
let pluginDir: string;

beforeAll(async () => {
  // Core and kernel routes go through `route`, plugin routes through a plugin router.
  const proto = FastifySubstrateServer.prototype;
  const route = proto.route;
  vi.spyOn(proto, 'route').mockImplementation(function (this: FastifySubstrateServer, m, p, h) {
    routes.push({ method: m, path: p });
    return route.call(this, m, p, h);
  });
  const createPluginRouter = proto.createPluginRouter;
  vi.spyOn(proto, 'createPluginRouter').mockImplementation(function (
    this: FastifySubstrateServer,
    plugin
  ) {
    const router = createPluginRouter.call(this, plugin);
    const seen =
      (method: HttpMethod, verb: keyof PluginRouter): PluginRouter['get'] =>
      (path, h) => {
        const sub = path.length === 0 ? '/' : path.startsWith('/') ? path : `/${path}`;
        routes.push({ method, path: `/substrate/v1/plugins/${plugin.name}${sub}` });
        return router[verb](path, h);
      };
    return {
      ...router,
      get: seen('GET', 'get'),
      post: seen('POST', 'post'),
      put: seen('PUT', 'put'),
      delete: seen('DELETE', 'delete'),
      patch: seen('PATCH', 'patch')
    };
  });

  pluginDir = await mkdtemp(join(tmpdir(), 'substrate-route-grid-'));
  await writeFile(
    join(pluginDir, 'package.json'),
    JSON.stringify({ dependencies: { '@mnmal-ai/substrate': '*' } })
  );
  await mkdir(join(pluginDir, 'node_modules', '@mnmal-ai'), { recursive: true });
  await symlink(resolve('.'), join(pluginDir, 'node_modules', '@mnmal-ai', 'substrate'));

  booted = await bootStore({
    config: { ...parseEnv({ SUBSTRATE_SYSTEM_ACTOR: 'route-grid' }), auth },
    pluginDir,
    background: false
  });
});

afterAll(async () => {
  await booted?.close();
  vi.restoreAllMocks();
  if (pluginDir !== undefined) await rm(pluginDir, { recursive: true, force: true });
});

type Cap = 'read' | 'mutate' | 'admin';
const CAPS: Cap[] = ['read', 'mutate', 'admin'];
type Grant = Record<string, Cap[]>;

/** Who a request needs to be: nobody, or a holder of `needs` in `in`. */
type Need =
  | { needs: 'public' }
  | {
      needs: Cap;
      /** Some namespace, the one the request names, a fixed one, or every one. */
      in: 'any' | 'target' | 'everywhere' | { namespace: string };
    };
type Case = Need & {
  /** Tells a route's cases apart in the test name. */
  label?: string;
  body?: unknown;
};

const NOTE_ID = '0f9a1c22-1111-4111-8111-111111111111';
const publicKey = generateKeyPairSync('ed25519')
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();
const drop = { namespace: TARGET, confirm: TARGET, dryRun: true };
const systemAdmin = { needs: 'admin', in: { namespace: '_system' } } as const;
const ref = { namespace: TARGET, type: 'Note', id: NOTE_ID };
const noteField = { namespace: TARGET, type: 'Note', field: 'text' };

const EXPECTED: Record<string, Case | Case[]> = {
  'GET /health': { needs: 'public' },
  'GET /substrate/v1/whoami': { needs: 'public' },
  // The invite code is the credential.
  'POST /substrate/v1/_system/register': { needs: 'public' },

  'GET /substrate/v1/schema': { needs: 'read', in: 'any' },
  'GET /substrate/v1/schema/:namespace': { needs: 'read', in: 'any' },
  'GET /substrate/v1/schema/:namespace/:type': { needs: 'read', in: 'any' },
  'GET /substrate/v1/federated-schema': { needs: 'read', in: 'any' },
  'GET /substrate/v1/onboard': { needs: 'read', in: 'any' },
  'GET /substrate/v1/metrics': { needs: 'read', in: 'any' },
  'GET /substrate/v1/act/results/:id': { needs: 'read', in: 'any' },
  'POST /substrate/v1/stream': { needs: 'read', in: 'any' },
  'POST /substrate/v1/subscribe': { needs: 'read', in: 'any' },
  // Admitted with admin anywhere; the handler then shows only the caller's namespaces.
  'GET /substrate/v1/errors': { needs: 'admin', in: 'any' },

  'POST /substrate/v1/query': {
    needs: 'read',
    in: 'target',
    body: { [`${TARGET}/Note`]: { fields: { id: true } } }
  },
  'POST /substrate/v1/mutate': {
    needs: 'mutate',
    in: 'target',
    body: { [`${TARGET}/createNote`]: { params: { text: 'x' }, fields: { id: true } } }
  },
  'POST /substrate/v1/act': [
    {
      label: 'a read',
      needs: 'read',
      in: 'target',
      body: { sketch: `find ${TARGET}/Note` }
    },
    {
      label: 'a write',
      needs: 'mutate',
      in: 'target',
      body: { sketch: `create ${TARGET}/Note text=x` }
    }
  ],

  'POST /substrate/v1/_system/invites': {
    ...systemAdmin,
    body: { namespaces: [TARGET], capabilities: ['read'] }
  },
  'GET /substrate/v1/_system/keys': systemAdmin,
  'POST /substrate/v1/_system/keys': {
    ...systemAdmin,
    body: { kid: 'grid@example', publicKey, namespaces: [TARGET], capabilities: ['read'] }
  },
  'PATCH /substrate/v1/_system/keys': {
    ...systemAdmin,
    body: { kid: 'grid@example', revoke: true }
  },
  'GET /substrate/v1/config': { needs: 'admin', in: 'everywhere' },
  'POST /substrate/v1/_system/promote-fields': { needs: 'admin', in: 'everywhere' },
  'POST /substrate/v1/_system/drop-namespace': { needs: 'admin', in: 'target', body: drop },
  'POST /substrate/v1/_system/drop-type': {
    needs: 'admin',
    in: 'target',
    body: { ...drop, type: 'Note', confirm: 'Note' }
  },
  'POST /substrate/v1/_system/normalise-vocab': { needs: 'admin', in: 'target', body: noteField },
  'POST /substrate/v1/_system/backfill-field': { needs: 'admin', in: 'target', body: noteField },

  'POST /substrate/v1/recall': {
    needs: 'read',
    in: 'target',
    body: { query: 'x', namespace: TARGET, type: 'Note' }
  },
  'GET /substrate/v1/embed-stats': { needs: 'read', in: 'any' },
  'POST /substrate/v1/embeddings/fetch': {
    needs: 'read',
    in: 'target',
    body: { refs: [ref], model: 'm' }
  },
  'POST /substrate/v1/salience/boost': { needs: 'mutate', in: 'target', body: { targets: [ref] } },
  'POST /substrate/v1/crystallise': {
    needs: 'mutate',
    in: 'target',
    body: { select: { scopes: [{ namespace: TARGET, type: 'Note' }] } }
  },
  'POST /substrate/v1/embed/reindex': {
    needs: 'admin',
    in: 'target',
    body: { namespace: TARGET, type: 'Note' }
  },
  'POST /substrate/v1/lexical/reindex': {
    needs: 'admin',
    in: 'target',
    body: { namespace: TARGET, type: 'Note' }
  },
  'GET /substrate/v1/plugins/substrate-proposals/onboard': {
    needs: 'read',
    in: { namespace: '_system_proposals' }
  }
};

/** Each caller's grant, as `{ namespace: capabilities }`; `null` sends no token. */
const CALLERS: Record<string, Grant | null> = {
  'no token': null,
  'read in the target': { [TARGET]: ['read'] },
  'mutate in the target': { [TARGET]: ['read', 'mutate'] },
  'admin in the target': { [TARGET]: CAPS },
  'admin in another namespace': { [OTHER]: CAPS },
  'admin in every namespace': { '*': CAPS }
};

function admits(need: Need, grant: Grant | null): boolean {
  if (need.needs === 'public') return true;
  if (grant === null) return false;
  const cap = need.needs;
  if (need.in === 'any') return Object.values(grant).some((caps) => caps.includes(cap));
  if (need.in === 'everywhere') return (grant['*'] ?? []).includes(cap);
  const ns = need.in === 'target' ? TARGET : need.in.namespace;
  return (grant[ns] ?? grant['*'] ?? []).includes(cap);
}

function headersFor(grant: Grant | null): Record<string, string> {
  if (grant === null) return {};
  const exp = Math.floor(Date.now() / 1000) + 60;
  const capabilities = [...new Set(Object.values(grant).flat())];
  const token = signHs256({ sub: 'grid', exp, capabilities, ns: Object.keys(grant) }, SECRET, {
    kid: KID
  });
  return { authorization: `Bearer ${token}` };
}

/**
 * Refusal codes a frame route answers in-band, under a 200. `act` compiles
 * against the schema the caller may read, so a type in a namespace outside the
 * grant is `sketch_unresolved`, the same answer as a type that does not exist.
 */
const REFUSED_IN_BAND = new Set([
  'unauthorized_namespace',
  'unauthorized_capability',
  'sketch_unresolved'
]);

async function call(route: Route, c: Case, grant: Grant | null) {
  const res = await booted.server.inject({
    method: route.method,
    path: route.path.replace(':namespace', TARGET).replace(':type', 'Note').replace(':id', NOTE_ID),
    headers: { 'content-type': 'application/json', ...headersFor(grant) },
    ...(route.method === 'GET' ? {} : { body: Buffer.from(JSON.stringify(c.body ?? {})) })
  });
  type Coded = { code?: string };
  let parsed: { errors?: Coded[]; error?: Coded; refusal?: Coded } = {};
  try {
    parsed = JSON.parse(String(res.body ?? ''));
  } catch {
    // Not JSON: only the status speaks.
  }
  const inBand = [...(parsed.errors ?? []), parsed.error, parsed.refusal].some((e) =>
    REFUSED_IN_BAND.has(e?.code ?? '')
  );
  return { refused: res.status === 401 || res.status === 403 || inBand, status: res.status };
}

describe('route authorization grid', () => {
  it('has an expectation for every registered route, and no stale one', () => {
    const registered = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(registered).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [key, entry] of Object.entries(EXPECTED)) {
    const [method, path] = key.split(' ') as [HttpMethod, string];
    for (const c of Array.isArray(entry) ? entry : [entry]) {
      const name = c.label === undefined ? key : `${key} (${c.label})`;
      for (const [who, grant] of Object.entries(CALLERS)) {
        const cell = `${name}: ${who}`;
        it(cell, async () => {
          const got = await call({ method, path }, c, grant);
          expect(got).toMatchObject({ refused: !admits(c, grant) });
          // An admitted request that fails inside the handler says nothing about the gate.
          if (!got.refused) expect(got.status).toBeLessThan(500);
        });
      }
    }
  }
});
