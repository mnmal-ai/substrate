/**
 * Locks the committed `config.schema.json` to
 * `z.toJSONSchema(Schema, { io: 'input' })` so it cannot drift from the
 * runtime zod schema. Regenerate after a schema change with:
 *
 *   UPDATE_SCHEMA=1 pnpm --filter @mnmal-ai/substrate-sentinel test
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SentinelBootstrapConfigSchema } from '../src/bootstrap.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, '..', 'config.schema.json');

describe('config.schema.json parity with zod schema', () => {
  it('committed JSON matches z.toJSONSchema(Schema)', () => {
    // io: 'input' marks Zod `.default(...)` fields as optional in the
    // operator-facing schema.
    const generated = `${JSON.stringify(z.toJSONSchema(SentinelBootstrapConfigSchema, { io: 'input' }), null, 2)}\n`;

    if (process.env.UPDATE_SCHEMA === '1') {
      writeFileSync(schemaPath, generated);
    }

    const committed = readFileSync(schemaPath, 'utf8');
    expect(committed).toBe(generated);
  });
});
