#!/usr/bin/env bash
# Runs every pg-gated suite and fails if any pg-gated test skipped. The suites
# skip themselves without a usable POSTGRES_URL, which would pass green having
# tested nothing. Packages are discovered rather than listed, so a new
# pg-gated package cannot be left out of the guard.
#
#   test-pg-gated.sh               every pass here, then the skip check
#   test-pg-gated.sh plan          the passes as a JSON matrix, for CI
#   test-pg-gated.sh run DIR       one package's pass, its report into $PG_REPORTS
#   test-pg-gated.sh check         the skip check over $PG_REPORTS
set -euo pipefail

out="${PG_REPORTS:-${RUNNER_TEMP:-$(mktemp -d)}}"
mkdir -p "$out"

dirs() {
  grep -rl --include='*.ts' POSTGRES_URL apps/*/test packages/*/test plugins/*/test plugins/*/src/__tests__ |
    cut -d/ -f1-2 | sort -u
}

report() { echo "$out/pg-${1//\//-}.json"; }

run() {
  local d=$1
  : "${POSTGRES_URL:?POSTGRES_URL must name the substrate_test database}"
  echo "::group::$d"
  # Each package's globalSetup moves it into a schema of its own.
  pnpm -C "$d" exec vitest run --reporter=default --reporter=json --outputFile="$(report "$d")"
  echo "::endgroup::"
}

check() {
  local -a ds
  mapfile -t ds < <(dirs)
  [ "${#ds[@]}" -gt 0 ] || { echo "::error::no pg-gated packages found"; exit 1; }
  node - "$out" "${ds[@]}" <<'JS'
const [out, ...dirs] = process.argv.slice(2);
// Gated on env vars other than POSTGRES_URL (a hive topology, a holomap
// fixture), so their skips say nothing about whether pg reached the suites.
const otherGates = ['apps/substrate/test/hive-integration.test.ts',
  'plugins/substrate-recall/test/corpus-regression.test.ts'];
const fs = require('node:fs');
let bad = 0;
const tests = (report) =>
  report.testResults
    .filter((f) => !otherGates.some((g) => f.name.endsWith(g)))
    .flatMap((f) => f.assertionResults);
for (const d of dirs) {
  const file = `${out}/pg-${d.replaceAll('/', '-')}.json`;
  if (!fs.existsSync(file)) {
    bad++;
    console.error(`::error::${d}: no report; its pg pass did not run`);
    continue;
  }
  const list = tests(require(file));
  for (const t of list) {
    if (t.status !== 'passed' && t.status !== 'failed') {
      bad++;
      console.error(`::error::${d}: ${t.status}: ${t.fullName}`);
    }
  }
  console.log(`${d}: ${list.filter((t) => t.status === 'passed').length} passed`);
}
if (bad > 0) {
  console.error(`::error::${bad} pg-gated tests did not run; POSTGRES_URL did not reach them`);
  process.exit(1);
}
JS
}

case "${1:-all}" in
  plan)
    dirs | node -e '
      const lines = require("node:fs").readFileSync(0, "utf8").trim().split("\n");
      process.stdout.write(JSON.stringify({ include: lines.map((dir) => ({ dir })) }));'
    ;;
  run) run "$2" ;;
  check) check ;;
  all)
    while read -r d; do run "$d"; done < <(dirs)
    check
    ;;
  *) echo "usage: $0 [plan | run DIR | check]" >&2; exit 2 ;;
esac
