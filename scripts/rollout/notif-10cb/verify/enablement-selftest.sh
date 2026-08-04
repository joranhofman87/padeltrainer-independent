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

# psql stub. It records every invocation AND OPENS the artifact it is handed, because a stub that
# only records arguments is how a broken `\i` inside an artifact survived review: every SQL gate
# was vacuous. STUB_FAIL_ON makes a named artifact fail the way a real assertion failure would,
# which is what lets a test prove a FAILING preflight actually stops the arm command.
cat > "$TMP/psql" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PSQL_LOG"
# Record the PG* environment psql was ACTUALLY given. Asserting on the parent's
# environment would prove nothing: the property under test is what reaches the
# child, and `env -u` is the only thing that decides it.
if [[ -n "${PSQL_ENV_LOG:-}" ]]; then env | sed -n 's/^\(PG[A-Z0-9_]*\)=.*/\1/p' | sort -u >> "$PSQL_ENV_LOG"; fi
file=""
prev=""
for a in "$@"; do
  if [[ "$prev" == "-f" ]]; then file="$a"; fi
  prev="$a"
done
if [[ -n "$file" ]]; then
  [[ -f "$file" ]] || { printf 'psql: %s: No such file or directory\n' "$file" >&2; exit 1; }
  # resolve every \i include the way psql does — relative to the current directory
  while read -r inc; do
    [[ -f "$inc" ]] || { printf 'psql: could not open file "%s"\n' "$inc" >&2; exit 1; }
  done < <(grep -o '^\\i [^ ]*' "$file" | awk '{print $2}')
  if [[ -n "${STUB_FAIL_ON:-}" && "$file" == *"$STUB_FAIL_ON"* ]]; then
    printf 'psql:%s: ERROR:  ASSERT FAILED (simulated)\n' "$file" >&2; exit 3
  fi
  # The two canary-invoke artifacts hand a value BACK to the dispatcher, so the stub has to speak
  # their marker protocol or the whole subcommand is untestable here. Defaults are the happy path;
  # each is overridable so a test can drive the unhappy ones.
  case "$file" in
    *canary_invoke.sql)
      printf 'CANARY_REQUEST_ID=%s\n' "${STUB_CANARY_REQUEST_ID:-4242}"
      # A SECOND, different id — only when a test asks for one. The dispatcher must refuse rather
      # than pick, because reading the wrong request means reporting on a send it did not make.
      if [[ -n "${STUB_CANARY_SECOND_REQUEST_ID:-}" ]]; then
        printf 'CANARY_REQUEST_ID=%s\n' "$STUB_CANARY_SECOND_REQUEST_ID"
      fi ;;
    *canary_invoke_response.sql)
      default_body='{"status":"ok","dispatchRunId":"22222222-2222-4222-8222-222222222222"}'
      printf 'CANARY_RESPONSE_STATUS=%s\n' "${STUB_CANARY_STATUS:-200}"
      printf 'CANARY_RESPONSE_ERROR=none\n'
      printf 'CANARY_RESPONSE_BODY=%s\n' "${STUB_CANARY_BODY:-$default_body}" ;;
  esac
fi
exit 0
STUB
chmod +x "$TMP/psql"
export PATH="$TMP:$PATH"

run() {   # run <name> <expect_rc> -- args...
  local name="$1" expect="$2"; shift 3
  export PSQL_LOG="$TMP/log.$RANDOM"; : > "$PSQL_LOG"
  export PSQL_ENV_LOG="$TMP/env.$RANDOM"; : > "$PSQL_ENV_LOG"
  set +e
  EXPECTED_REF="$REF" bash "$SCRIPT" "$@" >"$TMP/out" 2>&1
  local rc=$?
  set -e
  if [[ "$rc" == "$expect" ]]; then ok "$name (rc=$rc)"; else bad "$name (rc=$rc, expected $expect)"; cat "$TMP/out"; fi
}

logged() { grep -qF -- "$1" "$PSQL_LOG"; }

# ── the gates ─────────────────────────────────────────────────────────────────
run "status is read-only and needs no --yes" 0 -- status "$URL"
grep -qF 'status.sql' "$PSQL_LOG" && ok "status ran the read artifact" || bad "status ran the read artifact"

