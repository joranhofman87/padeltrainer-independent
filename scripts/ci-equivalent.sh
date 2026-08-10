#!/usr/bin/env bash
# Every gate CI runs, in one command — because running a SUBSET locally is how a branch reaches CI
# green-locally and red-remotely. `npx eslint .` passing is not `npm run lint` passing, and neither
# is `check:legacy-key` passing: PR #645 failed on the legacy-key SELF-TEST, which no local run had
# touched, because a new edge function was not in the consumer inventory.
#
# Mirrors .github/workflows/test.yml and migrations.yml. E2E (playwright, needs deployed secrets),
# rollout-tooling and seo-smoke are deliberately out: they need credentials or a remote target.
#
#   scripts/ci-equivalent.sh          # everything except the real-Postgres suites
#   scripts/ci-equivalent.sh --db     # ...including them (requires a running local Supabase)
set -uo pipefail
cd "$(dirname "$0")/.."

WITH_DB=0
[[ "${1:-}" == "--db" ]] && WITH_DB=1

FAILED=()
run() {
  local name="$1"; shift
  printf '\n\033[1m── %s\033[0m\n' "$name"
  if "$@"; then printf '\033[32m   ok\033[0m\n'; else FAILED+=("$name"); printf '\033[31m   FAILED\033[0m\n'; fi
}

# ── test.yml: lint job ─────────────────────────────────────────────────────────────────────────
run "lint (ratcheted)"            npm run --silent lint
run "edge-function config drift"  npm run --silent check:edge-config
run "legacy-key guard self-test"  npm run --silent check:legacy-key:selftest
run "legacy-key guard"            npm run --silent check:legacy-key
run "edge import pins self-test"  npm run --silent check:edge-pins:selftest
run "edge import pins"            npm run --silent check:edge-pins

# ── test.yml: typecheck + build ────────────────────────────────────────────────────────────────
run "typecheck (baseline)"        npm run --silent typecheck:baseline
run "build"                       npm run --silent build

# ── test.yml: edge typecheck ───────────────────────────────────────────────────────────────────
run "edge typecheck self-test"    npm run --silent check:edge-types:selftest
run "edge typecheck"              npm run --silent check:edge-types

# ── test.yml: tests ────────────────────────────────────────────────────────────────────────────
run "vitest"                      npm test --silent
run "deno (edge)"                 deno test --no-check --allow-env --allow-net supabase/functions/_shared/

if [[ $WITH_DB == 1 ]]; then
  # ── test.yml: PGlite rehearsals, and migrations.yml against real local Postgres ──────────────
  run "db rehearsals (PGlite)"    npm run --silent db:rehearse:all
  run "generated types drift"     npm run --silent db:types:check
  run "academy-deletion (real pg)" node scripts/db/academy-deletion-integration.mjs
else
  printf '\n\033[33m── skipped (pass --db): db rehearsals, types drift, academy-deletion real-pg\033[0m\n'
fi

printf '\n'
if [[ ${#FAILED[@]} -eq 0 ]]; then
  printf '\033[32m✅ every gate passed\033[0m\n'
else
  printf '\033[31m❌ %d failed:\033[0m\n' "${#FAILED[@]}"
  printf '   %s\n' "${FAILED[@]}"
  exit 1
fi
