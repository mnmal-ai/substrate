import { assertNotSuperuser, assertTestDatabase } from '../src/testing.js';

const packageName = 'substrate-dataset-pg';
assertTestDatabase(process.env.POSTGRES_URL, { packageName });
await assertNotSuperuser(process.env.POSTGRES_URL, { packageName });
