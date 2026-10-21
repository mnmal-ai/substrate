/**
 * Schema parity test — locks `config.schema.json` against the canonical
 * `z.toJSONSchema(Schema, { io: 'input' })` output so the committed JSON
 * cannot drift from the runtime zod schema.
 *
 * `io: 'input'` matches the operator's writing surface — fields with a
 * Zod `.default(...)` are marked optional (the operator may omit them
 * and the parse fills in the default), not required-with-default. Without
 * this, an operator writing a minimal `{ embedder: { kind: 'fake',
 * dimension: 8 } }` config gets a (misleading) "missing required field"
 * signal from a schema editor for hnswM/hnswEfConstruction etc.
 *
 * To regenerate after a schema change:
 *
 *   UPDATE_SCHEMA=1 pnpm --filter @mnmal-ai/substrate-recall test
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RecallBootstrapConfigSchema } from '../src/bootstrap.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, '..', 'config.schema.json');

describe('config.schema.json parity with zod schema', () => {
  it('committed JSON matches z.toJSONSchema(Schema)', () => {
    const generated = `${JSON.stringify(z.toJSONSchema(RecallBootstrapConfigSchema, { io: 'input' }), null, 2)}\n`;

    if (process.env.UPDATE_SCHEMA === '1') {
      writeFileSync(schemaPath, generated);
    }

    const committed = readFileSync(schemaPath, 'utf8');
    expect(committed).toBe(generated);
  });
});
