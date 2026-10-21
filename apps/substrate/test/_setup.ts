import { assertNotSuperuser, assertTestDatabase } from '@mnmal-ai/substrate-dataset-pg/testing';

const packageName = 'apps/substrate';
assertTestDatabase(process.env.POSTGRES_URL, { packageName });
await assertNotSuperuser(process.env.POSTGRES_URL, { packageName });
