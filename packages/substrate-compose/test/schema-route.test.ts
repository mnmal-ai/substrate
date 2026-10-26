import type { Engine } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { FilterCapabilities, Schema } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';
import { schemaForNamespaceRoute, schemaForTypeRoute, schemaRoute } from '../src/routes/schema.js';

/**
 * `GET /substrate/v1/schema` serves the default namespace only — a pre-federation
 * compatibility surface. A deployment need not host that namespace, and that
 * configuration fact must not render as a server fault.
 */

function stubSchema(ns: string): Schema {
  return { schemaVersion: `v-${ns}`, types: {}, mutations: {} };
}

/**
 * A dataset that runs everything the validator recognises — which is what both
 * shipped substrates declare. The routes read the operator contract off the
 * namespace's dataset, so a stub without one throws.
 */
const CAPS: FilterCapabilities = {
  operators: {
    'scalar.number': ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'nin'],
    'scalar.string': [
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
      'between',
      'contains',
      'startsWith',
      'endsWith',
      'in',
      'nin'
    ],
    'scalar.boolean': ['eq'],
    'scalar.date': ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'nin'],
    'scalar.json': [],
    crossRef: ['eq', 'neq', 'in', 'nin'],
    list: ['has']
  },
  orderBy: true,
  cursor: true
};

/** Minimal engine: only the methods these routes touch. */
function engineWith(namespaces: string[]): Engine {
  const hosted = new Set(namespaces);
  return {
    schemaFor(ns: string): Schema {
      if (!hosted.has(ns)) throw new Error(`unknown namespace '${ns}'`);
      return stubSchema(ns);
    },
    federatedSchema(): Record<string, Schema> {
      return Object.fromEntries(namespaces.map((ns) => [ns, stubSchema(ns)]));
    },
    datasetFor(ns: string): { capabilities: FilterCapabilities } | undefined {
      return hosted.has(ns) ? { capabilities: CAPS } : undefined;
    },
    listFilterOperators(): ReadonlyArray<string> {
      return [];
    }
  } as unknown as Engine;
}

const REQ = {
  method: 'GET',
  path: '/substrate/v1/schema',
  headers: {},
  query: {},
  params: {},
  body: null
} as const;

describe('GET /substrate/v1/schema', () => {
  it('serves the default namespace when the deployment hosts it', async () => {
    const res = await schemaRoute(engineWith(['default', 'journal']), 'default')({ ...REQ });

    expect(res.status).toBe(200);
    expect(JSON.parse(String(res.body))).toMatchObject({ schemaVersion: 'v-default' });
  });

  it('404s rather than 500s when the default namespace is not hosted', async () => {
    // The status is the whole point. A 500 says the server failed; nothing
    // failed — the caller asked for a namespace this deployment does not host,
    // which is enumerable and expected.
    const res = await schemaRoute(engineWith(['journal', 'board']), 'default')({ ...REQ });

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(500);
  });

  it('names what IS available, so the miss is self-correcting', async () => {
    // Matches the sibling route's `availableTypes` contract: a 404 that only
    // says "no" sends the caller back to guess. Sorted so the response is
    // stable to diff and to snapshot.
    const res = await schemaRoute(
      engineWith(['board', 'journal', '_system']),
      'default'
    )({
      ...REQ
    });
    const body = JSON.parse(String(res.body)) as {
      error: string;
      availableNamespaces: string[];
      hint: string;
    };

    expect(body.error).toContain("unknown namespace 'default'");
    expect(body.availableNamespaces).toEqual(['_system', 'board', 'journal']);
    expect(body.hint).toContain('/substrate/v1/federated-schema');
  });

  it('refuses a namespace query parameter rather than answering about `default`', async () => {
    // `?namespace=journal` must not fall through to the default lookup: a 404
    // naming 'default' in answer to a request that said `journal` reads as
    // "journal is missing".
    const res = await schemaRoute(
      engineWith(['journal']),
      'default'
    )({ ...REQ, query: { namespace: 'journal' } });

    expect(res.status).toBe(400);
    const body = JSON.parse(String(res.body));
    expect(body.error).not.toContain('default');
    expect(body.hint).toBe('Use GET /substrate/v1/schema/journal');
  });

  it('routes a namespace+type pair to the type form', async () => {
    const res = await schemaRoute(
      engineWith(['journal']),
      'default'
    )({ ...REQ, query: { namespace: 'journal', type: 'SessionLog' } });

    expect(JSON.parse(String(res.body)).hint).toBe(
      'Use GET /substrate/v1/schema/journal/SessionLog'
    );
  });

  it('refuses even when the deployment DOES host the default namespace', async () => {
    // The silent path is worse here, not better: it answers 200 with the wrong
    // namespace's schema, and nothing in the response says so.
    const res = await schemaRoute(
      engineWith(['default', 'journal']),
      'default'
    )({ ...REQ, query: { namespace: 'journal' } });

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(200);
  });

  it('still serves the default namespace when no query parameters are sent', async () => {
    // The refusal must be conditioned on the caller actually naming something —
    // an empty query string is the ordinary case and has to keep working.
    const res = await schemaRoute(engineWith(['default']), 'default')({ ...REQ, query: {} });

    expect(res.status).toBe(200);
  });

  it('reports the configured default namespace, not a hardcoded one', async () => {
    // The binary names it via SUBSTRATE_NAMESPACE, so the message has to echo whatever
    // this deployment was configured with or it sends the reader hunting for
    // a namespace nobody asked for.
    const res = await schemaRoute(engineWith(['journal']), 'legacy-ns')({ ...REQ });

    expect(JSON.parse(String(res.body)).error).toContain("unknown namespace 'legacy-ns'");
  });
});

