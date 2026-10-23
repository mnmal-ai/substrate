import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runRun } from '../src/cli/run/main.js';

const dir = mkdtempSync(join(tmpdir(), 'run-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const keyPath = join(dir, 'agent.key');
writeFileSync(
  keyPath,
  generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
);
const env = {
  SUBSTRATE_URL: 'https://h',
  SUBSTRATE_AGENT_KEY_ID: 'a@h',
  SUBSTRATE_AGENT_KEY_PATH: keyPath
};

function script(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

const fake = (seen: string[]): typeof fetch =>
  (async (url: string, init: RequestInit) => {
    seen.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`);
    const body = url.endsWith('/federated-schema')
      ? {}
      : {
          schemaVersion: 'v',
          shapes: { 'ns/T': 'list' },
          data: { 'ns/T': [{ id: '1' }, { id: '2' }] }
        };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

describe('substrate run', () => {
  it('prints the report with the script result, signed as the kid', async () => {
    const seen: string[] = [];
    let out = '';
    const p = script(
      'count.mjs',
      `export default async (s) => ({ n: (await s.query({ 'ns/T': { fields: { id: true } } })).data['ns/T'].length, kid: s.kid })`
    );
    expect(await runRun([p], { env, fetchImpl: fake(seen), write: (s) => (out += s) })).toBe(0);
    const report = JSON.parse(out);
    expect(report).toMatchObject({
      ok: true,
      mode: 'read',
      kid: 'a@h',
      result: { n: 2, kid: 'a@h' }
    });
    expect(seen).toContain('POST /substrate/v1/query');
  });

  it('writes the report to --out and exits 1 when the script fails', async () => {
    let out = '';
    const reportPath = join(dir, 'report.json');
    const p = script('mut.mjs', `export default (s) => s.mutate({ 'ns/createT': { params: {} } })`);
    expect(
      await runRun([p, '--out', reportPath], { env, fetchImpl: fake([]), write: (s) => (out += s) })
    ).toBe(1);
    expect(out).toMatch(/^failed: mutate refused: read mode .* report in /);
    expect(JSON.parse(readFileSync(reportPath, 'utf8')).ok).toBe(false);
  });

  it('refuses bad arguments, a non-function script and a missing identity', async () => {
    const w = () => {};
    const ok = script('ok.mjs', 'export default () => 1');
    expect(await runRun([], { env, write: w })).toBe(2);
    expect(await runRun([ok, '--dry-run', '--write'], { env, write: w })).toBe(2);
    expect(await runRun([ok, '--max-writes', '-1'], { env, write: w })).toBe(2);
    expect(await runRun([script('bad.mjs', 'export default 1')], { env, write: w })).toBe(2);
    let out = '';
    expect(
      await runRun([ok], { env: { SUBSTRATE_URL: 'https://h' }, write: (s) => (out += s) })
    ).toBe(2);
    expect(out).toMatch(/agent identity: no signing key/);
  });

  it('passes --args to the script and refuses anything but a JSON object', async () => {
    let out = '';
    const p = script('args.mjs', 'export default (s) => s.args.n * 2');
    expect(await runRun([p, '--args', '{"n":21}'], { env, write: (s) => (out += s) })).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ result: 42, args: { n: 21 } });
    for (const bad of ['[1]', 'null', '{oops', '"s"']) {
      let err = '';
      expect(await runRun([p, '--args', bad], { env, write: (s) => (err += s) })).toBe(2);
      expect(err).toMatch(/--args takes a JSON object/);
    }
  });
});
