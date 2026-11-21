/**
 * SUBSTRATE_MCP_TOOLS narrows which tools the stdio MCP server registers.
 *
 * Every registered tool's definition is sent with every model call, so an
 * agent that only queries and recalls should not carry the rest. An unknown
 * name fails loudly
 * at startup — a typo that silently registered nothing would read as "the
 * server has no such tool".
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.js';

async function listedTools(tools?: string): Promise<string[]> {
  const server = createMcpServer('http://127.0.0.1:1', tools === undefined ? {} : { tools });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'allowlist-test', version: '0.0.0' });
  await client.connect(clientSide);
  try {
    const { tools: listed } = await client.listTools();
    return listed.map((t) => t.name).sort();
  } finally {
    await client.close();
    await server.close();
  }
}

describe('SUBSTRATE_MCP_TOOLS', () => {
  it('registers the core set when unset', async () => {
    expect(await listedTools()).toEqual(await listedTools('core'));
  });

  it('core registers the worker set', async () => {
    expect(await listedTools('core')).toEqual([
      'mutate',
      'query',
      'recall',
      'run',
      'schema',
      'whoami'
    ]);
  });

  it('all registers every tool', async () => {
    expect(await listedTools('all')).toHaveLength(13);
  });

  it('mixes a preset with named tools', async () => {
    const mixed = await listedTools('core,propose_type');
    expect(mixed).toContain('propose_type');
    expect(mixed).toHaveLength(7);
    expect(await listedTools('all,query')).toHaveLength(13);
  });

  it('registers only the named tools', async () => {
    expect(await listedTools('query, recall')).toEqual(['query', 'recall']);
  });

  it('treats a blank value as unset rather than as "no tools"', async () => {
    expect(await listedTools('  ')).toEqual(await listedTools('core'));
  });

  it('refuses an unknown tool name, naming the valid ones', () => {
    expect(() => createMcpServer('http://127.0.0.1:1', { tools: 'query,substrate_qeury' })).toThrow(
      /unknown tool 'substrate_qeury'.*query/s
    );
  });
});
