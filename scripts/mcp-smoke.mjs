#!/usr/bin/env node
// Release smoke: an in-memory `substrate serve` driven through the built MCP
// server over stdio: schema, a mutate that creates a row, a query that reads it.
// Exits non-zero on any failure. Build first: pnpm turbo run build --filter=@mnmal-ai/substrate
//   node scripts/mcp-smoke.mjs
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import http2 from 'node:http2';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../apps/substrate/', import.meta.url));
const bin = join(app, 'dist/substrate.js');

// No identity or settings from the caller's shell reach the children.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('SUBSTRATE_') && k !== 'PORT')
);

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer().once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const url = `http://127.0.0.1:${port}`;

// The built-in plugins (proposals, recall) load from a plugin dir that depends
// on @mnmal-ai/substrate. The auth-off system actor holds only read and mutate,
// and proposals' bootstrap refuses an empty proposeCapability, so propose_type
// is closed to it: the `smoke/Note` type comes from a tiny coordinator instead.
const pluginDir = await mkdtemp(join(tmpdir(), 'substrate-mcp-smoke-'));
await writeFile(
  join(pluginDir, 'package.json'),
  JSON.stringify({
    private: true,
    dependencies: { '@mnmal-ai/substrate': '*', 'smoke-notes': '*' }
  })
);
await mkdir(join(pluginDir, 'node_modules/@mnmal-ai'), { recursive: true });
await symlink(app, join(pluginDir, 'node_modules/@mnmal-ai/substrate'), 'dir');
const notes = join(pluginDir, 'node_modules/smoke-notes');
await mkdir(notes);
await writeFile(
  join(notes, 'package.json'),
  JSON.stringify({
    name: 'smoke-notes',
    type: 'module',
    substrate: { tier: 'coordinator', entry: './index.js' }
  })
);
await writeFile(
  join(notes, 'index.js'),
  `import { defineNamespace } from '@mnmal-ai/substrate/sdk';
export default () => ({
  name: 'smoke-notes',
  contractVersion: '>=1.0.0-alpha.0 <2.0.0',
  namespaces: [defineNamespace('smoke', { Note: { fields: { title: { kind: 'scalar', type: 'string' } } } })]
});
`
);

let serveLog = '';
const serve = spawn(process.execPath, [bin, 'serve'], {
  env: {
    ...env,
    HOST: '127.0.0.1',
    PORT: String(port),
    SUBSTRATE_DATABASE_URL: 'memory',
    SUBSTRATE_PLUGIN_DIR: pluginDir,
    SUBSTRATE_SYSTEM_ACTOR: 'mcp-smoke'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
serve.stdout.on('data', (d) => (serveLog += d));
serve.stderr.on('data', (d) => (serveLog += d));

let mcp;
try {
  await waitForHealth();
  mcp = startMcp();
  await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '0' }
  });
  mcp.notify('notifications/initialized');

  const schema = await mcp.tool('schema', { namespace: 'smoke', type: 'Note' });
  check(schema.includes('createNote'), 'schema lists smoke/createNote');

  const title = `smoke ${Date.now()}`;
  const created = JSON.parse(
    await mcp.tool('mutate', {
      payload: { 'smoke/createNote': { params: { title }, fields: { id: true } } }
    })
  );
  const id = created.data?.['smoke/createNote']?.id;
  check(typeof id === 'string', `createNote returned an id: ${JSON.stringify(created)}`);

  const read = JSON.parse(
    await mcp.tool('query', {
      payload: {
        'smoke/Note': { params: { where: { id: { eq: id } } }, fields: { id: true, title: true } }
      }
    })
  );
  const rows = read.data?.['smoke/Note'];
  check(rows?.[0]?.title === title, `query read the row back: ${JSON.stringify(read)}`);
  console.log(`mcp-smoke: ok (schema, mutate, query against ${url})`);
} catch (err) {
  console.error(`mcp-smoke: FAILED: ${err instanceof Error ? err.message : err}`);
  console.error(`--- serve output ---\n${serveLog}`);
  process.exitCode = 1;
} finally {
  mcp?.child.kill();
  serve.kill();
  await rm(pluginDir, { recursive: true, force: true });
}

function check(ok, what) {
  if (!ok) throw new Error(what);
  console.log(`  ok  ${what.split(':')[0]}`);
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (serve.exitCode !== null) throw new Error(`serve exited with ${serve.exitCode}`);
    if (await healthy()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('serve did not answer /health within 30 s');
}

// The server speaks HTTP/2 only, so fetch() (HTTP/1.1) cannot probe it.
function healthy() {
  return new Promise((resolve) => {
    const session = http2.connect(url);
    session.once('error', () => resolve(false));
    const req = session.request({ ':path': '/health' });
    req.once('response', (h) => {
      resolve(h[':status'] === 200);
      session.close();
    });
    req.once('error', () => resolve(false));
    req.end();
  });
}

/** Newline-delimited JSON-RPC over the MCP server's stdio. */
function startMcp() {
  const child = spawn(process.execPath, [bin, 'mcp'], {
    env: { ...env, SUBSTRATE_URL: url },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const p = pending.get(msg.id);
    if (p === undefined) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
  });
  child.once('exit', (code) => {
    for (const p of pending.values()) p.reject(new Error(`mcp exited with ${code}`));
  });
  const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      // Unref'd, and a reject after the answer is a no-op, so it needs no clearing.
      setTimeout(() => reject(new Error(`${method}: no answer in 30 s`)), 30_000).unref();
      pending.set(id, { method, resolve, reject });
      send({ id, method, params });
    });
  return {
    child,
    request,
    notify: (method, params) => send({ method, params }),
    async tool(name, args) {
      const result = await request('tools/call', { name, arguments: args });
      const text = result.content?.map((c) => c.text ?? '').join('') ?? '';
      if (result.isError) throw new Error(`${name}: ${text}`);
      console.log(`  ok  ${name}`);
      return text;
    }
  };
}
