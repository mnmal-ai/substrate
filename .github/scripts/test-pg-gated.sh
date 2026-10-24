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
  # A package with a test:partitioned script runs again on the partitioned layout.
  if grep -q '"test:partitioned"' "$d/package.json"; then
    echo "::group::$d (partitioned)"
    pnpm -C "$d" run test:partitioned \
      --reporter=default --reporter=json --outputFile="$out/pg-${d//\//-}-partitioned.json"
    echo "::endgroup::"
  fi
done

node - "$out" "${dirs[@]}" <<'JS'
const [out, ...dirs] = process.argv.slice(2);
// Gated on env vars other than POSTGRES_URL (a hive topology, a holomap
// fixture), so their skips say nothing about whether pg reached the suites.
const otherGates = ['apps/substrate/test/hive-integration.test.ts',
  'plugins/substrate-recall/test/corpus-regression.test.ts'];
const fs = require('node:fs');
let bad = 0;
// The partitioned pass may skip legacy-only tests, but only ones that passed
// in the default pass, which proves POSTGRES_URL reached them.
const check = (label, report, allowed) => {
  const passedNames = new Set();
  let passed = 0;
  for (const f of report.testResults) {
    if (otherGates.some((g) => f.name.endsWith(g))) continue;
    for (const t of f.assertionResults) {
      if (t.status === 'passed') {
        passed++;
        passedNames.add(t.fullName);
      } else if (t.status !== 'failed' && !allowed.has(t.fullName)) {
        bad++;
        console.error(`::error::${label}: ${t.status}: ${t.fullName}`);
      }
    }
  }
  console.log(`${label}: ${passed} passed`);
  return passedNames;
};
for (const d of dirs) {
  const base = `${out}/pg-${d.replaceAll('/', '-')}`;
  const passed = check(d, require(`${base}.json`), new Set());
  if (fs.existsSync(`${base}-partitioned.json`)) {
    check(`${d} (partitioned)`, require(`${base}-partitioned.json`), passed);
  }
}
if (bad > 0) {
  console.error(`::error::${bad} pg-gated tests did not run; POSTGRES_URL did not reach them`);
  process.exit(1);
}
JS