/**
 * `GET /substrate/v1/schema/:ns/:type?shape=` — trimming over-exposition on named
 * type inspection.
 *
 * For an autoCRUD type the mutations restate the field block five times over
 * (get.returns, create.params, create.returns, update.params, update.returns),
 * so the default answer to "what fields does this type have" costs about six
 * times the question, widening with every field added.
 */

const TODO_FIELDS = {
  id: { kind: 'scalar', type: 'string' },
  title: { kind: 'scalar', type: 'string' },
  note: { kind: 'scalar', type: 'string', nullable: true }
};
const TODO_ROW = { kind: 'struct', fields: TODO_FIELDS };
const DECISION_FIELDS = {
  id: { kind: 'scalar', type: 'string' },
  rationale: { kind: 'scalar', type: 'string' }
};
const DECISION_ROW = { kind: 'struct', fields: DECISION_FIELDS };

/** A type whose mutations inline the field block, as autoCRUD's do. */
function engineWithType(extraMutations: Record<string, unknown> = {}): Engine {
  const schema = {
    schemaVersion: 'v-journal',
    types: { Todo: { fields: TODO_FIELDS }, Decision: { fields: DECISION_FIELDS } },
    mutations: {
      getTodo: { params: { id: { kind: 'scalar', type: 'string' } }, returns: TODO_ROW },
      createTodo: { params: TODO_FIELDS, returns: TODO_ROW },
      updateTodo: { params: TODO_FIELDS, returns: TODO_ROW },
      // Another type's mutation: present to prove it is not listed under Todo.
      createDecision: { params: {}, returns: DECISION_ROW },
      ...extraMutations
    }
  } as unknown as Schema;
  return {
    schemaFor(ns: string): Schema {
      if (ns !== 'journal') throw new Error(`unknown namespace '${ns}'`);
      return schema;
    },
    federatedSchema(): Record<string, Schema> {
      return { journal: schema };
    },
    datasetFor(ns: string): { capabilities: FilterCapabilities } | undefined {
      return ns === 'journal' ? { capabilities: CAPS } : undefined;
    },
    listFilterOperators(): ReadonlyArray<string> {
      return [];
    }
  } as unknown as Engine;
}

const TYPE_REQ = {
  ...REQ,
  path: '/substrate/v1/schema/journal/Todo',
  params: { namespace: 'journal', type: 'Todo' }
} as const;

