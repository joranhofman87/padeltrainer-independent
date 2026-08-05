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
#   2. smoke-disabled --yes --switch-off-confirmed
#                          — invoke through the REAL Vault/pg_net path while the
#                            switch is OFF, by executing the reviewed job's own
#                            stored command. Answers exactly
#                            200 {"status":"disabled","reason":"disabled"} and
#                            moves NO counter — both now CHECKED, not printed at
#                            the operator. Proves the wiring without sending.
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
# The job name used to be interpolated into an inline rollback statement. It now lives in
# sql/rollback_disable.sql with the rest of that statement, because an inline `-c` runs under the
# role/database search_path and nothing in this bundle could pin it there.

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
  smoke-disabled --yes --switch-off-confirmed <db_url>
                                  INVOKES the worker while the switch is off, by running the cron
                                  job's OWN reviewed command — the same guarded path as the canary,
                                  because that statement carries a Vault-decrypted bearer whether or
                                  not it can send. Refuses unless the cron is inactive and NO engine
                                  is enabled, then requires the reply to be exactly
                                  200 {"status":"disabled","reason":"disabled"} and every counter to
                                  be unmoved. Also needs your word that DIGEST_SEND_ENABLED is off —
                                  no SQL can see an edge env var. Prints its invocation request id
                                  FIRST; after an ambiguous failure, re-run with
                                  --invocation-request-id=<that id> to resume the SAME invocation
  enable-engine ... [--boundary-request-id=<uuid>]
                                  the step prints a boundary request id before it runs; on an
                                  AMBIGUOUS failure re-run with it to replay the SAME opening
                                  rather than re-dating the delivery path's boundary
  canary-invoke --yes --admin-ops-confirmed --monitor-confirmed [--max-recipients=N] <db_url>
                                  SENDS. Invokes the worker ONCE by running the cron job's OWN
                                  stored command, after asserting it hashes to the reviewed value
                                  under a row lock — so what is invoked is what was reviewed, not a
                                  hand-typed lookalike naming some other endpoint. Refuses an armed
                                  cron, a disabled engine, an in-flight run, and a reachable
                                  population above --max-recipients (default 1). Prints the reply so
                                  you can read dispatchRunId; that uuid is what `canary` verifies.
                                  Prints its invocation request id FIRST; after an ambiguous
                                  failure, re-run with --invocation-request-id=<that id>
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
    # RECOVERY, not routine: after an AMBIGUOUS invoke (connection died — the open may have
    # committed), re-running with the id the step printed makes open() REPLAY the same
    # invocation instead of colliding with the single-flight gate. A fresh uuid per execution
    # could never recover that case.
    --invocation-request-id=*) INVOCATION_REQUEST_ID="${a#*=}" ;;
    --boundary-request-id=*)   BOUNDARY_REQUEST_ID="${a#*=}" ;;
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
# WHAT MAY FOLLOW THE ARTIFACT, and nothing else. Both wrappers forwarded "$@" straight to psql, so
# `run_sql "$url" status.sql --command='…'` would have run the pinned file AND then an inline
# statement — under the role/database search_path, which is the whole thing these artifacts pin
# against. "psql is only reached through the wrappers" was therefore true and not sufficient: the
# wrappers themselves have to constrain what they pass on.
#
# The only legitimate extra is a psql variable binding, and the artifact is the only thing that
# decides what those mean. Everything else — another -f, a -c, a --command, a bare word — is refused.
#
# AND THE NAME IS ALLOW-LISTED, not merely required to look like an identifier. psql's own CONTROL
# variables share that namespace, and several change how the artifact behaves rather than what it
# reads: `-v AUTOCOMMIT=off` turns rollback_disable.sql's deliberately independent statements into an
# uncommitted transaction that is discarded at disconnect, so the emergency rollback would do nothing
# at all while every gate before it passed. `-v ON_ERROR_STOP=0` is the same shape. Three names are
# actually used, so three names are permitted.
ARTIFACT_VARS="run_id max_recipients request_id invocation_request_id net_request_id boundary_request_id"
assert_artifact_args() {   # $1 = artifact (for the message), $@ = the forwarded arguments
  local artifact="$1"; shift
  local expect_value=0 a
  _check_binding() {
    local b="$1"
    [[ "$b" =~ ^[a-zA-Z_][a-zA-Z0-9_]*=.*$ ]] \
      || die "refusing to run ${artifact}: '${b}' is not a name=value variable binding"
    case " $ARTIFACT_VARS " in
      *" ${b%%=*} "*) : ;;
      # The wording avoids "psql" followed by a space on purpose: the `never invokes bare psql` guard
      # is a plain text scan and is kept strict by rewording messages rather than by teaching it about
      # string literals. Same trap, same answer, third time in this slice.
      *) die "refusing to run ${artifact}: '${b%%=*}' is not one of the artifact variables (${ARTIFACT_VARS}) — psql's own control variables, such as AUTOCOMMIT or ON_ERROR_STOP, change how the artifact behaves rather than what it reads" ;;
    esac
  }
  for a in "$@"; do
    if [[ "$expect_value" == "1" ]]; then _check_binding "$a"; expect_value=0; continue; fi
    case "$a" in
      -v)   expect_value=1 ;;
      -v*)  _check_binding "${a#-v}" ;;
      *)    die "refusing to run ${artifact}: only '-v name=value' may follow an artifact, got '${a}' — an inline statement would run outside the artifact's pinned search_path" ;;
    esac
  done
  [[ "$expect_value" == "0" ]] || die "refusing to run ${artifact}: a trailing '-v' with no binding"
}

