/**
 * The MCP server's fixed per-session cost: the default tool definitions plus
 * the instructions' conventions. A small-context model pays it on every turn.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { buildInstructions } from '../../src/mcp/schema-overview.js';
import { createMcpServer } from '../../src/mcp/server.js';

async function listTools(): Promise<Array<{ name: string }>> {
  const server = createMcpServer('http://127.0.0.1:1', {});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'budget-test', version: '0.0.0' });
  await client.connect(clientSide);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe('MCP context budget', () => {
  it('each core tool definition fits its budget', async () => {
    for (const t of await listTools()) {
      const bytes = Buffer.byteLength(JSON.stringify(t));
      expect(bytes, t.name).toBeLessThanOrEqual(t.name === 'query' ? 1800 : 1200);
    }
  });

  it('the core set plus the fixed instructions stays under 9 KB', async () => {
    const total =
      Buffer.byteLength(JSON.stringify(await listTools())) +
      Buffer.byteLength(buildInstructions(null));
    expect(total).toBeLessThanOrEqual(9000);
  });
});
