import { describe, expect, it } from 'vitest';
import { SubstrateClient } from '../src/client.js';

const ENDPOINT = 'http://substrate.test';

describe('SubstrateClient.watch — frame validation', () => {
  it('throws synchronously on a multi-key frame', async () => {
    const client = new SubstrateClient({ endpoint: ENDPOINT });
    expect(() =>
      client.watch({
        'claude/Todo': { params: {}, fields: {} },
        'claude/Decision': { params: {}, fields: {} }
      })
    ).toThrow(/single qualified key/i);
    await client.close();
  });

  it('throws synchronously on an empty frame', async () => {
    const client = new SubstrateClient({ endpoint: ENDPOINT });
    expect(() => client.watch({})).toThrow(/exactly one key/i);
    await client.close();
  });

  it('throws once the client is closed', async () => {
    const client = new SubstrateClient({ endpoint: ENDPOINT });
    await client.close();
    expect(() => client.watch({ 'claude/Todo': { params: {}, fields: {} } })).toThrow(
      /already closed/i
    );
  });
});
