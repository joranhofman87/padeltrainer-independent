#!/usr/bin/env bash
# ===========================================================================
# run-enablement.sh — 10c-b Release Units 2 and 3, as individually gated
# operator subcommands. There is NO auto-run and no "do it all" mode: every
# step that changes anything requires --yes and re-asserts the project ref.
#
# This script is INERT by itself. It performs no send, arms nothing on import,
# and its read-only subcommands are safe to run at any time.
#
# THE SEQUENCE, and why it is this way round (ADR 0008 runbook step 5):
#   1. status              — read the world. Safe, always.
#   2. smoke-disabled      — invoke through the REAL Vault/pg_net path while the
#                            switch is OFF. Must answer exactly
#                            200 {"status":"disabled","reason":"disabled"} and
#                            move NO counter. Proves the wiring without sending.
#   0. (owner) SHIP Admin Notification Operations — mandatory before any canary or activation.
#   3. (owner) set DIGEST_SEND_ENABLED=true on the worker (an edge env var; nothing here sees it).
#   3b. enable-engine --yes — turn the digest engine on for the cutover event, and ONLY that event,
#                            in one transaction that refuses while the cron is armed, checks it
#                            changed exactly one row, and asserts the postcondition. This step used
#                            to be a raw UPDATE pasted into a shell; the activation gate REQUIRES it
#                            to be true already.
#   3c. (owner) wire the EXTERNAL cron/uptime monitor on notif_digest_worker_liveness() and
#                            verify it alerts on a stale last_success_at — before the canary.
#   4. canary-invoke --yes --admin-ops-confirmed --monitor-confirmed [--max-recipients=N]
#                          — invoke the worker ONCE, cron still INACTIVE, and surface the response so
#                            the operator reads dispatchRunId from it. This is the step that sends a
#                            real email, which is exactly why it is no longer hand-written: it runs
#                            the job's OWN reviewed command under the same EXPECTED_REF, PG* and
#                            job-identity guards as every other step, and bounds how many recipients
#                            it can reach. --yes is the owner's intent; it is not a reason to run the
#                            one sending statement outside every guard this bundle exists to provide.
#   5. canary --yes --admin-ops-confirmed
#                          — reconcile THAT run id and verify it delivered. Invokes nothing.
#   6. preflight           — read-only dry run of the activation gate. Arms nothing.
#   7. activate --yes --monitor-confirmed --admin-ops-confirmed
#                          — arm the cron, but only after activation_preflight
#                            passes. Enabling the cron BEFORE the switch would
#                            schedule a worker that finds nothing and reports
#                            healthy — a green light over an engine still off.
#   8. rollback --yes      — switch OFF and DEACTIVATE the cron, then prove both.
#
# NEVER unschedule the job to pause it. Deactivate. Unscheduling destroys the
# reviewed Vault-backed command, and re-creating it by hand under time pressure
# is how a wrong endpoint or a missing bearer gets introduced.
#
# Env: EXPECTED_REF (the target project ref). Mutating steps additionally need
# whatever psql/supabase credentials the operator already uses; this script
# never reads, prints or stores a secret.
# ===========================================================================
set -Eeuo pipefail

# EXECUTED, NEVER SOURCED. Sourcing this file used to run the dispatcher: a parent shell that
# happened to hold EXPECTED_REF and positional parameters would perform the mutation instead of
# merely loading definitions, which is the opposite of "inert on import".
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  printf 'run-enablement.sh must be EXECUTED, not sourced\n' >&2
  return 2 2>/dev/null || exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_DIR="$HERE/sql"
# shellcheck source=../notif-10ca3/lib/common.sh
source "$HERE/../notif-10ca3/lib/common.sh"

EVENT_KEY="open_slots_player"
JOB_NAME="notification-digest-worker"

require_env EXPECTED_REF "set EXPECTED_REF to the target project ref (20 chars)"
assert_ref_format "$EXPECTED_REF"

