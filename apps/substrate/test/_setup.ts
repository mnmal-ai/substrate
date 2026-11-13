import { assertNotSuperuser, assertTestDatabase } from '@mnmal-ai/substrate-dataset-pg/testing';
import { vi } from 'vitest';

const packageName = 'apps/substrate';
assertTestDatabase(process.env.POSTGRES_URL, { packageName });
await assertNotSuperuser(process.env.POSTGRES_URL, { packageName });

// `substrateFetch` speaks HTTP/2, which the platform fetch does not. A suite
// that stubs or spies on the platform fetch still sees substrate's requests:
// while `globalThis.fetch` is replaced, `substrateFetch` calls it instead.
vi.mock('@mnmal-ai/substrate-client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mnmal-ai/substrate-client')>();
  const platform = globalThis.fetch;
  return {
    ...real,
    substrateFetch: (input: string, init?: RequestInit) =>
      globalThis.fetch === platform
        ? real.substrateFetch(input, init)
        : globalThis.fetch(input, init)
  };
});
