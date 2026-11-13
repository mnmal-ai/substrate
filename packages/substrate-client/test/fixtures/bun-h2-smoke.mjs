// Bun smoke for createH2Fetch: GET over h2c, and over TLS with a private CA, against
// node:http2 servers, run under `bun`. Exit 0 when both answer.
// Usage: bun test/fixtures/bun-h2-smoke.mjs <src/transport/h2-fetch.ts> [cert.pem key.pem]
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';

const [mod, certPath, keyPath] = process.argv.slice(2);
const { createH2Fetch } = await import(mod);
const onStream = (s, h) => {
  s.respond({ ':status': 200 });
  s.end(`ok ${h[':path']}`);
};
async function check(server, scheme, opts) {
  server.on('stream', onStream);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const f = createH2Fetch(opts);
  const res = await f(`${scheme}://127.0.0.1:${server.address().port}/bun`);
  const text = await res.text();
  await f.close();
  server.close();
  console.log(scheme, res.status, text);
  return res.status === 200 && text === 'ok /bun';
}
let ok = await check(http2.createServer(), 'http', {});
if (certPath) {
  const cert = readFileSync(certPath, 'utf8');
  ok =
    (await check(http2.createSecureServer({ cert, key: readFileSync(keyPath, 'utf8') }), 'https', {
      ca: cert
    })) && ok;
}
process.exit(ok ? 0 : 1);