# THE URL IS NOT THE WHOLE CONNECTION. libpq also reads the PG* environment, and PGHOSTADDR /
# PGSERVICE / PGSYSCONFDIR / PGOPTIONS can each redirect a connection whose url passed every
# EXPECTED_REF check. This refuses anything unrecognised and strips the rest inside psql_safe.
# Run BEFORE any subcommand so a hostile environment stops the script rather than one artifact.
assert_no_hostile_libpq_env

usage() {
  cat >&2 <<'USAGE'
usage: EXPECTED_REF=<ref> run-enablement.sh <subcommand> [--yes] <db_url>

  status <db_url>                 read-only: engine flags, cron state, liveness, counters
  assert-inert <db_url>           read-only GATE, run BEFORE any switch: the cron job present is
                                  EXACTLY the reviewed one AND inactive, and no engine is enabled.
                                  `status` prints those facts; this one fails on them
  enable-engine --yes <db_url>    turn the digest engine ON for the cutover event only, row-count
                                  checked and with a postcondition. Handing the operator a raw
                                  UPDATE meant the single most consequential statement in the
                                  runbook ran with no EXPECTED_REF, no PG* stripping and no proof
  preflight <db_url> <run_id>     read-only DRY RUN of the activation gate — every assertion,
                                  nothing armed. Not the gate itself: `activate` re-checks under a
                                  row lock in the same transaction as the arm
  smoke-disabled --switch-off-confirmed <db_url>
                                  read-only: capture counters either side of the disabled
                                  invocation. Requires you to have verified DIGEST_SEND_ENABLED
                                  is off — no SQL can see an edge env var
  canary-invoke --yes --admin-ops-confirmed --monitor-confirmed [--max-recipients=N] <db_url>
                                  SENDS. Invokes the worker ONCE by running the cron job's OWN
                                  stored command, after asserting it hashes to the reviewed value
                                  under a row lock — so what is invoked is what was reviewed, not a
                                  hand-typed lookalike naming some other endpoint. Refuses an armed
                                  cron, a disabled engine, an in-flight run, and a reachable
                                  population above --max-recipients (default 1). Prints the reply so
                                  you can read dispatchRunId; that uuid is what `canary` verifies
  canary --yes --admin-ops-confirmed <db_url> <run_id>
                                  reconcile ONE canary's ACTUAL returned run id
  activate --yes --monitor-confirmed --admin-ops-confirmed <db_url> <run_id>
                                  verify FOR THAT CANARY RUN and arm the cron, in ONE transaction
                                  against the LOCKED job row. The run id is the one `canary` just
                                  verified — activation is never allowed to rest on some older
                                  rollout's evidence, nor on a job that changed after the check.
                                  --monitor-confirmed asserts the EXTERNAL cron/uptime monitor on
                                  notif_digest_worker_liveness() is live: no SQL can see it, and it
                                  is the only detector for "the worker was never invoked"
  rollback --yes --switch-off-confirmed <db_url>
                                  set DIGEST_SEND_ENABLED=false FIRST (owner action, outside this
                                  script), then this clears the event flag, deactivates the cron,
                                  and proves both plus quiescence

Every mutating subcommand requires --yes AND a db url whose host encodes EXPECTED_REF.
USAGE
  exit 2
}

# --yes may appear anywhere after the subcommand; strip it and remember it.
CONFIRMED=0
SWITCH_OFF_CONFIRMED=0
MONITOR_CONFIRMED=0
ADMIN_OPS_CONFIRMED=0
# The canary's ceiling on reachable recipients. ONE by default: a canary that can reach more than one
# recipient is not a canary, and the whole sequence describes it as "one recipient".
MAX_RECIPIENTS=1
ARGS=()
SUB="${1:-}"; shift || usage
for a in "$@"; do
  case "$a" in
    --yes)                   CONFIRMED=1 ;;
    --switch-off-confirmed)  SWITCH_OFF_CONFIRMED=1 ;;
    --monitor-confirmed)     MONITOR_CONFIRMED=1 ;;
    --admin-ops-confirmed)   ADMIN_OPS_CONFIRMED=1 ;;
    --max-recipients=*)      MAX_RECIPIENTS="${a#*=}" ;;
    *)                       ARGS+=("$a") ;;
  esac