run_sql() {   # $1 = url, $2 = artifact, $@ = extra psql args
  local url="$1" artifact="$2"; shift 2
  assert_artifact_args "$artifact" "$@"
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
  assert_artifact_args "$artifact" "$@"
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
# A FAILED INVOKE IS NOT AUTOMATICALLY A ROLLED-BACK ONE, and reporting it as one invites a retry
# that sends twice. Both invoke artifacts print a PROVISIONAL request id inside the transaction and
# the real marker after COMMIT. So there are three cases, and only the first is safe to retry:
#   * no provisional marker  → the transaction never reached its end; nothing was queued.
#   * provisional but no final marker → the request may be committed and on its way. UNKNOWN.
#   * both → the caller never gets here.
report_failed_invoke() {   # $1 = captured output, $2 = what failed, for the message
  local out="$1" what="$2" prov
  prov="$(marker_values "$out" CANARY_REQUEST_PROVISIONAL '[0-9]+')"
  # THREE CASES, not two. Lumping "malformed or several" in with "none" reported an ambiguous
  # capture as safely rolled back and invited the retry this exists to prevent. Only an EMPTY
  # capture is evidence that nothing was queued; anything else is UNKNOWN.
  if [[ -z "$prov" ]]; then
    die "$what was REFUSED before it queued anything — the transaction rolled back, so nothing was sent. Read the failed assertion above"
  fi
  case "$prov" in
    *[!0-9]*) die "$what FAILED and its output names an AMBIGUOUS set of pg_net requests (${prov//$'\n'/, }). Treat the outcome as UNKNOWN — do NOT retry, which could send twice. Read net._http_response for each of those ids and notification_worker_runs first" ;;
  esac
  die "$what FAILED AFTER queueing pg_net request ${prov}. Whether that request was committed and dispatched is UNKNOWN — do NOT simply retry, which would send twice. Read net._http_response for id ${prov} and notification_worker_runs first"
}

# pg_net is asynchronous: the reply arrives after the invoking transaction commits, so this polls
# rather than pretends. BOUNDED — an unanswered request must fail the subcommand, not hang a terminal
# in front of an operator who has just triggered a credential-bearing request. Shared by the disabled
# smoke and the canary so the two cannot drift into waiting differently.
#
# A permanent failure (net._http_response unreadable, say) simply exhausts the loop, and the last
# captured output is what explains why.
poll_for_reply() {   # $1 = url, $2 = request id, $3 = outfile
  local url="$1" req_id="$2" outfile="$3"
  local attempts="${CANARY_POLL_ATTEMPTS:-30}" interval="${CANARY_POLL_INTERVAL:-2}" attempt=0
  [[ "$attempts" =~ ^[1-9][0-9]*$ ]] || die "CANARY_POLL_ATTEMPTS must be a positive integer"
  [[ "$interval" =~ ^[0-9]+$ ]]      || die "CANARY_POLL_INTERVAL must be a non-negative integer"
  while :; do
    attempt=$((attempt + 1))
    if run_sql_capture "$outfile" "$url" canary_invoke_response.sql -v request_id="$req_id"; then
      return 0
    fi
    [[ "$attempt" -lt "$attempts" ]] \
      || die "no pg_net reply for request ${req_id} after ${attempts} attempts. The request WAS queued, so treat the outcome as UNKNOWN, not as 'did not happen': read net._http_response for that id before invoking anything again"
    sleep "$interval"
  done
}

