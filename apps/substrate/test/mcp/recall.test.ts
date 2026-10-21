import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer, recall } from '../../src/mcp/server.js';

const BASE = 'http://localhost:19999';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('recall', () => {
  it('forwards to /substrate/v1/recall and returns the body', async () => {
    server.use(
      http.post(`${BASE}/substrate/v1/recall`, async ({ request }) => {
        const body = (await request.json()) as { query: string };
        expect(body.query).toBe('auth token rotation');
        return HttpResponse.json({
          rows: [{ row: { id: 'd1', topic: 'auth' }, score: 0.91 }],
          model: 'bge-small-en:v1.5:384'
        });
      })
    );
    const result = await recall(BASE, { query: 'auth token rotation', k: 5 });
    expect(result.rows).toHaveLength(1);
    expect(result.model).toBe('bge-small-en:v1.5:384');
  });

  it('forwards threshold and lexicalThreshold in the body', async () => {
    let seen: Record<string, unknown> | undefined;
    server.use(
      http.post(`${BASE}/substrate/v1/recall`, async ({ request }) => {
        seen = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ rows: [], model: 'm' });
      })
    );
    await recall(BASE, { query: 'q', threshold: 0.6, lexicalThreshold: 0 });
    expect(seen).toMatchObject({ threshold: 0.6, lexicalThreshold: 0 });
  });

  it('forwards where in the body', async () => {
    let seen: Record<string, unknown> | undefined;
    server.use(
      http.post(`${BASE}/substrate/v1/recall`, async ({ request }) => {
        seen = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ rows: [], model: 'm' });
      })
    );
    const where = { project: { in: ['substrate', null] } };
    await recall(BASE, { query: 'q', where });
    expect(seen).toMatchObject({ where });
  });

  it('the registered tool admits where and forwards it to the route', async () => {
    let seen: Record<string, unknown> | undefined;
    server.use(
      http.post(`${BASE}/substrate/v1/recall`, async ({ request }) => {
        seen = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ rows: [], model: 'm' });
      })
    );
    const mcp = createMcpServer(BASE, { tools: 'recall' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const client = new Client({ name: 'recall-where-test', version: '0.0.0' });
    await client.connect(clientSide);
    try {
      const listed = await client.listTools();
      const props = (listed.tools[0]?.inputSchema.properties ?? {}) as Record<string, unknown>;
      expect(props.where).toBeDefined();
      const where = { project: { eq: 'substrate' } };
      const res = await client.callTool({
        name: 'recall',
        arguments: { query: 'q', namespace: 'notes', type: 'Note', where }
      });
      expect(res.isError).not.toBe(true);
      expect(seen).toMatchObject({ query: 'q', where });
    } finally {
      await client.close();
      await mcp.close();
    }
  });

  it('surfaces a flat { code, message } 400 by its message', async () => {
    server.use(
      http.post(`${BASE}/substrate/v1/recall`, () =>
        HttpResponse.json(
          { code: 'bad_request', message: '"where" must be an object of field -> { eq } | { in }' },
          { status: 400 }
        )
      )
    );
    await expect(recall(BASE, { query: 'x', where: { project: 'b' } })).rejects.toThrow(
      /"where" must be an object/
    );
  });

  it('surfaces 503 from server as MCP tool error', async () => {
    server.use(
      http.post(`${BASE}/substrate/v1/recall`, () =>
        HttpResponse.json(
          { error: { code: 'embedder_unavailable', message: 'ollama down' } },
          { status: 503 }
        )
      )
    );
    await expect(recall(BASE, { query: 'x' })).rejects.toThrow(/ollama down/);
  });
});
