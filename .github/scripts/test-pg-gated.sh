#!/usr/bin/env bash
# Runs every pg-gated suite and fails if any pg-gated test skipped. The suites
# skip themselves without a usable POSTGRES_URL, which would pass green having
# tested nothing. Packages are discovered rather than listed, so a new
# pg-gated package cannot be left out of the guard.
set -euo pipefail

: "${POSTGRES_URL:?POSTGRES_URL must name the substrate_test database}"
out="${RUNNER_TEMP:-$(mktemp -d)}"

mapfile -t dirs < <(grep -rl --include='*.ts' POSTGRES_URL apps/*/test packages/*/test plugins/*/test |
  cut -d/ -f1-2 | sort -u)
[ "${#dirs[@]}" -gt 0 ] || { echo "::error::no pg-gated packages found"; exit 1; }

for d in "${dirs[@]}"; do
  echo "::group::$d"
  # Each package's globalSetup moves it into a schema of its own.
  pnpm -C "$d" exec vitest run \
    --reporter=default --reporter=json --outputFile="$out/pg-${d//\//-}.json"
  echo "::endgroup::"
done

node - "$out" "${dirs[@]}" <<'JS'
const [out, ...dirs] = process.argv.slice(2);
// Gated on env vars other than POSTGRES_URL (a hive topology, a holomap
// fixture), so their skips say nothing about whether pg reached the suites.
const otherGates = ['apps/substrate/test/hive-integration.test.ts',
  'plugins/substrate-recall/test/corpus-regression.test.ts'];
let bad = 0;
for (const d of dirs) {
  const r = require(`${out}/pg-${d.replaceAll('/', '-')}.json`);
  let passed = 0;
  for (const f of r.testResults) {
    if (otherGates.some((g) => f.name.endsWith(g))) continue;
    for (const t of f.assertionResults) {
      if (t.status === 'passed') passed++;
      else if (t.status !== 'failed') {
        bad++;
        console.error(`::error::${d}: ${t.status}: ${t.fullName}`);
      }
    }
  }
  console.log(`${d}: ${passed} passed`);
}
if (bad > 0) {
  console.error(`::error::${bad} pg-gated tests did not run; POSTGRES_URL did not reach them`);
  process.exit(1);
}
JS