# EVERY OTHER PREREQUISITE IS SUPPLIED, so the refusal can only be the missing --yes. Omitting the
# run id and the other flags too meant deleting require_confirmed still produced a refusal later,
# and the test passed for the wrong reason.
# The two subcommands added in slice I. The realpg suite runs their ARTIFACTS directly, so without
# these the dispatcher could lose require_confirmed, skip db_url, or route to the wrong artifact and
# every reported gate would still be green.
run "assert-inert is read-only and needs no --yes" 0 -- assert-inert "$URL"
logged 'assert_inert.sql' && ok "assert-inert runs its own artifact" || bad "assert-inert runs its own artifact"
run "assert-inert REFUSES a url belonging to another project" 1 -- assert-inert "$OTHER_URL"
[[ ! -s "$PSQL_LOG" ]] && ok "...and ran nothing against it" || bad "...and ran nothing against it"

run "enable-engine REFUSES without --yes" 1 -- enable-engine "$URL"
[[ ! -s "$PSQL_LOG" ]] && ok "...and touched the database not at all" || bad "...and touched the database not at all"
run "enable-engine REFUSES a url belonging to another project" 1 -- enable-engine --yes "$OTHER_URL"
[[ ! -s "$PSQL_LOG" ]] && ok "...and ran nothing against it either" || bad "...and ran nothing against it either"
run "enable-engine runs its own artifact" 0 -- enable-engine --yes "$URL"
logged 'enable_engine.sql' && ok "enable-engine routes to enable_engine.sql" || bad "enable-engine routes to enable_engine.sql"
if grep -qF -- 'active := true' "$PSQL_LOG"; then bad "...and arms nothing"; else ok "...and arms nothing"; fi
export PSQL_LOG="$TMP/log.engine_fail"; : > "$PSQL_LOG"
set +e
STUB_FAIL_ON=enable_engine EXPECTED_REF="$REF" bash "$SCRIPT" enable-engine --yes "$URL" >/dev/null 2>&1
ee_rc=$?
set -e
[[ "$ee_rc" != "0" ]] && ok "a failing enable_engine artifact fails the subcommand (rc=$ee_rc)" \
  || bad "a failing enable_engine artifact fails the subcommand"

run "activate REFUSES without --yes" 1 -- activate --monitor-confirmed --admin-ops-confirmed "$URL" "11111111-1111-4111-8111-111111111111"
[[ ! -s "$PSQL_LOG" ]] && ok "...and touched the database not at all" || { bad "...and touched the database not at all"; cat "$PSQL_LOG"; }

run "rollback REFUSES without --yes" 1 -- rollback --switch-off-confirmed "$URL"
[[ ! -s "$PSQL_LOG" ]] && ok "rollback touched nothing without --yes" || bad "rollback touched nothing without --yes"

run "canary REFUSES without --yes" 1 -- canary --admin-ops-confirmed "$URL" "11111111-1111-4111-8111-111111111111"

# Activation is bound to ONE canary run. Without the run id the preflight fell back to "some
# dispatch run succeeded at some point", which any earlier rollout satisfies permanently.
run "activate REFUSES without a canary run id" 1 -- activate --yes --monitor-confirmed --admin-ops-confirmed "$URL"
[[ ! -s "$PSQL_LOG" ]] && ok "...and reached no database" || bad "...and reached no database"
run "activate REFUSES a non-uuid run id" 1 -- activate --yes --monitor-confirmed --admin-ops-confirmed "$URL" "the-last-one-worked"
run "activate REFUSES a uuid-length string of dashes" 1 -- activate --yes --monitor-confirmed --admin-ops-confirmed "$URL" "------------------------------------"

# The identity guard: a correct command against the WRONG project must not run.
run "activate REFUSES a url belonging to another project" 1 -- activate --yes --monitor-confirmed --admin-ops-confirmed "$OTHER_URL" "11111111-1111-4111-8111-111111111111"
[[ ! -s "$PSQL_LOG" ]] && ok "...and ran nothing against it" || bad "...and ran nothing against it"

# ── what the mutating steps actually do ───────────────────────────────────────
RUN_ID="11111111-1111-4111-8111-111111111111"

# The EXTERNAL monitor is the only detector for a worker that is never invoked, and it lives
# outside this database — so, like the edge kill switch, the operator asserts it. The docs called
# it a precondition while the runbook walked straight past it.
run "activate REFUSES until the external monitor is confirmed" 1 -- activate --yes --admin-ops-confirmed "$URL" "$RUN_ID"
[[ ! -s "$PSQL_LOG" ]] && ok "...and reached no database" || bad "...and reached no database"
grep -qF 'monitor-confirmed' "$TMP/out" && ok "...and says how to satisfy it" || bad "...and says how to satisfy it"

