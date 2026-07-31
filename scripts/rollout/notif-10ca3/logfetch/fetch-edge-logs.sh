#!/usr/bin/env bash
# ===========================================================================
# fetch-edge-logs.sh — retrieve send-invoice-email structured lifecycle events
# from a DEPLOYED Supabase project over a bounded window and prove the drain,
# FAIL-CLOSED. The installed CLI has NO `functions logs`; this uses the
# Management API analytics endpoint the Dashboard uses:
#   GET https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/logs.all
# authed with a Personal Access Token (SUPABASE_ACCESS_TOKEN, never printed).
#
# Fail-closed: a malformed/empty/missing .result, a truncated page (== LIMIT),
# a gate bypass, an in-flight straggler, a record_failed, or (when required)
# absent positive `event:blocked` ingestion evidence all cause a NON-ZERO exit.
#
# Distinct exit codes let the caller retry ingestion lag but abort on a bypass:
#   0 ok | 1 setup/response error | 3 gate bypass (provider_send_started)
#   4 require-blocked unmet (no ingestion evidence yet) | 5 straggler | 6 record_failed
#
# Inputs: live (--ref/--start/--end) | --from-response <json> | --from-file <lines>.
# ===========================================================================
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
LIMIT=1000

REF=""; START=""; END=""; DIALECT="auto"; DRY_RUN=0
EXPECT_ZERO_SENDS=1; ASSERT_ALL_FINISHED=0; REQUIRE_BLOCKED=0; FAIL_ON_RECORD_FAILED=0
FROM_FILE=""; FROM_RESPONSE=""
usage() {
  cat >&2 <<'EOF'
usage: fetch-edge-logs.sh (--ref R --start ISO --end ISO | --from-response f.json | --from-file f.txt)
       [--dialect auto|clickhouse|legacy] [--allow-sends] [--assert-all-finished]
       [--require-blocked] [--fail-on-record-failed] [--dry-run]
env: SUPABASE_ACCESS_TOKEN (PAT; required for the live path)
EOF
  exit 1
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="$2"; shift 2;; --start) START="$2"; shift 2;; --end) END="$2"; shift 2;;
    --dialect) DIALECT="$2"; shift 2;;
    --allow-sends) EXPECT_ZERO_SENDS=0; shift;;
    --assert-all-finished) ASSERT_ALL_FINISHED=1; shift;;
    --require-blocked) REQUIRE_BLOCKED=1; shift;;
    --fail-on-record-failed) FAIL_ON_RECORD_FAILED=1; shift;;
    --from-file) FROM_FILE="$2"; shift 2;; --from-response) FROM_RESPONSE="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) usage;;
    *) die "unknown arg: $1";;
  esac
done

sql_for_dialect() {
  case "$1" in
    clickhouse) printf "%s" "select timestamp, event_message from logs where source = 'function_logs' and event_message like '%[SEND-INVOICE-EMAIL]%' order by timestamp asc limit ${LIMIT}";;
    legacy)     printf "%s" "select timestamp, event_message from function_logs where event_message like '%[SEND-INVOICE-EMAIL]%' order by timestamp asc limit ${LIMIT}";;
    *) die "unknown dialect: $1";;
  esac
}

# validate a Management API JSON response, fail closed, and emit "ts<TAB>msg" lines
extract_response() { # $1 response.json  $2 out lines file
  local resp="$1" out="$2" n
  require_cmd jq
  [[ -f "$resp" ]] || die "response file not found: $resp"
  jq -e '.error == null' "$resp" >/dev/null 2>&1 || die "analytics response carries an error (or is unparseable)"
  jq -e '.result | type == "array"' "$resp" >/dev/null 2>&1 || die "response .result is missing or not an array (fail closed)"
  n="$(jq '.result | length' "$resp")"
  [[ "$n" -lt "$LIMIT" ]] || die "TRUNCATION: got ${n} rows (== LIMIT ${LIMIT}); narrow the window and re-run"
  jq -r '.result[] | ((.timestamp|tostring) + "\t" + (.event_message // ""))' "$resp" > "$out"
}

