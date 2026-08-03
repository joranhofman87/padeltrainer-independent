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
#   4. canary --yes        — ONE manual invocation, cron still INACTIVE, then
#                            reconcile the ACTUAL run ids the worker returned.
#   5. activate --yes      — arm the cron, but only after activation_preflight
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

usage() {
  cat >&2 <<'USAGE'
usage: EXPECTED_REF=<ref> run-enablement.sh <subcommand> [--yes] <db_url>

  status <db_url>                 read-only: engine flags, cron state, liveness, counters
  smoke-disabled --switch-off-confirmed <db_url>
                                  read-only: capture counters either side of the disabled
                                  invocation. Requires you to have verified DIGEST_SEND_ENABLED
                                  is off — no SQL can see an edge env var
  canary --yes <db_url> <run_id>  reconcile ONE canary's ACTUAL returned run id
  activate --yes <db_url>         run activation_preflight, then arm the cron
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
ARGS=()
SUB="${1:-}"; shift || usage
for a in "$@"; do
  case "$a" in
    --yes)                   CONFIRMED=1 ;;
    --switch-off-confirmed)  SWITCH_OFF_CONFIRMED=1 ;;
    *)                       ARGS+=("$a") ;;
  esac
done

require_confirmed() {
  [[ "$CONFIRMED" == "1" ]] || die "$1 changes production — re-run with --yes"
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

run_sql() {   # $1 = url, $2 = artifact
  ( cd "$SQL_DIR" && psql "$1" -v ON_ERROR_STOP=1 -f "$2" )
}

case "$SUB" in
  status)
    url="$(db_url)"
    run_sql "$url" status.sql
    ok "status read (no mutation)"
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
    url="$(db_url)"
    run_id="${ARGS[1]:-}"
    [[ -n "$run_id" ]] || die "pass the ACTUAL run id the canary invocation returned"
    [[ "$run_id" =~ ^[0-9a-fA-F-]{36}$ ]] || die "run id must be a uuid — never a before/after snapshot"
    # Reconcile the run the worker ACTUALLY returned. A before/after table snapshot is not
    # evidence on a live system: anything else running in the window is indistinguishable from
    # the canary.
    psql "$url" -v ON_ERROR_STOP=1 -c \
      "SELECT * FROM public.reconcile_notification_digest_run('${run_id}'::uuid);"
    ok "canary run ${run_id} reconciled"
    ;;

  activate)
    require_confirmed "arming the digest cron"
    url="$(db_url)"
    # PREFLIGHT FIRST, and it must pass. It refuses if the engine is off, if the cron is already
    # armed, if any group is mid-send, if an orphan is quarantined, or if no dispatch run has
    # ever succeeded.
    run_sql "$url" activation_preflight.sql
    psql "$url" -v ON_ERROR_STOP=1 -c \
      "SELECT cron.alter_job(jobid, active := true) FROM cron.job
        WHERE jobname = '${JOB_NAME}' AND username = current_user;"
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
    psql "$url" -v ON_ERROR_STOP=1 -c \
      "UPDATE public.notification_event_types SET digest_engine_enabled = false, updated_at = now()
        WHERE key = '${EVENT_KEY}';"
    psql "$url" -v ON_ERROR_STOP=1 -c \
      "SELECT cron.alter_job(jobid, active := false) FROM cron.job
        WHERE jobname = '${JOB_NAME}' AND username = current_user;"
    run_sql "$url" rollback_verify.sql
    ok "rolled back: engine OFF, cron INACTIVE, job still present"
    ;;

  *) usage ;;
esac