# The Admin Notification Operations release unit is a MANDATORY prerequisite for any canary or
# activation and cannot be detected from here, so the operator asserts it — same posture as the
# edge kill switch and the external monitor.
run "canary REFUSES until admin notification operations is confirmed shipped" 1 -- canary --yes "$URL" "$RUN_ID"
[[ ! -s "$PSQL_LOG" ]] && ok "...and reached no database" || bad "...and reached no database"
run "activate REFUSES until admin notification operations is confirmed shipped" 1 -- activate --yes --monitor-confirmed "$URL" "$RUN_ID"
[[ ! -s "$PSQL_LOG" ]] && ok "...and reached no database either" || bad "...and reached no database either"

run "activate verifies and arms in ONE artifact" 0 -- activate --yes --monitor-confirmed --admin-ops-confirmed "$URL" "$RUN_ID"
logged "run_id=$RUN_ID" && ok "activate passes the canary run id INTO the gate" \
  || { bad "activate passes the canary run id INTO the gate"; cat "$PSQL_LOG"; }
logged 'activate.sql' && ok "activate runs the transactional activate.sql" || bad "activate runs the transactional activate.sql"

# THE ARM MUST NOT BE A SEPARATE STATEMENT. Checking in one psql process and arming by name in
# another is a time-of-check/time-of-use hole: between them the job can be altered, replaced or
# deleted, and an arm-by-name matching ZERO rows succeeds silently — so the script would report
# ARMED over a job that is no longer there. activate.sql locks the row, asserts, arms that jobid and
# checks the postcondition inside one transaction, so no bare `active := true` may appear here.
if grep -qF -- 'active := true' "$PSQL_LOG"; then
  bad "the cron is armed only inside the transactional artifact (found a separate arm statement)"
  cat "$PSQL_LOG"
else
  ok "the cron is armed only inside the transactional artifact"
fi
grep -qF 'FOR UPDATE' "$HERE/../sql/activate.sql" && ok "activate.sql locks the job row before asserting" \
  || bad "activate.sql locks the job row before asserting"
grep -qE '^\s*BEGIN;' "$HERE/../sql/activate.sql" && grep -qE '^\s*COMMIT;' "$HERE/../sql/activate.sql" \
  && ok "activate.sql is one explicit transaction" || bad "activate.sql is one explicit transaction"

# The read-only dry run exists, changes nothing, and needs no --yes.
run "preflight is read-only and needs no --yes" 0 -- preflight "$URL" "$RUN_ID"
logged 'activation_preflight.sql' && ok "preflight runs the dry-run artifact" || bad "preflight runs the dry-run artifact"
if grep -qF -- 'active := true' "$PSQL_LOG"; then bad "...and arms nothing"; else ok "...and arms nothing"; fi
run "preflight REFUSES without a canary run id" 1 -- preflight "$URL"

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

# ── a FAILING preflight must stop the arm ────────────────────────────────────
# The whole point of the preflight is that it can refuse. Without a stub that can fail, nothing
# proved the arm command was actually downstream of it rather than merely printed before it.
export PSQL_LOG="$TMP/log.preflight_fail"; : > "$PSQL_LOG"
set +e
STUB_FAIL_ON=activate.sql EXPECTED_REF="$REF" bash "$SCRIPT" activate --yes --monitor-confirmed --admin-ops-confirmed "$URL" "$RUN_ID" >"$TMP/out" 2>&1
pf_rc=$?
set -e
[[ "$pf_rc" != "0" ]] && ok "a failing preflight fails the activate subcommand (rc=$pf_rc)" \
  || bad "a failing preflight fails the activate subcommand"
grep -qF 'active := true' "$PSQL_LOG" && bad "...and the cron is NEVER armed after it" \
  || ok "...and the cron is NEVER armed after it"

# ── the thing that must never happen ──────────────────────────────────────────
if grep -rqF 'cron.unschedule' "$SCRIPT" "$HERE/../sql"; then
  bad "no path unschedules the job to pause it"
else
  ok "no path unschedules the job to pause it (deactivate, never unschedule)"
fi