# analyse "ts<TAB>msg" lines; return a distinct code per failure class
analyse_lines() { # $1 lines file -> echoes summary, returns code
  local f="$1" c_blocked c_started c_finished c_recfail
  c_blocked=$(grep -c 'event:blocked'               "$f" || true)
  c_started=$(grep -c 'event:provider_send_started' "$f" || true)
  c_finished=$(grep -c 'event:finished'             "$f" || true)
  c_recfail=$(grep -c 'record_failed'               "$f" || true)
  local started_ids finished_ids n_open
  started_ids="$(grep 'event:provider_send_started' "$f" | grep -oE '"invocationId":"[0-9a-fA-F-]{36}"' | sort -u || true)"
  finished_ids="$(grep 'event:finished'             "$f" | grep -oE '"invocationId":"[0-9a-fA-F-]{36}"' | sort -u || true)"
  n_open="$(comm -23 <(printf '%s\n' "$started_ids" | sed '/^$/d') <(printf '%s\n' "$finished_ids" | sed '/^$/d') | grep -c . || true)"
  log "blocked=${c_blocked} provider_send_started=${c_started} finished=${c_finished} record_failed=${c_recfail} in_flight=${n_open}"
  # priority: a real gate bypass is most severe, then straggler, then record_failed, then missing ingestion evidence
  if [[ "$EXPECT_ZERO_SENDS" == 1 && "$c_started" -ne 0 ]]; then warn "gate BYPASS: ${c_started} provider_send_started"; return 3; fi
  if [[ "$ASSERT_ALL_FINISHED" == 1 && "$n_open" -ne 0 ]]; then warn "STRAGGLER: ${n_open} send(s) not finished"; return 5; fi
  if [[ "$FAIL_ON_RECORD_FAILED" == 1 && "$c_recfail" -ne 0 ]]; then warn "record_failed present: ${c_recfail}"; return 6; fi
  if [[ "$REQUIRE_BLOCKED" == 1 && "$c_blocked" -eq 0 ]]; then warn "no positive ingestion evidence (0 event:blocked)"; return 4; fi
  return 0
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
LINES="$TMP/lines.txt"

# ---- offline paths --------------------------------------------------------
if [[ -n "$FROM_RESPONSE" ]]; then
  extract_response "$FROM_RESPONSE" "$LINES"
  rc=0; analyse_lines "$LINES" || rc=$?; exit "$rc"
fi
if [[ -n "$FROM_FILE" ]]; then
  [[ -f "$FROM_FILE" ]] || die "--from-file not found: $FROM_FILE"
  rc=0; analyse_lines "$FROM_FILE" || rc=$?; exit "$rc"
fi

# ---- live path ------------------------------------------------------------
[[ -n "$REF" && -n "$START" && -n "$END" ]] || usage
assert_ref_format "$REF"; require_cmd curl; require_cmd jq
iso_re='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
[[ "$START" =~ $iso_re ]] || die "--start must be ISO8601 UTC"
[[ "$END"   =~ $iso_re ]] || die "--end must be ISO8601 UTC"
[[ "${END//[^0-9]/}" > "${START//[^0-9]/}" ]] || die "--end must be after --start"
API="https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs.all"
do_query() { local sql; sql="$(sql_for_dialect "$1")"
  NO_COLOR=1 curl -sS -G "$API" -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    --data-urlencode "sql=${sql}" --data-urlencode "iso_timestamp_start=${START}" --data-urlencode "iso_timestamp_end=${END}"; }

if [[ "$DRY_RUN" == 1 ]]; then
  d="$DIALECT"; [[ "$d" == auto ]] && d=legacy
  log "DRY RUN — constructed request (token redacted):"
  printf 'GET %s\nAuthorization: Bearer ***REDACTED***\nsql=%s\niso_timestamp_start=%s\niso_timestamp_end=%s\n' \
    "$API" "$(sql_for_dialect "$d")" "$START" "$END" >&2
  ok "dry-run only; no network call"; exit 0
fi

[[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]] || die "SUPABASE_ACCESS_TOKEN required"
RESP="$TMP/resp.json"
if [[ "$DIALECT" == "auto" ]]; then
  do_query clickhouse > "$RESP" || die "Management API request failed"
  if ! jq -e '.error == null and (.result|type=="array")' "$RESP" >/dev/null 2>&1; then
    warn "ClickHouse dialect rejected — retrying legacy"; do_query legacy > "$RESP" || die "request failed (legacy)"; fi
else
  do_query "$DIALECT" > "$RESP" || die "Management API request failed"
fi
extract_response "$RESP" "$LINES"
mkdir -p "$HERE/../evidence"; cp "$LINES" "$HERE/../evidence/edge-log-lines.txt"
log "window ${START} .. ${END} (ref ${REF}); lines -> evidence/edge-log-lines.txt"
rc=0; analyse_lines "$LINES" || rc=$?
[[ "$rc" == 0 ]] && ok "drain analysis passed for this window"
exit "$rc"
