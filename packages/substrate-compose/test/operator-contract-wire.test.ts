/**
 * The schema serves the operator contract, and the contract is TRUE: the
 * operators absent from the published list are precisely those that return
 * `unknown_operator`.
 *
 * Nothing here names an operator as expected — a hardcoded list would go stale
 * while passing. The suite reads the PUBLISHED map, generates a query per
 * (field, operator) from it, and checks the behaviour both ways:
 *
 *     published    -> the query must NOT be refused as an unknown operator
 *     not published -> the query MUST be refused
 *
 * THE ONE ASSUMPTION: with no extension operators registered, `operators`
 * alone is the exact accept set, which is what lets the negative direction be
 * exact. Extension operators are valid on EVERY kind, so with any registered
 * the accept set is `operators[kind] ∪ extensionOperators`. The fixture keeps
 * the registry empty and pins `extensionOperators` against onboard.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import type { CoordinatorPlugin } from '@mnmal-ai/substrate-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';

const NS = 'contract';
const KEY = `${NS}/Note`;

/**
 * One field of every kind the contract reports, so the generated probes cover
 * the whole published map rather than the string case twice.
 *
 * `tags` is declared `indexed: true` deliberately: list fields default to
 * unindexed, and an unindexed field is refused with `unindexed_field` BEFORE
 * the operator allowlist is consulted, so every `has` probe would fail for a
 * reason that has nothing to do with operators.
 */
const notesPlugin: CoordinatorPlugin = {
  name: 'operator-contract-fixture',
  contractVersion: '*',
  namespaces: [
    defineNamespace(NS, {
      Note: {
        fields: {
          text: field.string(),
          count: field.number(),
          flag: field.boolean(),
          when: field.date(),
          blob: field.json(),
          owner: field.crossRef(NS, 'Tag', { nullable: true }),
          tags: field.list(field.string(), { indexed: true })
        }
      },
      Tag: { fields: { label: field.string() } }
    })
  ]
};

/** Every operator any kind might claim — the universe the probes range over. */
const ALL_OPS = [
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
  'nin',
  'has'
] as const;

interface ServedField {
  kind: string;
  type?: string;
}

/** The kind key the contract is keyed by, derived as the validator derives it. */
function kindOf(def: ServedField): string {
  return def.kind === 'scalar' ? `scalar.${def.type}` : def.kind;
}

/**
 * A well-typed operand, so a probe that IS accepted is not refused for its
 * value instead. Exactness is not critical — a bad operand answers
 * `type_mismatch`, which still proves the operator was recognised — but a
 * wrong-type probe would make the accept direction pass for the wrong reason.
 */
function operandFor(kind: string, op: string): unknown {
  const sample: unknown = kind.startsWith('scalar.number')
    ? 1
    : kind === 'scalar.boolean'
      ? true
      : kind === 'scalar.date'
        ? new Date().toISOString()
        : 'x';
  if (op === 'between') return [sample, sample];
  if (op === 'in' || op === 'nin') return [sample];
  return sample;
}

interface QueryEnvelope {
  data?: Record<string, unknown>;
  errors?: Array<{ code?: string; message?: string; path?: string[] }>;
}