# ── the canary takes a REAL run id, never a snapshot ──────────────────────────
run "canary REFUSES a non-uuid run id" 1 -- canary --yes --admin-ops-confirmed "$URL" "before-after-snapshot"
run "canary reconciles the id it is given" 0 -- canary --yes --admin-ops-confirmed "$URL" "11111111-1111-4111-8111-111111111111"
logged 'reconcile_notification_digest_run' && ok "canary reconciles the ACTUAL run" || bad "canary reconciles the ACTUAL run"
# Reconciling is not passing: reconcile succeeds for ANY existing run, so the canary must also be
# VERIFIED to have delivered, or an empty dispatch run would satisfy the gate.
logged 'canary_verify.sql' && ok "canary VERIFIES the run delivered, not merely that it existed" \
  || bad "canary VERIFIES the run delivered, not merely that it existed"
export PSQL_LOG="$TMP/log.canary_fail"; : > "$PSQL_LOG"
set +e
STUB_FAIL_ON=canary_verify EXPECTED_REF="$REF" bash "$SCRIPT" canary --yes --admin-ops-confirmed "$URL" \
  "11111111-1111-4111-8111-111111111111" >/dev/null 2>&1
cv_rc=$?
set -e
[[ "$cv_rc" != "0" ]] && ok "an unverifiable canary fails the subcommand" || bad "an unverifiable canary fails the subcommand"

# ── canary-invoke: the one step that SENDS ───────────────────────────────────
# It used to be a hand-written statement in the runbook, run outside every guard in this bundle.
# Each gate below is the discriminator for one of the guards it now goes through: every OTHER
# prerequisite is supplied, so a refusal can only be the one under test.
CANARY_RUN_ID="22222222-2222-4222-8222-222222222222"

run "canary-invoke REFUSES without --yes" 1 -- canary-invoke --admin-ops-confirmed --monitor-confirmed "$URL"
[[ ! -s "$PSQL_LOG" ]] && ok "...and queued nothing" || bad "...and queued nothing"
run "canary-invoke REFUSES without --admin-ops-confirmed" 1 -- canary-invoke --yes --monitor-confirmed "$URL"
[[ ! -s "$PSQL_LOG" ]] && ok "...and queued nothing either" || bad "...and queued nothing either"
# The monitor must be watching BEFORE the first send, not before the arm — the canary IS the first
# send, so requiring it only at `activate` would start the watch one step too late.
run "canary-invoke REFUSES until the external monitor is confirmed" 1 -- canary-invoke --yes --admin-ops-confirmed "$URL"
[[ ! -s "$PSQL_LOG" ]] && ok "...and reached no database" || bad "...and reached no database"
grep -qF 'monitor-confirmed' "$TMP/out" && ok "...and says how to satisfy it" || bad "...and says how to satisfy it"
run "canary-invoke REFUSES a url belonging to another project" 1 -- \
  canary-invoke --yes --admin-ops-confirmed --monitor-confirmed "$OTHER_URL"
[[ ! -s "$PSQL_LOG" ]] && ok "...and sent nothing to it" || bad "...and sent nothing to it"

# The ceiling is INTERPOLATED INTO SQL, so a non-numeric value is an injection vector rather than a
# typo. It must be refused before psql is reached at all.
run "canary-invoke REFUSES a non-numeric --max-recipients" 1 -- \
  canary-invoke --yes --admin-ops-confirmed --monitor-confirmed "--max-recipients=1; DROP TABLE cron.job" "$URL"
[[ ! -s "$PSQL_LOG" ]] && ok "...and ran no SQL with it" || { bad "...and ran no SQL with it"; cat "$PSQL_LOG"; }
run "canary-invoke REFUSES --max-recipients=0" 1 -- \
  canary-invoke --yes --admin-ops-confirmed --monitor-confirmed --max-recipients=0 "$URL"
run "canary-invoke REFUSES a ceiling that is not a canary" 1 -- \
  canary-invoke --yes --admin-ops-confirmed --monitor-confirmed --max-recipients=51 "$URL"

run "canary-invoke invokes, then reads the reply" 0 -- \
  canary-invoke --yes --admin-ops-confirmed --monitor-confirmed "$URL"
logged 'canary_invoke.sql' && ok "canary-invoke runs the transactional invoke artifact" \
  || bad "canary-invoke runs the transactional invoke artifact"
