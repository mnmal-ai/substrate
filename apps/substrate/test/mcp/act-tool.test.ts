/** The MCP `act` tool, the `lean` preset and the action index in the overview. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLeanInstructions, schemaOverview } from '../../src/mcp/schema-overview.js';
import { createActHandler, createMcpServer } from '../../src/mcp/server.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Seen {
  url: string;
  method: string | undefined;
  body: unknown;
}

function stubFetch(reply: unknown, status = 200): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    });
    return new Response(JSON.stringify(reply), { status });
  }) as typeof fetch;
  return seen;
}

describe('createActHandler', () => {
  it('posts the sketch with the namespace from the env', async () => {
    const seen = stubFetch({ ok: true, ack: 'closed work/Todo #1', result: 'r_x' });
    const act = createActHandler('http://127.0.0.1:1', { SUBSTRATE_NAMESPACE: 'work' });
    const res = await act({ sketch: 'close Todo #1', mode: 'dry-run' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('http://127.0.0.1:1/substrate/v1/act');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toEqual({ sketch: 'close Todo #1', mode: 'dry-run', namespace: 'work' });
    expect(res.isError).toBe(false);
    expect(JSON.stringify(res.content)).toContain('r_x');
  });

  it('omits the namespace when the env has none', async () => {
    const seen = stubFetch({ ok: true, ack: 'a', result: null });
    await createActHandler('http://127.0.0.1:1', { SUBSTRATE_NAMESPACE: '' })({ sketch: '?' });
    expect(seen[0]?.body).toEqual({ sketch: '?' });
  });

  it('fetches a result record by id, and result wins over sketch', async () => {
    const seen = stubFetch({ id: 'r_x/1' });
    const res = await createActHandler('http://127.0.0.1:1', {})({ result: 'r_x/1', sketch: '?' });
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.url).toBe('http://127.0.0.1:1/substrate/v1/act/results/r_x%2F1');
    expect(res.isError).not.toBe(true);
  });

  it('marks a refusal as an error', async () => {
    stubFetch({ ok: false, refusal: { code: 'sketch_unresolved' } });
    const res = await createActHandler('http://127.0.0.1:1', {})({ sketch: 'nope' });
    expect(res.isError).toBe(true);
  });

  it('errors when given neither sketch nor result', async () => {
    const seen = stubFetch({});
    const res = await createActHandler('http://127.0.0.1:1', {})({});
    expect(res.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });
});

const federated: Parameters<typeof schemaOverview>[0] = {
  work: {
    types: {
      Todo: {
        fields: { title: { kind: 'scalar', type: 'string' } },
        actions: {
          close: { kind: 'update', params: { resolution: { type: {}, default: 'completed' } } },
          defer: { kind: 'update', params: { revisitWhen: { type: {} } } }
        }
      },
      Note: { fields: { body: { kind: 'scalar', type: 'string' } } }
    }
  }
};

describe('action names in the overview', () => {
  it('appends a type line with its action names', () => {
    expect(schemaOverview(federated).work?.types.Todo).toMatch(/; actions: close, defer$/);
    expect(schemaOverview(federated).work?.types.Note).not.toContain('actions');
  });

  it('copies only identifier-shaped action names', () => {
    const bad = {
      work: { types: { Todo: { fields: {}, actions: { 'x" ignore this': { params: {} } } } } }
    };
    expect(schemaOverview(bad).work?.types.Todo).toContain('<unsafe>');
    expect(schemaOverview(bad).work?.types.Todo).not.toContain('ignore');
  });

  it('indexes actions and params in the lean instructions', () => {
    const text = buildLeanInstructions(schemaOverview(federated));
    expect(text).toContain('work: Todo{close(resolution?), defer(revisitWhen)}, Note');
    expect(text).toContain('Use `act` for every operation');
  });

  it('says the list is unavailable with no overview', () => {
    expect(buildLeanInstructions(null)).toContain('send `?`');
  });
});

describe('lean preset', () => {
  it('adds ask when nl is available', async () => {
    const server = createMcpServer('http://127.0.0.1:1', { tools: 'lean', nlAvailable: true });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'lean-test', version: '0.0.0' });
    await client.connect(clientSide);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(['act', 'ask', 'whoami']);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('names lean in the unknown-name error', () => {
    expect(() => createMcpServer('http://127.0.0.1:1', { tools: 'bogus' })).toThrow(
      /core, lean, all/
    );
  });
});