done

require_confirmed() {
  [[ "$CONFIRMED" == "1" ]] || die "$1 changes production — re-run with --yes"
}

# THE THIRD PRECONDITION THIS CANNOT SEE. The Admin Notification Operations release unit — global
# admin visibility into the pipeline plus safe controls — is a MANDATORY prerequisite for any
# canary or activation. NOT because a failure would be invisible: a bad canary shows up in its HTTP
# result, in canary_verify.sql and in the worker's Slack alert. Because there is no in-product,
# GLOBAL view of the pipeline and no safe controls, so intervening means a hand-written
# psql-session against production. It is a separate release unit and nothing in this database can
# detect whether it has shipped, so the operator asserts it, exactly as they assert the edge kill
# switch and the external monitor.
#
# WHAT THIS FLAG GATES, now that the send has a subcommand. `canary-invoke` is the step that performs
# the invocation, and it requires this flag before it queues anything — so the release unit is a
# mechanical precondition on mail going out, not merely on reconciling it (`canary`) and arming the
# cron afterwards (`activate`). Said plainly rather than implied, because the earlier version of this
# comment correctly warned that a flag which looks like it blocks a send and does not is worse than
# no flag; that was true while step 4 was hand-written, and it no longer is.
require_admin_ops() {
  [[ "$ADMIN_OPS_CONFIRMED" == "1" ]] || die \
    "$1 requires --admin-ops-confirmed: the Admin Notification Operations release unit must be SHIPPED and verified first — see docs/FOUNDATION_ROADMAP.md for its acceptance criteria. Without it there is no in-product view of the pipeline and no safe controls, so intervening in a real send means a hand-written psql-session against production"
}

# THE SECOND PRECONDITION THIS CANNOT SEE. The external cron/uptime monitor on
# notif_digest_worker_liveness() is the ONLY detector for a worker that is never invoked — an
# unscheduled or disabled job, a missing Vault secret, a paused project all produce silence, and the
# in-worker Slack alert needs the worker to run in order to fire. It lives outside this database
# entirely, so nothing here can verify it; the docs called it a precondition while the runbook walked
# straight past it. Shared by `canary-invoke` and `activate` so the two cannot drift: the runbook
# puts it at step 3c precisely so it is already watching when the FIRST send happens, which is the
# canary — requiring it only at activation would have it start watching one step too late.
require_monitor() {
  [[ "$MONITOR_CONFIRMED" == "1" ]] || die \
    "$1 requires --monitor-confirmed: wire the EXTERNAL cron/uptime monitor on public.notif_digest_worker_liveness() FIRST and verify it alerts on a stale last_success_at (this script cannot see anything outside the database, and it is the only detector for a worker that is never invoked)"
}

db_url() {
  local url="${ARGS[0]:-}"
  [[ -n "$url" ]] || die "a database url is required"
  # The url must belong to EXPECTED_REF. This is the guard that stops a correct command from
  # being run against the wrong project.
  #
  # A QUERY STRING IS REFUSED OUTRIGHT, before that check. libpq accepts identity parameters —
  # host, hostaddr, user, dbname — in the query string, and they OVERRIDE the authority. So a url
  # whose authority names the expected project can still connect to a different one, and the
  # authority-only validator would wave it through. There is no legitimate need for one here, so
  # the safe rule is the simple one: no query string at all.
  case "$url" in
    *\?*) die "refusing a connection url with a query string: libpq query parameters (host, hostaddr, user, dbname) override the authority and would defeat the EXPECTED_REF check" ;;
  esac
  assert_conn_url_is_ref "$EXPECTED_REF" "$url"
  printf '%s' "$url"
}