marker_values() {   # $1 = file, $2 = marker name, $3 = ERE for the value
  { grep -Eo "$2=($3)" "$1" || true; } | cut -d= -f2- | sort -u
}

# The invocation request id, PRINTED BEFORE the invoke runs — that ordering is the recovery
# mechanism. If the invoke dies AMBIGUOUSLY (connection lost mid-commit) the open() may have
# committed; a fresh uuid on the retry would then collide with the single-flight gate and no
# execution could ever recover the committed id. Printing first means the operator always holds
# the id; --invocation-request-id feeds it back and open() REPLAYS the same invocation.
prepare_invocation_request_id() {   # $1 = what this invocation is, for the messages
  local what="$1"
  if [[ -n "${INVOCATION_REQUEST_ID:-}" ]]; then
    [[ "$INVOCATION_REQUEST_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
      || die "--invocation-request-id must be a lowercase uuid, got '${INVOCATION_REQUEST_ID}'"
    INV_REQ_ID="$INVOCATION_REQUEST_ID"
    warn "REUSING invocation request id ${INV_REQ_ID} for ${what} — an exact replay returns the SAME invocation (recovery path)"
  else
    INV_REQ_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  fi
  ok "invocation request id: ${INV_REQ_ID} — if ${what} dies after this line, re-run this step with --invocation-request-id=${INV_REQ_ID} (an exact replay resumes the SAME invocation instead of colliding with the single-flight gate)"
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
    # N5: this step also OPENS the email:digest delivery path, in the same transaction. The id is
    # printed BEFORE the step for the same reason the invocation's is: if the step dies
    # ambiguously, re-running with --boundary-request-id REPLAYS that opening instead of moving
    # the boundary forward (which would re-admit everything enqueued in between).
    if [[ -n "${BOUNDARY_REQUEST_ID:-}" ]]; then
      [[ "$BOUNDARY_REQUEST_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
        || die "--boundary-request-id must be a lowercase uuid, got '${BOUNDARY_REQUEST_ID}'"
      BND_REQ_ID="$BOUNDARY_REQUEST_ID"
      warn "REUSING boundary request id ${BND_REQ_ID} — an exact replay re-opens NOTHING and leaves the recorded boundary where it is"
    else
      BND_REQ_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
    fi
    ok "boundary request id: ${BND_REQ_ID} — if this step dies after this line, re-run it with --boundary-request-id=${BND_REQ_ID}"
    run_sql "$url" enable_engine.sql -v boundary_request_id="$BND_REQ_ID"
    ok "digest engine ENABLED for ${EVENT_KEY} and the email:digest path OPENED — nothing sends until the worker is invoked, and nothing older than this moment can ever send"
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
    # THE INVOCATION IS NO LONGER THE OPERATOR'S TO HAND-WRITE. It used to be: this subcommand
    # captured the counters and left the `net.http_post` to a procedure in
    # docs/CRON_SERVICE_KEY_SETUP.md with a hand-substituted project ref and unqualified names.
    # DIGEST_SEND_ENABLED=false stops the mail and does nothing at all for the CREDENTIAL — that
    # statement posts a Vault-decrypted service_role bearer, so a mistyped ref sends it to another
    # project and a hostile `public.jsonb_build_object(...)` captures it. Same exposure the canary
    # path was rebuilt to close, one step earlier in the sequence.
    # --yes AS WELL. This subcommand used to be read-only, and the flag rule ("every step that changes
    # anything requires --yes") did not obviously apply. It invokes now: it posts a Vault-decrypted
    # bearer through pg_net, which is a production action whether or not mail can result.
    # --switch-off-confirmed asserts an ENVIRONMENT FACT; it is not the owner's intent, and rollback
    # deliberately requires both for the same reason.
    require_confirmed "the disabled smoke (it invokes the worker through the real Vault/pg_net path)"
    url="$(db_url)"
    CANARY_TMP="$(mktemp -d)"
    # shellcheck disable=SC2064  # expand now: it must be removed even if the variable is reassigned
    trap "rm -rf '$CANARY_TMP'" EXIT

    before="$CANARY_TMP/counters.before"
    after="$CANARY_TMP/counters.after"
    run_sql_capture "$before" "$url" smoke_counters.sql \
      || die "could not read the counters before the smoke"

    warn "smoke-disabled INVOKES the worker through the real Vault/pg_net path. What keeps it from"
    warn "sending is DIGEST_SEND_ENABLED being off — your assertion, which no SQL here can check: the"
    warn "worker claims existing groups regardless of the engine flags. The backlog assertions are a"
    warn "SNAPSHOT that removes the work a wrong assertion would have sent."
    prepare_invocation_request_id "the disabled smoke"
    if ! run_sql_capture "$CANARY_TMP/invoke.out" "$url" smoke_invoke.sql -v invocation_request_id="$INV_REQ_ID"; then
      warn "invocation request id was ${INV_REQ_ID} — if the failure below is AMBIGUOUS (connection lost, not a rolled-back assertion), re-run with --invocation-request-id=${INV_REQ_ID}"
      report_failed_invoke "$CANARY_TMP/invoke.out" "the disabled smoke"
    fi
    req_id="$(marker_values "$CANARY_TMP/invoke.out" CANARY_REQUEST_ID '[0-9]+')"
    case "$req_id" in
      ''|*[!0-9]*) die "the smoke did not print exactly one CANARY_REQUEST_ID (got '${req_id//$'\n'/, }')" ;;
    esac

    poll_for_reply "$url" "$req_id" "$CANARY_TMP/response.out"

    # THE AFTER-CAPTURE COMES FIRST — before the STATUS verdict as well as the body one. An
    # accidentally-enabled worker can send, then fail on reconciliation or on finishing, and answer
    # 500: that is precisely when the counter evidence matters, and judging the status first threw it
    # away. Both verdicts are deferred until the measurement exists and has been shown to be complete.
    run_sql_capture "$after" "$url" smoke_counters.sql \
      || die "could not read the counters after the smoke"

    # A DELTA, compared mechanically — and the comparison must not be able to pass VACUOUSLY. Two
    # empty marker streams diff clean, and a capture containing only psql's headings is still a
    # non-empty file, so "is the capture non-empty" was not the check it looked like. Every expected
    # marker must be present exactly once in BOTH captures before the delta means anything.
    SMOKE_COUNTER_NAMES="circuit_state digest_attempts digest_groups group_attempts group_states orphan_state outbox_pending provider_events worker_runs"
    for capture in "$before" "$after"; do
      for name in $SMOKE_COUNTER_NAMES; do
        n="$({ grep -Eco "SMOKE_COUNTER ${name}=" "$capture" || true; })"
        [[ "$n" == "1" ]] \
          || die "the counter capture $(basename "$capture") has ${n} lines for '${name}', expected exactly 1 — the comparison would not have meant anything"
      done
    done
    if ! diff <(grep -Eo 'SMOKE_COUNTER [a-z_]+=.*' "$before" | sort) \
              <(grep -Eo 'SMOKE_COUNTER [a-z_]+=.*' "$after"  | sort) >"$CANARY_TMP/delta" 2>&1; then
      cat "$CANARY_TMP/delta" >&2
      die "the disabled smoke MOVED a counter — it is not disabled. Stop and account for the difference above"
    fi

    # BOTH VERDICTS COME LAST, after the counters have been captured, shown complete, AND compared.
    # An unexpected body is the "the worker sent and then something went wrong" case: dying on it
    # before the comparison printed the raw counters and never mechanically said what moved, which is
    # the one thing the operator needs at that moment.
    status="$(marker_values "$CANARY_TMP/response.out" CANARY_RESPONSE_STATUS '[0-9]+|none')"
    [[ "$status" == "200" ]] \
      || die "the disabled smoke answered HTTP '${status:-<none>}' — it must answer 200. The counters either side were compared first and are above, so you can see whether anything moved"

    # EXACTLY the documented answer, not merely a 200 — and compared in SQL, not as a substring here.
    # `grep -qF` on the body marker passed for `{...}garbage`, and the artifact prints the raw body a
    # second time, so a matching substring had two places to hide.
    disabled="$(marker_values "$CANARY_TMP/response.out" CANARY_RESPONSE_IS_DISABLED '[a-z]+')"
    [[ "$disabled" == "t" || "$disabled" == "true" ]] \
      || die "the disabled smoke did not answer exactly the disabled body — DIGEST_SEND_ENABLED may not be off. The counters either side were compared first and are above; read them and the body, and do NOT continue"

    # N4 AC-6: CLOSE the invocation record, with the evidence attached. The disabled worker
    # never starts a run, so the generic run-evidence resolve refuses this invocation forever —
    # left open it blocks every later smoke/canary/activate at the gate. This dedicated arm
    # re-verifies the SAME facts in SQL (clean 200, exact disabled body, response postdates the
    # open) rather than taking this shell's verdict on trust, and it refuses anything that is
    # not a pending smoke. Runs only AFTER every verdict above passed.
    if ! run_sql_capture "$CANARY_TMP/resolve.out" "$url" smoke_resolve_disabled.sql \
           -v invocation_request_id="$INV_REQ_ID" -v net_request_id="$req_id"; then
      die "the disabled smoke PASSED but its invocation could not be resolved — the record for request_id=${INV_REQ_ID} is still open and will (correctly) block later steps. Read the error above, then resolve it via smoke_resolve_disabled.sql or the invocation RPCs"
    fi
    resolved="$(marker_values "$CANARY_TMP/resolve.out" SMOKE_INVOCATION_RESOLVED '[a-z_]+')"
    [[ "$resolved" == "completed_disabled" || "$resolved" == "already_resolved" ]] \
      || die "smoke_resolve_disabled.sql printed verdict '${resolved:-<none>}' — expected completed_disabled or already_resolved"

    ok "disabled smoke: answered exactly {\"status\":\"disabled\",\"reason\":\"disabled\"}, moved no counter, and its invocation record is closed (${resolved})"
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

    CANARY_TMP="$(mktemp -d)"
    # shellcheck disable=SC2064  # expand CANARY_TMP now: it must be removed even if it is reassigned
    trap "rm -rf '$CANARY_TMP'" EXIT
    inv_out="$CANARY_TMP/invoke.out"
    resp_out="$CANARY_TMP/response.out"

    warn "canary-invoke SENDS. It runs the reviewed cron command once, with the cron still inactive."
    prepare_invocation_request_id "the canary invocation"
    if ! run_sql_capture "$inv_out" "$url" canary_invoke.sql -v max_recipients="$MAX_RECIPIENTS" -v invocation_request_id="$INV_REQ_ID"; then
      warn "invocation request id was ${INV_REQ_ID} — if the failure below is AMBIGUOUS (connection lost, not a rolled-back assertion), re-run with --invocation-request-id=${INV_REQ_ID}"
      report_failed_invoke "$inv_out" "the canary invocation"
    fi

    # EXACTLY ONE request id, or refuse. Guessing which of two to read would mean reporting on a
    # request this invocation may not have made.
    req_id="$(marker_values "$inv_out" CANARY_REQUEST_ID '[0-9]+')"
    case "$req_id" in
      ''|*[!0-9]*) die "the invocation did not print exactly one CANARY_REQUEST_ID (got '${req_id//$'\n'/, }') — refusing to guess which pg_net request to read" ;;
    esac
    ok "queued pg_net request ${req_id} — the request leaves on commit, which has now happened"

    poll_for_reply "$url" "$req_id" "$resp_out"

    status="$(marker_values "$resp_out" CANARY_RESPONSE_STATUS '[0-9]+|none')"

    # THE RUN ID IS EXTRACTED BEFORE THE STATUS IS JUDGED, and that ordering is the point. A worker
    # that sends several groups and then fails — on a later group, on reconciliation, on finishing —
    # returns a non-200 whose body still carries dispatchRunId. Refusing on the status first meant the
    # one case where mail had gone out AND something was wrong was the one case nothing measured how
    # much. Whenever there is a run id there is a run to account for, whatever the HTTP code said.
    # EXACTLY ONE, or refuse — the same rule as the request id, which this did not follow. Taking
    # `NR==1` from several distinct uuids means measuring and handing forward a run that may not be
    # the one this invocation caused.
    run_ids="$({ grep -Eo '"dispatchRunId"[[:space:]]*:[[:space:]]*"[0-9a-fA-F-]{36}"' "$resp_out" || true; } \
              | { grep -Eo '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' || true; } \
              | sort -u)"
    case "$run_ids" in
      *$'\n'*) die "the reply named MORE THAN ONE dispatchRunId (${run_ids//$'\n'/, }) — refusing to guess which run this invocation caused" ;;
    esac
    run_id="$run_ids"

    # WHAT IT ACTUALLY REACHED, now that the run has finished. The ceiling asserted before the
    # invocation bounded the work VISIBLE THEN; pg_net dispatches after that transaction commits and
    # the worker materializes whatever is pending when it runs, so anything enqueued in between was
    # sent by this same invocation and was never counted. This is the half that can be checked after
    # the fact — it cannot unsend, but it stops the rollout continuing as though a one-recipient
    # canary had happened when it had not.
    if [[ -n "$run_id" ]]; then
      if ! run_sql_capture "$CANARY_TMP/scope.out" "$url" canary_scope_verify.sql \
             -v run_id="$run_id" -v max_recipients="$MAX_RECIPIENTS"; then
        die "the canary reached MORE than --max-recipients=${MAX_RECIPIENTS}. It has already sent. Do NOT proceed to canary/activate: roll back (DIGEST_SEND_ENABLED=false, then \`rollback --yes --switch-off-confirmed\`) and account for the extra work first"
      fi
    fi

    if [[ "$status" != "200" ]]; then
      # Two very different situations, and telling the operator to "fix it and invoke again" is only
      # right for one of them.
      if [[ -n "$run_id" ]]; then
        die "the worker answered HTTP '${status:-<none>}' AFTER starting dispatch run ${run_id}. Mail may already have gone out — the scope check above says how much. Roll back (DIGEST_SEND_ENABLED=false, then \`rollback --yes --switch-off-confirmed\`) and account for that run before invoking anything again"
      fi
      die "the worker answered HTTP '${status:-<none>}' and reported no dispatchRunId, so whether anything was sent is UNKNOWN — not 'nothing happened'. Turn DIGEST_SEND_ENABLED off and investigate the worker's logs and notification_worker_runs before invoking again"
    fi

    # A 200 WITHOUT a run id means no dispatch run started — the kill switch is off, or the worker
    # exited early — so there is nothing to reconcile and nothing was sent.
    [[ -n "$run_id" ]] \
      || die "the worker answered 200 but reported no dispatchRunId, so no dispatch run started and nothing was sent (a 'disabled' answer means DIGEST_SEND_ENABLED is off). Read the body above; there is nothing for \`canary\` to reconcile"

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
    #
    # AN ARTIFACT, NOT A `-c`. An inline statement is a psql process running under the role/database
    # search_path, which is exactly what every artifact in this bundle pins against — the `::uuid`
    # here is a type lookup like any other. One rule: everything this bundle sends to production is
    # an enumerated, path-pinned file.
    run_sql "$url" canary_reconcile.sql -v run_id="${run_id}"
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
    # the cron (stop draining). Either alone still sends. Both live in ONE artifact so the order is
    # in the file rather than in the caller — and so they run under a pinned search_path, which two
    # inline `-c` statements did not.
    run_sql "$url" rollback_disable.sql
    run_sql "$url" rollback_verify.sql
    ok "rolled back: engine OFF, cron INACTIVE, job still present"
    ;;

  *) usage ;;
esac
