/** The MCP `act` tool, the `lean` preset and the action index in the overview. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildInstructions,
  buildLeanInstructions,
  schemaOverview
} from '../../src/mcp/schema-overview.js';
import { createActHandler, createMcpServer, fetchPending } from '../../src/mcp/server.js';

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

  it('leaves _system namespaces out of the lean index', () => {
    const text = buildLeanInstructions({
      ...schemaOverview(federated),
      _system_proposals: { types: { ActionProposal: 'sketch: string' } }
    });
    expect(text).toContain('work: Todo');
    expect(text).not.toContain('_system_proposals');
    expect(text).not.toContain('ActionProposal');
  });

  it('marks the caller’s pending words and adds the legend', () => {
    const overview = schemaOverview({
      shop: {
        types: {
          Ticket: {
            fields: {},
            actions: { close: { kind: 'update', params: {} } }
          },
          Order: { fields: {} }
        }
      }
    });
    const text = buildLeanInstructions(overview, {
      shop: { Ticket: ['reopen'], Order: ['ship'] }
    });
    expect(text).toContain('Ticket{close, reopen*}');
    expect(text).toContain('Order{ship*}');
    expect(text).toContain('* yours, pending');
    expect(text).toContain('`define Type.name field=value field=$ …` coins an update action');
    expect(buildLeanInstructions(overview)).not.toContain('* yours, pending');
    expect(buildLeanInstructions(overview, {})).not.toContain('* yours, pending');
  });

  it('prints no legend when the only pending marks are in a hidden namespace', () => {
    const overview = { ...schemaOverview(federated), _system_x: { types: { T: 'a: string' } } };
    expect(buildLeanInstructions(overview, { _system_x: { T: ['w'] } })).not.toContain('yours');
  });

  it('marks pending words in the core instructions too', () => {
    const overview = schemaOverview(federated);
    const text = buildInstructions(overview, {
      work: { Todo: ['reopen'], Note: ['pin'] }
    });
    expect(text).toContain('actions: close, defer, reopen*');
    expect(text).toContain('actions: pin*');
    expect(text).toContain('* yours, pending');
    expect(buildInstructions(overview)).not.toContain('* yours, pending');
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

describe('fetchPending', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a signed act ? and keeps only the starred names, unstarred', async () => {
    const seen = stubFetch({
      ok: true,
      help: {
        types: { shop: { Ticket: ['close', 'reopen*'], Order: ['ship'] } }
      }
    });
    expect(await fetchPending('http://127.0.0.1:1')).toEqual({
      shop: { Ticket: ['reopen'] }
    });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('http://127.0.0.1:1/substrate/v1/act');
    expect(seen[0]?.body).toEqual({ sketch: '?' });
  });

  it('starts without pending marks when the act ? call fails', async () => {
    stubFetch({ error: 'boom' }, 500);
    expect(await fetchPending('http://127.0.0.1:1')).toBeNull();
    stubFetch({ ok: false, refusal: { code: 'x' } });
    expect(await fetchPending('http://127.0.0.1:1')).toBeNull();
  });

  it('starts without pending marks when the act ? call is slow', async () => {
    vi.useFakeTimers();
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
    const pending = fetchPending('http://127.0.0.1:1');
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull();
  });
});