describe('GET /substrate/v1/schema/:namespace/:type — shape projection', () => {
  it('defaults to the full write contract, so existing callers are unaffected', async () => {
    const res = await schemaForTypeRoute(engineWithType())({ ...TYPE_REQ });
    const body = JSON.parse(String(res.body));

    expect(res.status).toBe(200);
    expect(Object.keys(body.mutations).sort()).toEqual(['createTodo', 'getTodo', 'updateTodo']);
    expect(body.mutationNames).toBeUndefined();
  });

  it('shape=fields drops the mutations and keeps the field defs intact', async () => {
    const res = await schemaForTypeRoute(engineWithType())({
      ...TYPE_REQ,
      query: { shape: 'fields' }
    });
    const body = JSON.parse(String(res.body));

    expect(res.status).toBe(200);
    expect(body.fields).toMatchObject({ title: { kind: 'scalar', type: 'string' } });
    expect(body.mutations).toBeUndefined();
  });

  it('shape=fields still names the mutations — you cannot write without knowing them', async () => {
    const res = await schemaForTypeRoute(engineWithType())({
      ...TYPE_REQ,
      query: { shape: 'fields' }
    });

    expect(JSON.parse(String(res.body)).mutationNames).toEqual([
      'createTodo',
      'getTodo',
      'updateTodo'
    ]);
  });

  it('is materially smaller — the point of the projection, asserted not assumed', async () => {
    const engine = engineWithType();
    const full = await schemaForTypeRoute(engine)({ ...TYPE_REQ });
    const fieldsOnly = await schemaForTypeRoute(engine)({
      ...TYPE_REQ,
      query: { shape: 'fields' }
    });

    // The namespace-wide contract (operators, metadata names) is identical in
    // both shapes, so compare what the projection actually changes.
    const perType = (body: unknown): number => {
      const {
        operators: _o,
        extensionOperators: _e,
        metadataFields: _m,
        metadataAuthorFields: _a,
        ...rest
      } = JSON.parse(String(body));
      return JSON.stringify(rest).length;
    };
    expect(perType(fieldsOnly.body) * 2).toBeLessThan(perType(full.body));
  });

  it('REFUSES an unknown shape rather than ignoring it — a wrong guess must not look like it worked', async () => {
    const res = await schemaForTypeRoute(engineWithType())({
      ...TYPE_REQ,
      query: { shape: 'feilds' }
    });
    const body = JSON.parse(String(res.body));

    expect(res.status).toBe(400);
    expect(body.allowedShapes).toEqual(['full', 'fields']);
    expect(body.error).toContain('feilds');
  });

  it('shape=full is accepted explicitly, not only by omission', async () => {
    const res = await schemaForTypeRoute(engineWithType())({
      ...TYPE_REQ,
      query: { shape: 'full' }
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(String(res.body)).mutations).toBeDefined();
  });

  it('an unknown type still 404s and names what IS available, whatever the shape', async () => {
    const res = await schemaForTypeRoute(engineWithType())({
      ...TYPE_REQ,
      params: { namespace: 'journal', type: 'Nope' },
      query: { shape: 'fields' }
    });

    expect(res.status).toBe(404);
    expect(JSON.parse(String(res.body)).availableTypes).toEqual(['Decision', 'Todo']);
  });
});

describe('GET /substrate/v1/schema/:namespace/:type — which mutations belong to the type', () => {
  const namesFor = async (extra: Record<string, unknown>): Promise<string[]> => {
    const res = await schemaForTypeRoute(engineWithType(extra))({
      ...TYPE_REQ,
      query: { shape: 'fields' }
    });
    return JSON.parse(String(res.body)).mutationNames;
  };

  it('lists a mutation whose name continues past the type name when it returns the type row', async () => {
    const names = await namesFor({
      markTodoRead: { params: {}, returns: { ...TODO_ROW, nullable: true } }
    });
    expect(names).toContain('markTodoRead');
  });

  it('lists a mutation returning a list of the type row', async () => {
    const names = await namesFor({
      sendTodos: { params: {}, returns: { kind: 'list', of: TODO_ROW } }
    });
    expect(names).toContain('sendTodos');
  });

  it('lists any lowercase verb followed by exactly the type name, whatever it returns', async () => {
    const names = await namesFor({
      purgeTodo: {
        params: {},
        returns: { kind: 'struct', fields: { purged: { kind: 'scalar', type: 'number' } } }
      }
    });
    expect(names).toContain('purgeTodo');
  });

  it('does not list another type’s mutation whose name merely ends in this type name', async () => {
    const names = await namesFor({
      createSubTodo: { params: {}, returns: DECISION_ROW }
    });
    expect(names).not.toContain('createSubTodo');
    expect(names).not.toContain('createDecision');
  });
});

/**
 * A namespace can be hosted and still own no dataset — bridges and virtual
 * namespaces are the live cases. There is then no capability declaration to
 * intersect, and therefore nothing truthful to publish.
 */
function engineWithoutDataset(): Engine {
  const schema = {
    schemaVersion: 'v-bridged',
    types: { Todo: { fields: { id: { kind: 'scalar', type: 'string' } } } },
    mutations: {}
  } as unknown as Schema;
  return {
    schemaFor(ns: string): Schema {
      if (ns !== 'journal') throw new Error(`unknown namespace '${ns}'`);
      return schema;
    },
    federatedSchema(): Record<string, Schema> {
      return { journal: schema };
    },
    datasetFor(): undefined {
      return undefined;
    },
    listFilterOperators(): ReadonlyArray<string> {
      return [];
    }
  } as unknown as Engine;
}

describe('the operator contract omits itself rather than lying', () => {
  it('leaves the keys ABSENT when the namespace has no dataset', async () => {
    // Absent is UNKNOWN. An empty `{}` would read as "no operators work here",
    // which is a claim this server is in no position to make — the same
    // distinction `_enumVerdicts` draws on the federated route, where a missing
    // key means the caller may simply lack the read rather than that nothing
    // was verified.
    const res = await schemaForTypeRoute(engineWithoutDataset())({ ...TYPE_REQ });
    const body = JSON.parse(String(res.body));

    expect(res.status).toBe(200);
    expect(body.fields).toBeDefined();
    expect(body).not.toHaveProperty('operators');
    expect(body).not.toHaveProperty('extensionOperators');
    expect(body).not.toHaveProperty('metadataFields');
    expect(body).not.toHaveProperty('metadataAuthorFields');
  });

  it('still serves the contract when the dataset IS there', async () => {
    // The guard above must be conditioned on the dataset's absence, not on
    // something incidental that would silently suppress the key everywhere.
    const res = await schemaForTypeRoute(engineWithType())({ ...TYPE_REQ });
    const body = JSON.parse(String(res.body));

    expect(body.operators).toBeDefined();
    expect(body.operators.crossRef).toEqual(['eq', 'in', 'neq', 'nin']);
  });
});

describe('the metadata filter names are published beside the operators', () => {
  const NS_REQ = {
    ...REQ,
    path: '/substrate/v1/schema/journal',
    params: { namespace: 'journal' }
  } as const;

  for (const [label, run] of [
    [
      'GET /substrate/v1/schema/<ns>/<Type>',
      () => schemaForTypeRoute(engineWithType())({ ...TYPE_REQ })
    ],
    [
      'GET /substrate/v1/schema/<ns>',
      () => schemaForNamespaceRoute(engineWithType())({ ...NS_REQ })
    ]
  ] as const) {
    it(label, async () => {
      const body = JSON.parse(String((await run()).body));

      expect(Object.keys(body.metadataFields).sort()).toEqual([
        'createdAt',
        'createdById',
        'createdByKind',
        'id',
        'seq',
        'updatedAt',
        'updatedById',
        'updatedByKind'
      ]);
      expect(body.metadataFields.createdById).toMatchObject({ kind: 'scalar', type: 'string' });
      expect(body.metadataAuthorFields).toEqual({
        createdBy: { id: 'createdById', kind: 'createdByKind' },
        updatedBy: { id: 'updatedById', kind: 'updatedByKind' }
      });
    });
  }
});

describe('namespace annotations on the wire', () => {
  it('GET /substrate/v1/schema/<ns> returns annotations from a composed namespace', async () => {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'ann' }),
      coordinators: [
        {
          name: 'ann-plugin',
          contractVersion: '*',
          namespaces: [
            defineNamespace(
              'ann',
              { T: { fields: { name: field.string() } } },
              { annotations: { nl: { x: 1 } } }
            )
          ]
        }
      ]
    });
    await server.start();
    try {
      const res = await server.inject({
        method: 'GET',
        path: '/substrate/v1/schema/ann',
        headers: {}
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(String(res.body)) as Schema;
      expect(body.annotations).toEqual({ nl: { x: 1 } });
    } finally {
      await composed.stop();
    }
  });
});
