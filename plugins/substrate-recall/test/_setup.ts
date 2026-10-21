import { assertNotSuperuser, assertTestDatabase } from '@mnmal-ai/substrate-dataset-pg/testing';

const packageName = 'substrate-recall';
assertTestDatabase(process.env.POSTGRES_URL, { packageName });
await assertNotSuperuser(process.env.POSTGRES_URL, { packageName });
