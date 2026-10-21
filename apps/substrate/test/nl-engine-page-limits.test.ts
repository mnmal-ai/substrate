/**
 * substrate-nl's engine access runs its reads under the remote page bounds:
 * an NL request is a remote read, so a type read without a limit is paged.
 */

import type { Engine } from '@mnmal-ai/substrate-core';
import type { EngineInput, SubstrateRequest } from '@mnmal-ai/substrate-types';
import { expect, it } from 'vitest';
import { nlEngineAccess } from '../src/serve/nl-engine.js';

it('passes the page limits to engine.query', async () => {
  const seen: EngineInput[] = [];
  const engine = {
    query: async (input: EngineInput) => {
      seen.push(input);
      return { schemaVersion: 't', data: {}, shapes: {} };
    }
  } as unknown as Engine;
  const pageLimits = { defaultLimit: 10, maxLimit: 20 };
  const access = nlEngineAccess({ current: engine }, new Set(), pageLimits);

  await access.query({ 'app/Thing': { fields: { id: true } } }, {
    method: 'POST',
    url: '/substrate/v1/nl',
    headers: {}
  } as unknown as SubstrateRequest);

  expect(seen[0]?.pageLimits).toEqual(pageLimits);
});
