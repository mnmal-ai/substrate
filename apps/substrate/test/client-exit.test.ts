/**
 * A short-lived process that queries through SubstrateClient exits on its own:
 * the shared HTTP/2 session does not hold the event loop open.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compose } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import { expect, it } from 'vitest';

it('a child process doing one query exits without close()', async () => {
  const server = new FastifySubstrateServer();
  const composed = await compose({
    systemActor: 'test',
    server,
    dataset: new MemoryDataset({ namespace: 'default' })
  });
  const { port } = await server.start({ host: '127.0.0.1', port: 0 });
  try {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('./fixtures/client-exit-child.mjs', import.meta.url)),
        `http://127.0.0.1:${port}`
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    const code = await new Promise<number | null>((resolve) => {
      const kill = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 8000);
      child.on('exit', (c) => {
        clearTimeout(kill);
        resolve(c);
      });
    });
    expect(out).toBe('errors 1\n');
    expect(code).toBe(0);
  } finally {
    await composed.stop();
  }
}, 15_000);
