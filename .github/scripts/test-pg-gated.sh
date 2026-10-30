#!/usr/bin/env bash
# Runs every pg-gated suite and fails if any pg-gated test skipped. The suites
# skip themselves without a usable POSTGRES_URL, which would pass green having
# tested nothing. Packages are discovered rather than listed, so a new
# pg-gated package cannot be left out of the guard.
#
#   test-pg-gated.sh                  every pass here, then the skip check
#   test-pg-gated.sh plan             the passes as a JSON matrix, for CI
#   test-pg-gated.sh run DIR LAYOUT   one pass, its report into $PG_REPORTS
#   test-pg-gated.sh check            the skip check over $PG_REPORTS
set -euo pipefail

out="${PG_REPORTS:-${RUNNER_TEMP:-$(mktemp -d)}}"
mkdir -p "$out"

dirs() {
  grep -rl --include='*.ts' POSTGRES_URL apps/*/test packages/*/test plugins/*/test |
    cut -d/ -f1-2 | sort -u
}

# One pass per package, and a second on the partitioned layout for a package
# with a test:partitioned script.
passes() {
  local d
  for d in $(dirs); do
    echo "$d legacy"
    if grep -q '"test:partitioned"' "$d/package.json"; then echo "$d partitioned"; fi
  done
}

report() { echo "$out/pg-${1//\//-}$([ "$2" = partitioned ] && echo -partitioned).json"; }

run() {
  local d=$1 layout=$2
  : "${POSTGRES_URL:?POSTGRES_URL must name the substrate_test database}"
  echo "::group::$d ($layout)"
  # Each package's globalSetup moves it into a schema of its own.
  if [ "$layout" = partitioned ]; then
    pnpm -C "$d" run test:partitioned --reporter=default --reporter=json --outputFile="$(report "$d" "$layout")"
  else
    pnpm -C "$d" exec vitest run --reporter=default --reporter=json --outputFile="$(report "$d" "$layout")"
  fi
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
// Each pass may skip a layout-specific test, but only one that passed in the
// other pass, which proves POSTGRES_URL reached it.
const tests = (report) =>
  report.testResults
    .filter((f) => !otherGates.some((g) => f.name.endsWith(g)))
    .flatMap((f) => f.assertionResults);
const passedIn = (list) => new Set(list.filter((t) => t.status === 'passed').map((t) => t.fullName));
for (const d of dirs) {
  const base = `${out}/pg-${d.replaceAll('/', '-')}`;
  if (!fs.existsSync(`${base}.json`)) {
    bad++;
    console.error(`::error::${d}: no report; its pg pass did not run`);
    continue;
  }
  const passes = [[d, tests(require(`${base}.json`))]];
  if (fs.existsSync(`${base}-partitioned.json`)) {
    passes.push([`${d} (partitioned)`, tests(require(`${base}-partitioned.json`))]);
  } else if (fs.readFileSync(`${d}/package.json`, 'utf8').includes('"test:partitioned"')) {
    bad++;
    console.error(`::error::${d}: no partitioned report; its partitioned pass did not run`);
  }
  const passedAnywhere = new Set(passes.flatMap(([, list]) => [...passedIn(list)]));
  for (const [label, list] of passes) {
    for (const t of list) {
      if (t.status !== 'passed' && t.status !== 'failed' && !passedAnywhere.has(t.fullName)) {
        bad++;
        console.error(`::error::${label}: ${t.status}: ${t.fullName}`);
      }
    }
    console.log(`${label}: ${passedIn(list).size} passed`);
  }
}
if (bad > 0) {
  console.error(`::error::${bad} pg-gated tests did not run; POSTGRES_URL did not reach them`);
  process.exit(1);
}
JS
}

case "${1:-all}" in
  plan)
    passes | node -e '
      const lines = require("node:fs").readFileSync(0, "utf8").trim().split("\n");
      const include = lines.map((l) => { const [dir, layout] = l.split(" "); return { dir, layout }; });
      process.stdout.write(JSON.stringify({ include }));'
    ;;
  run) run "$2" "$3" ;;
  check) check ;;
  all)
    while read -r d layout; do run "$d" "$layout"; done < <(passes)
    check
    ;;
  *) echo "usage: $0 [plan | run DIR LAYOUT | check]" >&2; exit 2 ;;
esac
