// One request through createH2Fetch, then return without close(): the process must exit on its own.
// Mode `noread` leaves the body unread, as a caller that only checks `res.ok` does.
import { pathToFileURL } from 'node:url';

const [modPath, url, mode] = process.argv.slice(2);
const { createH2Fetch } = await import(pathToFileURL(modPath).href);
const f = createH2Fetch();
const res = await f(url);
if (mode !== 'noread') await res.text();
process.stdout.write(`status ${res.status}\n`);
