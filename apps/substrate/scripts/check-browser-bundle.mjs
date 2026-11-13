// Fails the build if the browser entry of `./client` reaches Node-only code.
import { readFileSync } from 'node:fs';

const file = new URL('../dist/client.browser.js', import.meta.url);
const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
const found = [/from\s+["']node:/, /\bBuffer\./, /\bprocess\./, /\brequire\(/].filter((re) =>
  re.test(code)
);
if (found.length > 0) {
  console.error(`dist/client.browser.js reaches Node-only code: ${found.join(', ')}`);
  process.exit(1);
}
