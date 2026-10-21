/**
 * Minimal `KEY=VALUE` reader for `substrate federate check --env-file`.
 *
 * The bridge config lives in the runtime's `.env` (or a systemd
 * EnvironmentFile), not in the operator's shell. Without this the operator has
 * to remember `set -a && source .env && set +a` before every check.
 *
 * Deliberately not a full dotenv implementation: no interpolation, no
 * multi-line values, no `export ` prefix handling. systemd's EnvironmentFile
 * does not do those either, so matching its subset is the correct target.
 */

import { readFileSync } from 'node:fs';

export function loadEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `cannot read env file '${path}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
