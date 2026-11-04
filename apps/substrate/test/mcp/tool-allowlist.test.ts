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
  it('registers every tool when unset', async () => {
    expect(await listedTools()).toHaveLength(11);
  });

  it('registers only the named tools', async () => {
    expect(await listedTools('query, recall')).toEqual(['query', 'recall']);
  });

  it('treats an empty value as unset rather than as "no tools"', async () => {
    expect(await listedTools('  ')).toHaveLength(11);
  });

  it('refuses an unknown tool name, naming the valid ones', () => {
    expect(() => createMcpServer('http://127.0.0.1:1', { tools: 'query,substrate_qeury' })).toThrow(
      /unknown tool 'substrate_qeury'.*query/s
    );
  });
});
