// One request through createH2Fetch, then return without close(): the process must exit on its own.
import { pathToFileURL } from 'node:url';

const [modPath, url, ca] = process.argv.slice(2);
const { createH2Fetch } = await import(pathToFileURL(modPath).href);
const f = createH2Fetch(ca ? { ca } : {});
const res = await f(url);
await res.text();
process.stdout.write(`status ${res.status}\n`);
