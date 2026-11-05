#!/usr/bin/env bash
# Pre-run check for the obsidian-mind side: qmd is installed and new enough,
# and the vault's index exists. If the index is missing, run the vault's own
# idempotent bootstrap (the same self-heal its SessionStart hook performs).
set -euo pipefail

VAULT="$(cd "$(dirname "$0")/../vault" && pwd)"
cd "$VAULT"

command -v qmd >/dev/null || { echo "qmd is not installed: npm install -g @tobilu/qmd" >&2; exit 1; }
VERSION="$(qmd --version | awk '{print $2}')"
node -e 'const [a,b,c]=process.argv[1].split(".").map(Number); process.exit(a>2||(a===2&&(b>5||(b===5&&c>=1)))?0:1)' "$VERSION" \
  || { echo "qmd $VERSION is older than 2.5.1: npm install -g @tobilu/qmd" >&2; exit 1; }

# The index name, resolved as the vault's hooks and MCP wrapper resolve it.
INDEX="$(node -e '
  const ok = (s) => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s);
  const m = JSON.parse(require("fs").readFileSync("vault-manifest.json", "utf8"));
  const slug = require("path").basename(process.cwd()).normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[^a-z0-9]+|[-._]+$/g, "");
  process.stdout.write([m.qmd_index, slug, m.template].find(ok));
')"

STORE="${XDG_CACHE_HOME:-$HOME/.cache}/qmd/$INDEX.sqlite"
if [ ! -s "$STORE" ] || ! qmd --index "$INDEX" collection show "$INDEX" >/dev/null 2>&1; then
  echo "qmd index '$INDEX' missing; running the vault's bootstrap"
  node --experimental-strip-types .scripts/qmd-bootstrap.ts
fi

qmd --index "$INDEX" status | sed -n '1,12p'
