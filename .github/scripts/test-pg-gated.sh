#!/usr/bin/env bash
# Runs every pg-gated suite and fails if any pg-gated test skipped. The suites
# skip themselves without a usable POSTGRES_URL, which would pass green having
# tested nothing. Packages are discovered rather than listed, so a new
# pg-gated package cannot be left out of the guard.
#
#   test-pg-gated.sh                 every pass here, then the skip check
#   test-pg-gated.sh plan            the passes as a JSON matrix, for CI
#   test-pg-gated.sh run DIR [PART]  one pass, its report into $PG_REPORTS
#   test-pg-gated.sh check           the skip check over $PG_REPORTS
#
# A package's pass covers all its files, except those a part takes. A part is a
# group of slow files with a pass of its own, so CI runs it beside the rest.
#
# PG_ONLY narrows plan and check to the passes of the listed package dirs
# (space-separated; unset or `*` means all). The pre-merge workflow sets it to
# the packages a PR's changes reach.
set -euo pipefail

out="${PG_REPORTS:-${RUNNER_TEMP:-$(mktemp -d)}}"
mkdir -p "$out"

dirs() {
  grep -rl --include='*.ts' POSTGRES_URL apps/*/test apps/*/examples packages/*/test plugins/*/test plugins/*/src/__tests__ |
    cut -d/ -f1-2 | sort -u
}

# Parts, one per line: "<dir> <part> <file prefix under the package>...".
# No file may match two parts.
parts() {
  echo "apps/substrate migrate-store-verify test/migrate-store-verify"
  echo "apps/substrate migrate-store test/migrate-store-c test/migrate-store-p"
}

# The file prefixes of one part of a package, or of all its parts, one per line.
prefixes() {
  parts | awk -v d="$1" -v p="${2:-}" \
    '$1 == d && (p == "" || $2 == p) { for (i = 3; i <= NF; i++) print $i }'
}

# Every pass, one per line: "<dir>" or "<dir> <part>".
all_passes() {
  dirs
  parts | cut -d' ' -f1-2
}

# The passes PG_ONLY keeps.
passes() {
  local only=${PG_ONLY-*}
  if [ "$only" = '*' ]; then all_passes; return; fi
  all_passes | awk -v only="$only" \
    'BEGIN { n = split(only, a, " "); for (i = 1; i <= n; i++) keep[a[i]] = 1 } keep[$1]'
}

report() { echo "$out/pg-${1//\//-}${2:+-$2}.json"; }

run() {
  local d=$1 part=${2:-} prefix
  local -a select=()
  : "${POSTGRES_URL:?POSTGRES_URL must name the substrate_test database}"
  if [ -n "$part" ]; then
    mapfile -t select < <(prefixes "$d" "$part")
    [ "${#select[@]}" -gt 0 ] || { echo "::error::$d has no part '$part'"; exit 2; }
  else
    # The package's own pass leaves out what its parts run.
    while read -r prefix; do
      select+=("--exclude=${prefix}*")
    done < <(prefixes "$d")
  fi
  echo "::group::$d${part:+ $part}"
  # Each package's globalSetup moves it into a schema of its own.
  pnpm -C "$d" exec vitest run "${select[@]}" --reporter=default --reporter=json \
    --outputFile="$(report "$d" "$part")"
  echo "::endgroup::"
}

check() {
  local -a ds
  mapfile -t ds < <(passes)
  [ "$(all_passes | wc -l)" -gt 0 ] || { echo "::error::no pg-gated packages found"; exit 1; }
  [ "${#ds[@]}" -gt 0 ] || { echo "no Postgres pass covers the changed packages"; return 0; }
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
  const file = `${out}/pg-${d.replaceAll(/[/ ]/g, '-')}.json`;
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
    passes | node -e '
      const lines = require("node:fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
      const include = lines.map((name) => {
        const [dir, part = ""] = name.split(" ");
        return { name, dir, part };
      });
      process.stdout.write(JSON.stringify({ include }));'
    ;;
  run) run "$2" "${3:-}" ;;
  check) check ;;
  all)
    while read -r d part; do run "$d" "$part"; done < <(passes)
    check
    ;;
  *) echo "usage: $0 [plan | run DIR [PART] | check]" >&2; exit 2 ;;
esac