logged 'max_recipients=1' && ok "...bounded to ONE recipient by default" || bad "...bounded to ONE recipient by default"
logged 'canary_invoke_response.sql' && ok "...and reads pg_net's reply" || bad "...and reads pg_net's reply"
logged 'request_id=4242' && ok "...for the request id the invocation ACTUALLY returned" \
  || { bad "...for the request id the invocation ACTUALLY returned"; cat "$PSQL_LOG"; }
grep -qF "$CANARY_RUN_ID" "$TMP/out" && ok "...and surfaces the dispatchRunId for the next step" \
  || { bad "...and surfaces the dispatchRunId for the next step"; cat "$TMP/out"; }
if grep -qF -- 'active := true' "$PSQL_LOG"; then bad "...and arms nothing"; else ok "...and arms nothing"; fi
run "canary-invoke honours an explicit ceiling" 0 -- \
  canary-invoke --yes --admin-ops-confirmed --monitor-confirmed --max-recipients=3 "$URL"
logged 'max_recipients=3' && ok "...passing it into the artifact" || bad "...passing it into the artifact"

# TWO request ids is not a choice to make. Picking one would mean reporting the outcome of a request
# this invocation may not have caused — the same reasoning that makes `canary` take the run id the
# worker returned rather than a before/after snapshot.
export PSQL_LOG="$TMP/log.invoke_two_ids"; : > "$PSQL_LOG"
set +e
env STUB_CANARY_SECOND_REQUEST_ID=4243 EXPECTED_REF="$REF" PSQL_LOG="$PSQL_LOG" bash "$SCRIPT" \
  canary-invoke --yes --admin-ops-confirmed --monitor-confirmed "$URL" >"$TMP/out" 2>&1
c2_rc=$?
set -e
[[ "$c2_rc" != "0" ]] && ok "two request-id markers are refused, not guessed between" \
  || { bad "two request-id markers are refused, not guessed between"; cat "$TMP/out"; }
grep -qF 'canary_invoke_response.sql' "$PSQL_LOG" && bad "...and no reply is read for either" \
  || ok "...and no reply is read for either"

# A REFUSED invocation must not go on to read a reply: there is no request, and polling for one
# would print a stale response from an earlier rollout as if it were this one's.
export PSQL_LOG="$TMP/log.invoke_fail"; : > "$PSQL_LOG"
set +e
STUB_FAIL_ON=canary_invoke.sql EXPECTED_REF="$REF" bash "$SCRIPT" \
  canary-invoke --yes --admin-ops-confirmed --monitor-confirmed "$URL" >"$TMP/out" 2>&1
ci_rc=$?
set -e
[[ "$ci_rc" != "0" ]] && ok "a refused invocation fails the subcommand (rc=$ci_rc)" \
  || bad "a refused invocation fails the subcommand"
grep -qF 'canary_invoke_response.sql' "$PSQL_LOG" && bad "...and never polls for a reply it did not cause" \
  || ok "...and never polls for a reply it did not cause"

# A non-200 is not a canary. Reporting success over it would send the operator straight to `canary`,
# which would then fail against a run that never existed.
export PSQL_LOG="$TMP/log.invoke_500"; : > "$PSQL_LOG"
set +e
env STUB_CANARY_STATUS=500 EXPECTED_REF="$REF" PSQL_LOG="$PSQL_LOG" bash "$SCRIPT" \
  canary-invoke --yes --admin-ops-confirmed --monitor-confirmed "$URL" >"$TMP/out" 2>&1
c500_rc=$?
set -e
[[ "$c500_rc" != "0" ]] && ok "a non-200 worker reply fails the subcommand" || bad "a non-200 worker reply fails the subcommand"

# 200 WITHOUT a dispatchRunId is what a disabled worker answers. Nothing was sent and there is
# nothing to reconcile, so calling that a successful canary would be simply false.
export PSQL_LOG="$TMP/log.invoke_disabled"; : > "$PSQL_LOG"
set +e
env 'STUB_CANARY_BODY={"status":"disabled","reason":"disabled"}' EXPECTED_REF="$REF" PSQL_LOG="$PSQL_LOG" \
  bash "$SCRIPT" canary-invoke --yes --admin-ops-confirmed --monitor-confirmed "$URL" >"$TMP/out" 2>&1
cdis_rc=$?
set -e
[[ "$cdis_rc" != "0" ]] && ok "a 200 with no dispatchRunId is NOT reported as a canary" \
  || { bad "a 200 with no dispatchRunId is NOT reported as a canary"; cat "$TMP/out"; }