# A run id is always the uuid the invocation ITSELF returned — never a before/after snapshot, and
# never a name. Shared by `canary` and `activate` so the two cannot drift apart.
require_run_id() {   # $1 = candidate, $2 = which subcommand wants it
  local id="${1:-}"
  [[ -n "$id" ]] || die "$2 requires the ACTUAL run id the canary invocation returned"
  [[ "$id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
    || die "run id must be a uuid — never a before/after snapshot"
  printf '%s' "$id"
}

# Artifacts are ALWAYS run from the sql directory, because psql resolves `\i` relative to the
# current working directory — running one from anywhere else silently fails to find its includes.
# psql_safe, never bare psql: the PG* environment can redirect the connection past the url guard.
run_sql() {   # $1 = url, $2 = artifact, $@ = extra psql args
  local url="$1" artifact="$2"; shift 2
  ( cd "$SQL_DIR" && psql_safe "$url" -v ON_ERROR_STOP=1 -f "$artifact" "$@" )
}

# Same runner, but the output is CAPTURED as well as shown, because `canary-invoke` has to read a
# request id back out of it. It is echoed to stderr first and read second, so a failure the operator
# needs to see is never swallowed by the parsing.
#
# NEVER `run_sql ... | tee`: under `set -Eeuo pipefail` the status of a pipeline is not psql's alone,
# and this repo has already lost a whole session to a red gate hidden behind a pipe. Capture, print,
# then test the recorded status.
run_sql_capture() {   # $1 = outfile, $2 = url, $3 = artifact, $@ = extra psql args
  local outfile="$1"; shift
  local url="$1" artifact="$2"; shift 2
  local rc=0
  set +e
  ( cd "$SQL_DIR" && psql_safe "$url" -v ON_ERROR_STOP=1 -f "$artifact" "$@" ) >"$outfile" 2>&1
  rc=$?
  set -e
  cat "$outfile" >&2
  return "$rc"
}

# Pull every occurrence of a strict marker out of captured psql output. Deliberately strict about the
# VALUE shape, and the caller checks the COUNT: slice H's inventory-parse defect was a record read by
# position from a loosely-delimited line, which made a forged field indistinguishable from a real one.
#
# The value ERE is PARENTHESISED here rather than at each call site. `|` binds loosest in an ERE, so
# `NAME=[0-9]+|none` is `(NAME=[0-9]+)` OR `(none)` — which matched the bare word `none` on a
# neighbouring marker line and returned two values for one marker.
marker_values() {   # $1 = file, $2 = marker name, $3 = ERE for the value
  { grep -Eo "$2=($3)" "$1" || true; } | cut -d= -f2- | sort -u
}

case "$SUB" in
  status)
    url="$(db_url)"
    run_sql "$url" status.sql
    ok "status read (no mutation)"
    ;;

  assert-inert)
    # BEFORE the engine goes on, not after. The F migration preserves an existing job's active
    # state on purpose, and the activation preflight only runs at step 6 — so a job left ARMED by an
    # earlier rollout would tick the moment the engine was enabled, reaching the whole population
    # before the controlled canary and before the monitor was watching.
    url="$(db_url)"
    run_sql "$url" assert_inert.sql
    ok "inert confirmed — the reviewed job is present, INACTIVE, and no engine is enabled"
    ;;

  enable-engine)
    # THE MOST CONSEQUENTIAL STATEMENT IN THE RUNBOOK, and it was a raw UPDATE pasted into a shell.
    # Explicit owner intent is the point of --yes; it is not a reason to run the statement outside
    # every guard this bundle exists to provide.
    require_confirmed "enabling the digest engine"
    url="$(db_url)"
    run_sql "$url" enable_engine.sql
    ok "digest engine ENABLED for ${EVENT_KEY} — nothing sends until the worker is invoked"
    ;;

  preflight)
    # A DRY RUN of the activation gate — every assertion, nothing armed, no --yes required because
    # it changes nothing. Useful for finding out what still needs fixing before the owner is asked
    # to arm. It is NOT the gate: `activate` re-runs all of it under a row lock in the same
    # transaction as the arm, because anything checked in a separate statement can change after.
    url="$(db_url)"
    run_id="$(require_run_id "${ARGS[1]:-}" "the activation preflight")"
    run_sql "$url" activation_preflight.sql -v run_id="${run_id}"
    ok "preflight passed for canary run ${run_id} — NOTHING was armed"
    ;;

  smoke-disabled)
    # THE PRECONDITION THIS CANNOT SEE. The worker's real kill switch is the DIGEST_SEND_ENABLED
    # env var on the edge function, not a database flag — so no SQL here can verify it, and a
    # script that quietly assumed it would be inviting a live send under the word "disabled".
    # The operator asserts it explicitly instead.
    [[ "$SWITCH_OFF_CONFIRMED" == "1" ]] || die \
      "smoke-disabled requires --switch-off-confirmed: verify DIGEST_SEND_ENABLED is unset/false on the notification-digest-worker function FIRST (this script cannot read an edge env var)"
    # Read-only on purpose. The INVOCATION itself is the operator's step (through the
    # Vault/pg_net path, exactly as the cron would); this captures the evidence either side of
    # it. Comparing the two captures is what makes "zero count deltas" a fact rather than a
    # claim — and an absolute-zero assertion against a live system would be meaningless.
    url="$(db_url)"
    run_sql "$url" status.sql
    warn "capture this output BEFORE and AFTER the disabled invocation and diff the counter rows;"
    warn "the invocation must answer exactly: 200 {\"status\":\"disabled\",\"reason\":\"disabled\"}"
    ok "smoke evidence captured (no mutation)"
    ;;

  canary-invoke)
    # THE ONE STEP THAT SENDS. It used to be "(owner) invoke the worker by hand" — the only step in
    # the sequence performed with no tooling at all, outside EXPECTED_REF, outside the PG* stripping,
    # with nothing re-checking that the job is still the reviewed one and still inactive. The
    # `assert-inert` gate runs at step 1b, four steps and two switches earlier, so by the time the
    # operator typed that statement its result was stale.
    require_confirmed "invoking the canary (this SENDS a real email)"
    require_admin_ops "invoking the canary"
    require_monitor "canary-invoke"
    url="$(db_url)"

    # VALIDATED BEFORE IT REACHES SQL. The ceiling is interpolated into the artifact, so a
    # non-numeric value is an injection vector, not a typo. (The artifact casts it through a quoted
    # literal as well, so both layers would have to fail.)
    [[ "$MAX_RECIPIENTS" =~ ^[1-9][0-9]*$ ]] \
      || die "--max-recipients must be a positive integer, got '${MAX_RECIPIENTS}'"
    [[ "$MAX_RECIPIENTS" -le 50 ]] \
      || die "--max-recipients=${MAX_RECIPIENTS} is not a canary — a controlled first send reaches one recipient, and this bundle will not pretend otherwise"

    # How long to wait for pg_net's reply. Overridable so the self-test does not sleep, and validated
    # because both values reach `sleep`.
    poll_attempts="${CANARY_POLL_ATTEMPTS:-30}"
    poll_interval="${CANARY_POLL_INTERVAL:-2}"
    [[ "$poll_attempts" =~ ^[1-9][0-9]*$ ]] || die "CANARY_POLL_ATTEMPTS must be a positive integer"
    [[ "$poll_interval" =~ ^[0-9]+$ ]]      || die "CANARY_POLL_INTERVAL must be a non-negative integer"

    CANARY_TMP="$(mktemp -d)"
    # shellcheck disable=SC2064  # expand CANARY_TMP now: it must be removed even if it is reassigned
    trap "rm -rf '$CANARY_TMP'" EXIT
    inv_out="$CANARY_TMP/invoke.out"
    resp_out="$CANARY_TMP/response.out"

    warn "canary-invoke SENDS. It runs the reviewed cron command once, with the cron still inactive."
    if ! run_sql_capture "$inv_out" "$url" canary_invoke.sql -v max_recipients="$MAX_RECIPIENTS"; then
      die "the canary invocation was REFUSED — the transaction rolled back, so NOTHING was queued and nothing was sent. Read the failed assertion above"
    fi

    # EXACTLY ONE request id, or refuse. Guessing which of two to read would mean reporting on a
    # request this invocation may not have made.
    req_id="$(marker_values "$inv_out" CANARY_REQUEST_ID '[0-9]+')"
    case "$req_id" in
      ''|*[!0-9]*) die "the invocation did not print exactly one CANARY_REQUEST_ID (got '${req_id//$'\n'/, }') — refusing to guess which pg_net request to read" ;;
    esac
    ok "queued pg_net request ${req_id} — the request leaves on commit, which has now happened"

    # pg_net is asynchronous: the reply arrives after the commit, so this polls rather than pretends.
    # A permanent failure (say net._http_response is unreadable) simply exhausts the loop and the last
    # captured output is what explains why.
    attempt=0
    while :; do
      attempt=$((attempt + 1))
      if run_sql_capture "$resp_out" "$url" canary_invoke_response.sql -v request_id="$req_id"; then
        break
      fi
      [[ "$attempt" -lt "$poll_attempts" ]] \
        || die "no pg_net reply for request ${req_id} after ${poll_attempts} attempts. The request WAS queued, so treat the send as UNKNOWN, not as 'did not happen': read net._http_response for that id before invoking anything again"
      sleep "$poll_interval"
    done

    status="$(marker_values "$resp_out" CANARY_RESPONSE_STATUS '[0-9]+|none')"
    [[ "$status" == "200" ]] \
      || die "the worker answered HTTP '${status:-<none>}' — the response is printed above. Do NOT proceed to canary/activate; fix the cause and invoke again"

    # dispatchRunId is the whole point: `canary`, `preflight` and `activate` are all bound to it. A
    # 200 WITHOUT one means no dispatch run started — the kill switch is off, or the worker exited
    # early — so there is nothing to reconcile and nothing was sent.
    run_id="$({ grep -Eo '"dispatchRunId"[[:space:]]*:[[:space:]]*"[0-9a-fA-F-]{36}"' "$resp_out" || true; } \
              | { grep -Eo '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' || true; } \
              | sort -u | awk 'NR==1')"
    [[ -n "$run_id" ]] \
      || die "the worker answered 200 but reported no dispatchRunId, so no dispatch run started and nothing was sent (a 'disabled' answer means DIGEST_SEND_ENABLED is off). Read the body above; there is nothing for \`canary\` to reconcile"

    # WHAT IT ACTUALLY REACHED, now that the run has finished. The ceiling asserted before the
    # invocation bounded the work VISIBLE THEN; pg_net dispatches after that transaction commits and
    # the worker materializes whatever is pending when it runs, so anything enqueued in between was
    # sent by this same invocation and was never counted. This is the half that can be checked after
    # the fact — it cannot unsend, but it stops the rollout continuing as though a one-recipient
    # canary had happened when it had not.
    if ! run_sql_capture "$CANARY_TMP/scope.out" "$url" canary_scope_verify.sql \
           -v run_id="$run_id" -v max_recipients="$MAX_RECIPIENTS"; then
      die "the canary reached MORE than --max-recipients=${MAX_RECIPIENTS}. It has already sent. Do NOT proceed to canary/activate: roll back (DIGEST_SEND_ENABLED=false, then \`rollback --yes --switch-off-confirmed\`) and account for the extra work first"
    fi

    ok "canary invoked — dispatchRunId ${run_id}"
    warn "next: run-enablement.sh canary --yes --admin-ops-confirmed <db_url> ${run_id}"
    ;;

  canary)
    require_confirmed "canary reconciliation"
    require_admin_ops "a canary send"
    url="$(db_url)"
    run_id="$(require_run_id "${ARGS[1]:-}" "canary reconciliation")"
    # Reconcile the run the worker ACTUALLY returned. A before/after table snapshot is not
    # evidence on a live system: anything else running in the window is indistinguishable from
    # the canary.
    psql_safe "$url" -v ON_ERROR_STOP=1 -c \
      "SELECT * FROM public.reconcile_notification_digest_run('${run_id}'::uuid);"
    # RECONCILING IS NOT PASSING. reconcile_notification_digest_run succeeds for ANY existing run,
    # whatever its phase, status or outcome — so on its own it would wave through an EMPTY
    # dispatch run, and the first real provider send would happen later, under cron, to the whole
    # population. Assert what the canary was for: this run, this phase, this channel, succeeded,
    # and something actually delivered.
    run_sql "$url" canary_verify.sql -v run_id="${run_id}"
    ok "canary run ${run_id} reconciled AND verified to have delivered"
    ;;

  activate)
    require_confirmed "arming the digest cron"
    require_admin_ops "arming the digest cron"
    url="$(db_url)"
    # ACTIVATION IS BOUND TO ONE CANARY RUN — the one just verified, named explicitly.
    # Without this the preflight accepted ANY historical success: after an earlier rollout had
    # left a sent group and an accepted attempt behind, a NEW canary could fail outright (or never
    # be run at all) and `activate` would still arm, reporting a green preflight built entirely
    # from evidence that predates the thing it claims to have checked.
    # ...and the external monitor, which by this point should already have been asserted at
    # canary-invoke — see require_monitor.
    require_monitor "activate"
    run_id="$(require_run_id "${ARGS[1]:-}" "arming the digest cron")"
    # ONE ARTIFACT, ONE TRANSACTION. activate.sql locks the job row, runs every assertion against
    # the LOCKED row, arms that exact jobid, and asserts the postcondition — all before it commits.
    # Running the preflight here and arming in a second statement is what this replaced: the job
    # could be altered or deleted in between, and an arm-by-name matching zero rows succeeds
    # silently, so the script would report ARMED over a job that was no longer there.
    run_sql "$url" activate.sql -v run_id="${run_id}"
    run_sql "$url" status.sql
    ok "digest cron ARMED — watch the external monitor and notif_digest_worker_liveness()"
    ;;

  rollback)
    require_confirmed "rollback"
    # THREE things stop a send, and only two of them live in the database. The first is the
    # DIGEST_SEND_ENABLED env var on the edge function: with it still true, a cron tick that
    # started before — or between — the two statements below goes on sending the groups it has
    # already claimed for the rest of its run. This script cannot read or set an edge env var, so
    # it refuses to pretend: the operator turns the switch off FIRST and says so.
    [[ "$SWITCH_OFF_CONFIRMED" == "1" ]] || die \
      "rollback requires --switch-off-confirmed: set DIGEST_SEND_ENABLED=false on notification-digest-worker FIRST (that is the worker's real kill switch; this script cannot set it)"
    url="$(db_url)"
    # Then BOTH database controls, in this order: the event flag first (stop creating work), then
    # the cron (stop draining). Either alone still sends.
    psql_safe "$url" -v ON_ERROR_STOP=1 -c \
      "UPDATE public.notification_event_types SET digest_engine_enabled = false, updated_at = now()
        WHERE key = '${EVENT_KEY}';"
    psql_safe "$url" -v ON_ERROR_STOP=1 -c \
      "SELECT cron.alter_job(jobid, active := false) FROM cron.job
        WHERE jobname = '${JOB_NAME}' AND username = current_user;"
    run_sql "$url" rollback_verify.sql
    ok "rolled back: engine OFF, cron INACTIVE, job still present"
    ;;

  *) usage ;;
esac
