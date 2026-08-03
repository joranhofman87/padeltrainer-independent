#!/usr/bin/env bash
# 10c-b G — self-test for the enablement dispatcher.
#
# It runs the REAL script with `psql` stubbed, because the properties worth testing are the
# GATES, not the SQL: does a mutating step refuse without --yes, does it refuse a url that
# belongs to another project, does activate refuse to arm without its preflight, does rollback
# turn BOTH switches off, and does anything here ever unschedule the job.
#
# Each gate is also MUTATION-checked: the stub records what would have run, so a test can prove
# the guard is what stopped it rather than an accident of argument order.
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../run-enablement.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

REF="abcdefghijklmnopqrst"
URL="postgresql://postgres.${REF}:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"
OTHER_URL="postgresql://postgres.tsrqponmlkjihgfedcba:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"

# psql stub: records every invocation, never touches a database.
cat > "$TMP/psql" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PSQL_LOG"
exit 0
STUB
chmod +x "$TMP/psql"
export PATH="$TMP:$PATH"

run() {   # run <name> <expect_rc> -- args...
  local name="$1" expect="$2"; shift 3
  export PSQL_LOG="$TMP/log.$RANDOM"; : > "$PSQL_LOG"
  set +e
  EXPECTED_REF="$REF" bash "$SCRIPT" "$@" >"$TMP/out" 2>&1
  local rc=$?
  set -e
  if [[ "$rc" == "$expect" ]]; then ok "$name (rc=$rc)"; else bad "$name (rc=$rc, expected $expect)"; cat "$TMP/out"; fi
}

logged() { grep -qF "$1" "$PSQL_LOG"; }

# ── the gates ─────────────────────────────────────────────────────────────────
run "status is read-only and needs no --yes" 0 -- status "$URL"
grep -qF 'status.sql' "$PSQL_LOG" && ok "status ran the read artifact" || bad "status ran the read artifact"

run "activate REFUSES without --yes" 1 -- activate "$URL"
[[ ! -s "$PSQL_LOG" ]] && ok "...and touched the database not at all" || { bad "...and touched the database not at all"; cat "$PSQL_LOG"; }

run "rollback REFUSES without --yes" 1 -- rollback --switch-off-confirmed "$URL"
[[ ! -s "$PSQL_LOG" ]] && ok "rollback touched nothing without --yes" || bad "rollback touched nothing without --yes"

run "canary REFUSES without --yes" 1 -- canary "$URL" "11111111-1111-4111-8111-111111111111"

# The identity guard: a correct command against the WRONG project must not run.
run "activate REFUSES a url belonging to another project" 1 -- activate --yes "$OTHER_URL"
[[ ! -s "$PSQL_LOG" ]] && ok "...and ran nothing against it" || bad "...and ran nothing against it"

# ── what the mutating steps actually do ───────────────────────────────────────
run "activate runs its PREFLIGHT before arming" 0 -- activate --yes "$URL"
if logged 'activation_preflight.sql' && logged 'active := true'; then
  # order matters: preflight must be the FIRST thing, arming the last
  if [[ "$(grep -n 'activation_preflight.sql' "$PSQL_LOG" | cut -d: -f1 | head -1)" -lt \
        "$(grep -n 'active := true' "$PSQL_LOG" | cut -d: -f1 | head -1)" ]]; then
    ok "preflight runs BEFORE the cron is armed"
  else bad "preflight runs BEFORE the cron is armed"; fi
else bad "activate runs preflight then arms"; fi

# The worker's REAL kill switch is an edge env var no SQL can see, so the script refuses to
# pretend it verified one: the operator asserts it.
run "rollback REFUSES until the env switch is confirmed off" 1 -- rollback --yes "$URL"
[[ ! -s "$PSQL_LOG" ]] && ok "...and mutated nothing while refusing" || bad "...and mutated nothing while refusing"
run "smoke-disabled REFUSES until the env switch is confirmed off" 1 -- smoke-disabled "$URL"

run "rollback turns BOTH the engine and the cron off" 0 -- rollback --yes --switch-off-confirmed "$URL"
logged 'digest_engine_enabled = false' && ok "rollback disables the engine" || bad "rollback disables the engine"
logged 'active := false' && ok "rollback deactivates the cron" || bad "rollback deactivates the cron"
logged 'rollback_verify.sql' && ok "rollback proves itself afterwards" || bad "rollback proves itself afterwards"
# order: the switch first (stop creating work), then the cron (stop draining)
if [[ "$(grep -n 'digest_engine_enabled = false' "$PSQL_LOG" | cut -d: -f1 | head -1)" -lt \
      "$(grep -n 'active := false' "$PSQL_LOG" | cut -d: -f1 | head -1)" ]]; then
  ok "rollback switches the engine off BEFORE the cron"
else bad "rollback switches the engine off BEFORE the cron"; fi

# ── the thing that must never happen ──────────────────────────────────────────
if grep -rqF 'cron.unschedule' "$SCRIPT" "$HERE/../sql"; then
  bad "no path unschedules the job to pause it"
else
  ok "no path unschedules the job to pause it (deactivate, never unschedule)"
fi

# ── the canary takes a REAL run id, never a snapshot ──────────────────────────
run "canary REFUSES a non-uuid run id" 1 -- canary --yes "$URL" "before-after-snapshot"
run "canary reconciles the id it is given" 0 -- canary --yes "$URL" "11111111-1111-4111-8111-111111111111"
logged 'reconcile_notification_digest_run' && ok "canary reconciles the ACTUAL run" || bad "canary reconciles the ACTUAL run"

# ── the identity guard cannot be talked round ────────────────────────────────
# libpq takes host/hostaddr/user/dbname from the QUERY STRING and lets them override the
# authority, so a url that looks like EXPECTED_REF can still connect elsewhere.
run "refuses a url whose query string overrides the host" 1 -- \
  rollback --yes "${URL}?host=db.tsrqponmlkjihgfedcba.supabase.co"
[[ ! -s "$PSQL_LOG" ]] && ok "...and ran nothing against it" || bad "...and ran nothing against it"
run "refuses a query string even on a read-only subcommand" 1 -- status "${URL}?user=postgres"

# ── the artifacts it runs must actually exist ────────────────────────────────
# The stub never opens the file it is handed, so a broken `\i` inside an artifact — or a missing
# artifact altogether — would otherwise pass here and fail only in front of an operator.
for f in status.sql activation_preflight.sql rollback_verify.sql; do
  [[ -f "$HERE/../sql/$f" ]] && ok "artifact $f exists" || bad "artifact $f exists"
done
for f in activation_preflight.sql rollback_verify.sql; do
  inc="$(grep -o '\\i [^ ]*' "$HERE/../sql/$f" | awk '{print $2}')"
  if [[ -n "$inc" ]]; then
    ( cd "$HERE/../sql" && [[ -f "$inc" ]] ) && ok "$f includes a path that resolves from sql/" \
      || bad "$f includes a path that resolves from sql/ (got '$inc')"
  fi
done

# ── sourcing must not execute ────────────────────────────────────────────────
set +e
( EXPECTED_REF="$REF" bash -c 'set -- rollback --yes "$1"; source "$2"' _ "$URL" "$SCRIPT" >/dev/null 2>&1 )
src_rc=$?
set -e
[[ "$src_rc" != "0" ]] && ok "sourcing the dispatcher refuses instead of running it (rc=$src_rc)" \
  || bad "sourcing the dispatcher refuses instead of running it"

printf '\n================  %d passed, %d failed  ================\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]]