grep -qF 'DIGEST_SEND_ENABLED' "$TMP/out" && ok "...and names the likeliest cause" || bad "...and names the likeliest cause"

# The poll is BOUNDED. An unbounded wait on a reply that never arrives is a hung terminal in front
# of an operator who has just sent mail and needs to know what happened.
export PSQL_LOG="$TMP/log.invoke_poll"; : > "$PSQL_LOG"
set +e
env STUB_FAIL_ON=canary_invoke_response CANARY_POLL_ATTEMPTS=3 CANARY_POLL_INTERVAL=0 \
  EXPECTED_REF="$REF" PSQL_LOG="$PSQL_LOG" bash "$SCRIPT" \
  canary-invoke --yes --admin-ops-confirmed --monitor-confirmed "$URL" >"$TMP/out" 2>&1
cpoll_rc=$?
set -e
[[ "$cpoll_rc" != "0" ]] && ok "an unanswered request fails the subcommand rather than hanging" \
  || bad "an unanswered request fails the subcommand rather than hanging"
polls="$(grep -cF 'canary_invoke_response.sql' "$PSQL_LOG" || true)"
[[ "$polls" == "3" ]] && ok "...after exactly CANARY_POLL_ATTEMPTS attempts" \
  || bad "...after exactly CANARY_POLL_ATTEMPTS attempts (got $polls)"
grep -qF 'UNKNOWN' "$TMP/out" && ok "...and says the send is UNKNOWN, not 'did not happen'" \
  || bad "...and says the send is UNKNOWN, not 'did not happen'"

# THE PROPERTY THAT MAKES THIS SAFE AT ALL: the artifact never transcribes the command. It executes
# the job's own stored text after hashing it, so what is invoked is what was reviewed — and this
# repo's legacy-key scan stays meaningful because no checked-in .sql grows a key-sending statement.
# COMMENTS STRIPPED FIRST. That artifact explains at length why it does NOT write the request out,
# and naming http_post in prose is not transcribing it — the same vacuous-match trap this slice has
# paid for repeatedly, in a new place.
if sed 's/--.*$//' "$HERE/../sql/canary_invoke.sql" | grep -qE 'http_post|Authorization'; then
  bad "canary_invoke.sql transcribes the request instead of executing the reviewed command"
else
  ok "canary_invoke.sql never transcribes the request (it executes the hash-pinned stored command)"
fi
grep -qF 'FOR UPDATE' "$HERE/../sql/canary_invoke.sql" && ok "canary_invoke.sql locks the job row before asserting" \
  || bad "canary_invoke.sql locks the job row before asserting"
grep -qF '\i _job_identity_assertions.sql' "$HERE/../sql/canary_invoke.sql" \
  && ok "canary_invoke.sql re-runs the shared job-identity gate at send time" \
  || bad "canary_invoke.sql re-runs the shared job-identity gate at send time"

# ── the identity guard cannot be talked round ────────────────────────────────
# libpq takes host/hostaddr/user/dbname from the QUERY STRING and lets them override the
# authority, so a url that looks like EXPECTED_REF can still connect elsewhere.
run "refuses a url whose query string overrides the host" 1 -- \
  rollback --yes "${URL}?host=db.tsrqponmlkjihgfedcba.supabase.co"
[[ ! -s "$PSQL_LOG" ]] && ok "...and ran nothing against it" || bad "...and ran nothing against it"
run "refuses a query string even on a read-only subcommand" 1 -- status "${URL}?user=postgres"

# libpq accepts TWO connection-string forms and the guard only ever parsed one. Keyword/value
# conninfo (`host=... user=... dbname=...`, last occurrence winning) split at the first '://' into
# an authority naming the EXPECTED project, passed every check, and was then read by psql as
# keywords — connecting to the host named later in the same string.
run "refuses libpq KEYWORD conninfo that hides the expected ref in a dbname=" 1 -- \
  status "dbname=${URL} host=db.tsrqponmlkjihgfedcba.supabase.co user=postgres dbname=postgres"
[[ ! -s "$PSQL_LOG" ]] && ok "...and ran nothing against it" || { bad "...and ran nothing against it"; cat "$PSQL_LOG"; }
run "refuses a url with trailing keyword parameters appended" 1 -- \
  status "${URL} hostaddr=203.0.113.10"
