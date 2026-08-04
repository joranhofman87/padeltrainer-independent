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
#   3. (owner) enable the send switch
#   4. canary --yes --admin-ops-confirmed
#                          — ONE manual invocation, cron still INACTIVE, then
#                            reconcile the ACTUAL run ids the worker returned.
#   4b. (owner) wire the EXTERNAL cron/uptime monitor on notif_digest_worker_liveness() and
#                            verify it alerts on a stale last_success_at.
#   5. activate --yes --monitor-confirmed --admin-ops-confirmed
#                          — arm the cron, but only after activation_preflight
#                            passes. Enabling the cron BEFORE the switch would
#                            schedule a worker that finds nothing and reports
#                            healthy — a green light over an engine still off.
#   6. rollback --yes      — switch OFF and DEACTIVATE the cron, then prove both.
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
  preflight <db_url> <run_id>     read-only DRY RUN of the activation gate — every assertion,
                                  nothing armed. Not the gate itself: `activate` re-checks under a
                                  row lock in the same transaction as the arm
  smoke-disabled --switch-off-confirmed <db_url>
                                  read-only: capture counters either side of the disabled
                                  invocation. Requires you to have verified DIGEST_SEND_ENABLED
                                  is off — no SQL can see an edge env var
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
ARGS=()
SUB="${1:-}"; shift || usage
for a in "$@"; do
  case "$a" in
    --yes)                   CONFIRMED=1 ;;
    --switch-off-confirmed)  SWITCH_OFF_CONFIRMED=1 ;;
    --monitor-confirmed)     MONITOR_CONFIRMED=1 ;;
    --admin-ops-confirmed)   ADMIN_OPS_CONFIRMED=1 ;;
    *)                       ARGS+=("$a") ;;
  esac
done

require_confirmed() {
  [[ "$CONFIRMED" == "1" ]] || die "$1 changes production — re-run with --yes"
}

# THE THIRD PRECONDITION THIS CANNOT SEE. The Admin Notification Operations release unit — global
# admin visibility into the pipeline plus safe controls — is a MANDATORY prerequisite for any
# canary or activation: without it, the only way to see what the pipeline is doing is psql against
# production, so the first sign of trouble in a real send is a user complaint. It is a separate
# release unit and nothing in this database can detect whether it has shipped, so the operator
# asserts it, exactly as they assert the edge kill switch and the external monitor.
#
# WHAT THIS FLAG CAN AND CANNOT GATE. `canary` RECONCILES a run the operator already invoked by
# hand, so by the time this check runs the canary email has been sent. It therefore gates
# reconciliation and activation mechanically; the send itself is gated procedurally, by the runbook
# putting the release unit at step 0. Said plainly here rather than implied, because a flag that
# looks like it blocks a send and does not is worse than no flag.
require_admin_ops() {
  [[ "$ADMIN_OPS_CONFIRMED" == "1" ]] || die \
    "$1 requires --admin-ops-confirmed: the Admin Notification Operations release unit must be SHIPPED and verified first — see docs/FOUNDATION_ROADMAP.md for its acceptance criteria. Without it there is no in-product view of the pipeline and no safe controls, so intervening in a real send means psql against production"
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

case "$SUB" in
  status)
    url="$(db_url)"
    run_sql "$url" status.sql
    ok "status read (no mutation)"
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
    # THE PRECONDITION THIS ALSO CANNOT SEE. The external cron/uptime monitor on
    # notif_digest_worker_liveness() is the ONLY thing that detects a worker which is never
    # invoked — an unscheduled or disabled job, a missing Vault secret, a paused project all
    # produce silence, and the in-worker Slack alert needs the worker to run. It lives outside
    # this database entirely, so nothing here can verify it; the docs called it a precondition
    # while the runbook walked straight past it. The operator asserts it, exactly as they assert
    # the edge kill switch.
    [[ "$MONITOR_CONFIRMED" == "1" ]] || die \
      "activate requires --monitor-confirmed: wire the EXTERNAL cron/uptime monitor on public.notif_digest_worker_liveness() FIRST and verify it alerts on a stale last_success_at (this script cannot see anything outside the database, and it is the only detector for a worker that is never invoked)"
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
