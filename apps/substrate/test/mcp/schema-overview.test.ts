import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { buildInstructions, schemaOverview } from '../../src/mcp/schema-overview.js';
import { createMcpServer } from '../../src/mcp/server.js';

const federated = {
  notes: {
    types: {
      Note: {
        fields: {
          title: { kind: 'scalar', type: 'string', indexed: true },
          body: { kind: 'scalar', type: 'string', indexed: false, nullable: true },
          status: { kind: 'scalar', type: 'string', enum: ['open', 'done'] },
          stage: { kind: 'scalar', type: 'string', enum: ['a', 'b'], nullable: true },
          tags: { kind: 'list', of: { kind: 'scalar', type: 'string' }, nullable: true },
          author: { kind: 'crossRef', ns: 'people', type: 'Person' },
          parent: { kind: 'crossRef', ns: 'notes', type: 'Note', nullable: true },
          meta: { kind: 'struct', fields: { a: {}, b: {} } },
          shortId: { kind: 'scalar', type: 'number', readonly: true }
        }
      }
    },
    mutations: { createNote: {}, updateNote: {}, getNote: {}, deleteNote: {}, archiveAll: {} }
  }
};

describe('schemaOverview', () => {
  it('renders each type as one line of field: type, listing only non-generated mutations', () => {
    const o = schemaOverview(federated);
    expect(o.notes?.types.Note).toBe(
      'title: string, body: string? [unindexed], status: open|done, stage: (a|b)?, tags: string[]?, ' +
        'author: →people/Person, parent: →Note?, meta: {a, b}, shortId: number [readonly]'
    );
    expect(o.notes?.mutations).toEqual(['archiveAll']);
  });
});

describe('buildInstructions', () => {
  it('carries the conventions and the overview', () => {
    const text = buildInstructions(schemaOverview(federated));
    expect(text).toContain('params.where');
    expect(text).toContain('"Note":"title: string');
  });

  it('falls back to type names when the overview is large', () => {
    const big = {
      ns: {
        types: Object.fromEntries(
          Array.from({ length: 400 }, (_, i) => [`T${i}`, 'x: string, '.repeat(5)])
        )
      }
    };
    const text = buildInstructions(big);
    expect(text).toContain('Type names only');
    expect(text.length).toBeLessThan(12_000);
  });

  it('says how to get the types when the server was unreachable', () => {
    expect(buildInstructions(null)).toContain('call `schema` with no arguments');
  });

  it('reaches the client at initialize', async () => {
    const server = createMcpServer('http://127.0.0.1:1', { instructions: 'hello agent' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect(client.getInstructions()).toBe('hello agent');
    await client.close();
  });
});