# ...and it must be the WHITESPACE rule that stops it. Every whitespace case is also caught by the
# scheme or database-path check, so asserting only "refused" left the whitespace guard unpinned:
# the reason is the discriminator.
grep -qF 'contains whitespace' "$TMP/out" && ok "...and it is the whitespace rule that refuses it" \
  || { bad "...and it is the whitespace rule that refuses it"; cat "$TMP/out"; }

# libpq URIs take a COMMA-SEPARATED host list and FAIL OVER along it, so the first host deciding
# nothing is the whole problem. Every multi-host form is also caught by the single-host[:port] shape
# check or the exact host compare, so — as with whitespace — the REASON is the discriminator.
run "refuses a url naming MULTIPLE HOSTS to fail over between" 1 -- \
  status "postgresql://postgres.${REF}:pw@aws-0-eu-central-1.pooler.supabase.com:1,attacker.example:5432/postgres"
grep -qF 'MULTIPLE HOSTS' "$TMP/out" && ok "...and it is the multi-host rule that refuses it" \
  || { bad "...and it is the multi-host rule that refuses it"; cat "$TMP/out"; }
run "refuses anything that does not start with a postgres scheme" 1 -- \
  status "host=db.tsrqponmlkjihgfedcba.supabase.co user=postgres"

# THE DISCRIMINATOR FOR THE SCHEME RULE. Every conninfo case above contains whitespace, so all of
# them are refused by the whitespace rule whether or not the scheme is checked — deleting the scheme
# check left them all green. This one has NO whitespace and its authority names the EXPECTED project,
# so it sails through the host/user validation; only "it must start with postgres(ql)://" stops it.
# psql would read a string with no scheme and no '=' as a DBNAME and connect to PGHOST/the local
# socket instead, which is a different server with a passing ref check.
run "refuses a scheme-LESS string whose authority names the expected project" 1 -- \
  status "postgres.${REF}:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"
[[ ! -s "$PSQL_LOG" ]] && ok "...and ran nothing against it" || { bad "...and ran nothing against it"; cat "$PSQL_LOG"; }
run "still accepts the ordinary postgresql:// url" 0 -- status "$URL"

# ── the artifacts it runs must actually exist ────────────────────────────────
# The stub never opens the file it is handed, so a broken `\i` inside an artifact — or a missing
# artifact altogether — would otherwise pass here and fail only in front of an operator.
for f in status.sql activation_preflight.sql activate.sql _activation_assertions.sql rollback_verify.sql \
         canary_invoke.sql canary_invoke_response.sql; do
  [[ -f "$HERE/../sql/$f" ]] && ok "artifact $f exists" || bad "artifact $f exists"
done
for f in activation_preflight.sql activate.sql canary_verify.sql rollback_verify.sql \
         canary_invoke.sql canary_invoke_response.sql; do
  # EVERY \i, not just the first: activate.sql and activation_preflight.sql each pull in the
  # shared assertions as well as the assert helpers, and a broken second include fails only in
  # front of an operator.
  while read -r inc; do
    [[ -n "$inc" ]] || continue
    ( cd "$HERE/../sql" && [[ -f "$inc" ]] ) && ok "$f include resolves from sql/: $inc" \
      || bad "$f include resolves from sql/ (got '$inc')"
  done < <(grep -o '^\\i [^ ]*' "$HERE/../sql/$f" | awk '{print $2}')
done

# ── sourcing must not execute ────────────────────────────────────────────────
# Uses `status`, which SUCCEEDS when run: with the guard, sourcing must refuse (non-zero, and no
# psql at all); without it, sourcing would run the subcommand and log the artifact. Asserting only
# "non-zero" was not a discriminator — a mutating subcommand exits non-zero on its own gates
# whether or not the guard exists, so that version stayed green with the guard deleted.
export PSQL_LOG="$TMP/log.source"; : > "$PSQL_LOG"
set +e
( EXPECTED_REF="$REF" PSQL_LOG="$PSQL_LOG" \
  bash -c 'script="$2"; set -- status "$1"; source "$script"' _ "$URL" "$SCRIPT" >"$TMP/out" 2>&1 )
src_rc=$?
set -e
[[ "$src_rc" != "0" ]] && ok "sourcing refuses (rc=$src_rc) instead of running a subcommand that would have SUCCEEDED" \
  || bad "sourcing refuses instead of running a subcommand that would have SUCCEEDED"