describe('the namespace-scoped schema carries the operator contract', () => {
  let server: FastifySubstrateServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new FastifySubstrateServer();
    await compose({
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: NS }),
      coordinators: [notesPlugin]
    });
    const { address, port } = await server.start({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://${address}:${port}`;
  });

  afterEach(async () => {
    await server.stop({ grace: 0 });
  });

  async function typeContract(): Promise<{
    fields: Record<string, ServedField>;
    operators: Record<string, string[]>;
    extensionOperators: string[];
  }> {
    const res = await fetch(`${baseUrl}/substrate/v1/schema/${NS}/Note`);
    return (await res.json()) as {
      fields: Record<string, ServedField>;
      operators: Record<string, string[]>;
      extensionOperators: string[];
    };
  }

  async function probe(
    fieldName: string,
    kind: string,
    op: string,
    operand: unknown
  ): Promise<QueryEnvelope> {
    // A json field's operators apply only inside a path predicate, so that is
    // the form its published list promises.
    const predicate = kind === 'scalar.json' ? { path: ['k'], [op]: operand } : { [op]: operand };
    const res = await fetch(`${baseUrl}/substrate/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        [KEY]: {
          params: { where: { [fieldName]: predicate }, limit: 1 },
          fields: { id: true }
        }
      })
    });
    return (await res.json()) as QueryEnvelope;
  }

  it('answers with a per-kind map beside the fields', async () => {
    const body = await typeContract();

    // Keyed by KIND, not by field name — each field already carries its kind,
    // so the caller joins the two and the map costs one copy per response.
    expect(Object.keys(body.operators).sort()).toEqual([
      'crossRef',
      'list',
      'scalar.boolean',
      'scalar.date',
      'scalar.json',
      'scalar.number',
      'scalar.string'
    ]);
    // Not an enumeration to keep in step — just that the answer is non-trivial.
    // What it CONTAINS is checked against behaviour below, not against a list.
    expect(body.operators.crossRef!.length).toBeGreaterThan(0);
    expect(body.operators['scalar.json']).toEqual(expect.arrayContaining(['eq', 'has']));
  });

  it('serves it on the namespace route too, so a caller need not fetch a type', async () => {
    const res = await fetch(`${baseUrl}/substrate/v1/schema/${NS}`);
    const body = (await res.json()) as { operators?: Record<string, string[]>; types?: unknown };

    expect(body.types).toBeDefined();
    expect(body.operators).toBeDefined();
  });

  it('reports the same extension list onboard does, under its other name', async () => {
    // onboard publishes the same set as `filterOperators`. If they ever
    // disagree, one of them is lying about what the validator will accept.
    const contract = await typeContract();
    const onboard = (await (await fetch(`${baseUrl}/substrate/v1/onboard`)).json()) as {
      filterOperators?: string[];
      instructions?: { filterOperators?: string[] };
    };
    const advertised = onboard.filterOperators ?? onboard.instructions?.filterOperators ?? [];

    expect(contract.extensionOperators).toEqual([...advertised].sort());
  });

  it('publishes exactly the accept set — checked against behaviour, both directions', async () => {
    const { fields, operators, extensionOperators } = await typeContract();
    // The exactness below depends on this being empty; see the header.
    expect(extensionOperators).toEqual([]);

    const mismatches: string[] = [];
    let probed = 0;

    for (const [fieldName, def] of Object.entries(fields)) {
      const kind = kindOf(def);
      const published = operators[kind];
      if (published === undefined) {
        mismatches.push(`${fieldName}: no published operators for kind '${kind}'`);
        continue;
      }
      for (const op of ALL_OPS) {
        probed += 1;
        const envelope = await probe(fieldName, kind, op, operandFor(kind, op));
        // `unknown_operator` is the refusal that means "this operator is not
        // available here". A `type_mismatch` means it WAS recognised and the
        // operand was wrong, which is still acceptance for this purpose.
        const refused = (envelope.errors ?? []).some(
          (e) => e.code === 'unknown_operator' || e.code === 'capability_unsupported'
        );
        const expectedRefused = !published.includes(op);
        if (refused !== expectedRefused) {
          mismatches.push(
            expectedRefused
              ? `${fieldName} (${kind}): '${op}' is absent from the published list but was ACCEPTED`
              : `${fieldName} (${kind}): '${op}' is published but was REFUSED`
          );
        }
      }
    }

    // A loop over a server-supplied list can pass by iterating NOTHING: an
    // empty `fields` leaves `mismatches` empty and the assertion below reads as
    // agreement rather than as a suite that never ran.
    expect(probed).toBe(Object.keys(fields).length * ALL_OPS.length);
    // And every PUBLISHED kind must have been exercised by some field. A count
    // alone cannot catch a fixture that quietly lost its crossRef field.
    expect(new Set(Object.values(fields).map(kindOf))).toEqual(new Set(Object.keys(operators)));

    // Listed rather than counted: which cell disagreed is the whole diagnosis,
    // and a count would say only that something moved.
    expect(mismatches).toEqual([]);
  });
});
