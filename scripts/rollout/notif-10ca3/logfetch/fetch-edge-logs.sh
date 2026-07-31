#!/usr/bin/env bash
# ===========================================================================
# fetch-edge-logs.sh — retrieve send-invoice-email structured lifecycle events
# from a DEPLOYED Supabase project over a bounded window, and PROVE the
# maintenance drain: (1) no send passed the gate, and (2) no send is still
# in-flight (every provider_send_started has a matching event:finished).
#
# The installed Supabase CLI has NO `functions logs`. This uses the supported
# Management API analytics endpoint:
#     GET https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/logs.all
# authenticated with a Personal Access Token (SUPABASE_ACCESS_TOKEN, never
# printed). Our console lines live in event_message on both analytics backends
# (ClickHouse post-Jun-2026, legacy BigQuery before), so the event_message
# filter is dialect-agnostic; only the FROM/source differs.
#
# Exit non-zero when: any event:provider_send_started is present (unless
# --allow-sends), or --assert-all-finished and any started invocation lacks a
# finished. --from-file <path> analyses a captured lines file offline (for
# tests); --dry-run prints the request without calling the network.
# ===========================================================================
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"

REF=""; START=""; END=""; DIALECT="auto"; DRY_RUN=0; EXPECT_ZERO_SENDS=1
ASSERT_ALL_FINISHED=0; FROM_FILE=""
usage() {
  cat >&2 <<'EOF'
usage: fetch-edge-logs.sh --ref <20-char-ref> --start <ISO8601Z> --end <ISO8601Z>
                          [--dialect auto|clickhouse|legacy] [--allow-sends]
                          [--assert-all-finished] [--from-file <lines.txt>] [--dry-run]
env: SUPABASE_ACCESS_TOKEN  (Personal Access Token; required unless --dry-run/--from-file)
EOF
  exit 2
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2;;
    --start) START="$2"; shift 2;;
    --end) END="$2"; shift 2;;
    --dialect) DIALECT="$2"; shift 2;;
    --allow-sends) EXPECT_ZERO_SENDS=0; shift;;
    --assert-all-finished) ASSERT_ALL_FINISHED=1; shift;;
    --from-file) FROM_FILE="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) usage;;
    *) die "unknown arg: $1";;
  esac
done

sql_for_dialect() {
  case "$1" in
    clickhouse) printf "%s" "select timestamp, event_message from logs where source = 'function_logs' and event_message like '%[SEND-INVOICE-EMAIL]%' order by timestamp asc limit 1000";;
    legacy)     printf "%s" "select timestamp, event_message from function_logs where event_message like '%[SEND-INVOICE-EMAIL]%' order by timestamp asc limit 1000";;
    *) die "unknown dialect: $1";;
  esac
}

# ---- analysis of a captured lines file (network-independent) ---------------
# Proves the drain from event_message lines alone. Exits non-zero per the flags.
analyse_lines() {
  local f="$1"
  local c_blocked c_started c_finished c_recfail
  c_blocked=$(grep -c 'event:blocked'               "$f" || true)
  c_started=$(grep -c 'event:provider_send_started' "$f" || true)
  c_finished=$(grep -c 'event:finished'             "$f" || true)
  c_recfail=$(grep -c 'record_failed'               "$f" || true)
  log "event:blocked                = ${c_blocked}"
  log "event:provider_send_started  = ${c_started}   (MUST be 0 while the gate is ON)"
  log "event:finished               = ${c_finished}"
  log "record_failed                = ${c_recfail}"

  # started-without-finished invocationIds = in-flight stragglers (not drained)
  local started_ids finished_ids open_ids n_open
  started_ids="$(grep 'event:provider_send_started' "$f" | grep -oE '"invocationId":"[0-9a-fA-F-]{36}"' | sort -u || true)"
  finished_ids="$(grep 'event:finished'             "$f" | grep -oE '"invocationId":"[0-9a-fA-F-]{36}"' | sort -u || true)"
  open_ids="$(comm -23 <(printf '%s\n' "$started_ids" | sed '/^$/d') <(printf '%s\n' "$finished_ids" | sed '/^$/d') || true)"
  n_open=$(printf '%s\n' "$open_ids" | sed '/^$/d' | grep -c . || true)
  log "in-flight (started, not finished) = ${n_open}"

  local rc=0
  if [[ "$EXPECT_ZERO_SENDS" == 1 && "$c_started" -ne 0 ]]; then
    warn "SAFETY VIOLATION: ${c_started} provider_send_started event(s) passed the gate"; rc=1
  fi
  if [[ "$ASSERT_ALL_FINISHED" == 1 && "$n_open" -ne 0 ]]; then
    warn "DRAIN INCOMPLETE: ${n_open} send(s) still in-flight (no event:finished)"; rc=1
  fi
  return "$rc"
}

