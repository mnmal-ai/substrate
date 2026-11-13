// One query through SubstrateClient, then return without close(): the process must exit on its own.
import { SubstrateClient } from '@mnmal-ai/substrate-client';

const client = new SubstrateClient({ endpoint: process.argv[2] });
const env = await client.query({ 'nope/Thing': { params: {}, fields: { id: true } } });
process.stdout.write(`errors ${env.errors?.length ?? 0}\n`);