[[ ! -s "$PSQL_LOG" ]] && ok "...and sourcing reached no database at all" || { bad "...and sourcing reached no database at all"; cat "$PSQL_LOG"; }
grep -qF 'must be EXECUTED, not sourced' "$TMP/out" && ok "...and says why" || bad "...and says why"

# ── the libpq ENVIRONMENT cannot redirect the connection ─────────────────────
# assert_conn_url_is_ref validates the URL. libpq does not connect from the URL alone: PGHOSTADDR
# is a SEPARATE parameter that supplies the address directly and applies even when the URI carries
# a host, and PGSERVICE/PGSYSCONFDIR can inject one from a service file. So an expected-ref url
# passed every string check and connected somewhere else entirely.
#
# The property is about the CHILD process, so that is what is asserted: the stub records the PG*
# names it was actually given. Checking the parent's environment would pass with `env -u` deleted.
env_has() { grep -qxF -- "$1" "$PSQL_ENV_LOG"; }

# `VAR=x some_shell_function` leaks the assignment into the caller in bash, so the extra
# environment is applied with `env` around the script instead of prefixed onto `run`.
run_env() {   # run_env <name> <expect_rc> <VAR=val> -- args...
  local name="$1" expect="$2" extra="$3"; shift 4
  export PSQL_LOG="$TMP/log.$RANDOM"; : > "$PSQL_LOG"
  export PSQL_ENV_LOG="$TMP/env.$RANDOM"; : > "$PSQL_ENV_LOG"
  set +e
  env "EXPECTED_REF=$REF" "PSQL_LOG=$PSQL_LOG" "PSQL_ENV_LOG=$PSQL_ENV_LOG" "$extra" \
    bash "$SCRIPT" "$@" >"$TMP/out" 2>&1
  local rc=$?
  set -e
  if [[ "$rc" == "$expect" ]]; then ok "$name (rc=$rc)"; else bad "$name (rc=$rc, expected $expect)"; cat "$TMP/out"; fi
}

run_env "PGHOSTADDR does not stop the run..." 0 "PGHOSTADDR=203.0.113.10" -- status "$URL"
env_has PGHOSTADDR && bad "...but is STRIPPED from the psql environment" \
  || ok "...but is STRIPPED from the psql environment"
grep -qF 'PGHOSTADDR is set and is being REMOVED' "$TMP/out" && ok "...and the operator is told" \
  || bad "...and the operator is told"

run_env "PGSERVICE is stripped too" 0 "PGSERVICE=elsewhere" -- status "$URL"
env_has PGSERVICE && bad "...PGSERVICE absent from the psql environment" \
  || ok "...PGSERVICE absent from the psql environment"

run_env "PGOPTIONS (search_path injection) is stripped" 0 "PGOPTIONS=-c search_path=evil" -- status "$URL"
env_has PGOPTIONS && bad "...PGOPTIONS absent from the psql environment" \
  || ok "...PGOPTIONS absent from the psql environment"

# An UNKNOWN PG* variable is refused outright rather than guessed at: it may well be a newer libpq
# identity parameter, and this bundle cannot know that it is safe to leave in place.
run_env "an UNRECOGNISED PG* variable stops the run" 1 "PGFUTUREHOSTPARAM=somewhere" -- status "$URL"
[[ ! -s "$PSQL_LOG" ]] && ok "...and reached no database at all" || bad "...and reached no database at all"

# ...but the credential variables an operator legitimately needs are left alone.
run_env "PGPASSWORD is NOT refused (it cannot redirect a connection)" 0 "PGPASSWORD=hunter2" -- status "$URL"
env_has PGPASSWORD && ok "...and still reaches psql" || bad "...and still reaches psql"

# An empty value is not a set value, to libpq — refusing one would be a false alarm.
run_env "an EMPTY unrecognised PG* variable is not treated as set" 0 "PGFUTUREHOSTPARAM=" -- status "$URL"

# ~/.psqlrc runs before the artifact and can \set variables the artifact reads.
run "psql is invoked with --no-psqlrc on the artifact path" 0 -- status "$URL"
logged '--no-psqlrc' && ok "...--no-psqlrc on the artifact path" || bad "...--no-psqlrc on the artifact path"
run "and on the -c path too" 0 -- rollback --yes --switch-off-confirmed "$URL"
logged '--no-psqlrc' && ok "...--no-psqlrc on the -c path" || bad "...--no-psqlrc on the -c path"

printf '\n================  %d passed, %d failed  ================\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]]