# ---- offline analysis path (tests) ----------------------------------------
if [[ -n "$FROM_FILE" ]]; then
  [[ -f "$FROM_FILE" ]] || die "--from-file not found: $FROM_FILE"
  analyse_lines "$FROM_FILE" && { ok "log analysis passed"; exit 0; } || die "log analysis failed"
fi

[[ -n "$REF" && -n "$START" && -n "$END" ]] || usage
assert_ref_format "$REF"
require_cmd curl; require_cmd jq
iso_re='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
[[ "$START" =~ $iso_re ]] || die "--start must be ISO8601 UTC like 2026-07-31T13:00:00Z"
[[ "$END"   =~ $iso_re ]] || die "--end must be ISO8601 UTC like 2026-07-31T13:30:00Z"
[[ "${END//[^0-9]/}" > "${START//[^0-9]/}" ]] || die "--end must be after --start"

API="https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs.all"
do_query() { # $1 dialect
  local sql; sql="$(sql_for_dialect "$1")"
  NO_COLOR=1 curl -sS -G "$API" \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    --data-urlencode "sql=${sql}" \
    --data-urlencode "iso_timestamp_start=${START}" \
    --data-urlencode "iso_timestamp_end=${END}"
}

if [[ "$DRY_RUN" == 1 ]]; then
  local_dialect="$DIALECT"; [[ "$local_dialect" == auto ]] && local_dialect=legacy
  log "DRY RUN — constructed request (token redacted):"
  printf 'GET %s\nAuthorization: Bearer ***REDACTED***\nsql=%s\niso_timestamp_start=%s\niso_timestamp_end=%s\n' \
    "$API" "$(sql_for_dialect "$local_dialect")" "$START" "$END" >&2
  ok "dry-run only; no network call made"; exit 0
fi

[[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]] || die "SUPABASE_ACCESS_TOKEN is required (Dashboard -> Account -> Access Tokens)"
fetch() {
  local resp err
  if [[ "$DIALECT" == "auto" ]]; then
    resp="$(do_query clickhouse)" || die "Management API request failed"
    err="$(printf '%s' "$resp" | jq -r '.error // empty')"
    if [[ -n "$err" ]]; then warn "ClickHouse dialect rejected ($err) — retrying legacy"; resp="$(do_query legacy)" || die "request failed (legacy)"; fi
  else
    resp="$(do_query "$DIALECT")" || die "Management API request failed"
  fi
  err="$(printf '%s' "$resp" | jq -r '.error // empty')"
  [[ -z "$err" ]] || die "analytics query error: $err"
  printf '%s' "$resp"
}

RESP="$(fetch)"
mkdir -p "$HERE/../evidence"
LINES_FILE="$HERE/../evidence/edge-log-lines.txt"
printf '%s' "$RESP" | jq -r '.result[]?.event_message' > "$LINES_FILE"
log "window ${START} .. ${END}  (ref ${REF}); raw lines -> $LINES_FILE"
analyse_lines "$LINES_FILE" && { ok "log retrieval + drain analysis passed"; exit 0; } || die "drain proof failed for this window"
