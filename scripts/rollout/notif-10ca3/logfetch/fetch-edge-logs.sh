#!/usr/bin/env bash
# ===========================================================================
# fetch-edge-logs.sh — retrieve send-invoice-email lifecycle events from a
# DEPLOYED Supabase project over a bounded window and prove the drain,
# FAIL-CLOSED. The installed CLI has NO `functions logs`; this uses the
# Management API analytics endpoint the Dashboard uses:
#   GET https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/logs.all
# authed with a Personal Access Token (SUPABASE_ACCESS_TOKEN, never printed).
#
# Timestamps are NORMALISED to epoch seconds (ClickHouse ISO string OR legacy
# microsecond int) so the caller enforces EXACT time boundaries locally — the
# analytics API rounds query bounds to the minute, so we widen the query and
# filter here. A "bypass" is a provider_send_started with epoch >= the gate
# instant (--gate-at-epoch); a stale/pre-gate send does not count.
#
# Authoritative correlation: --require-invocation <id> passes only if the EXACT
# canary invocation's event:blocked line is present. Empty/malformed results
# therefore fail every authoritative query.
#
# Exit codes: 0 ok | 1 setup/response error | 3 gate bypass |
#   4 required evidence absent (canary/blocked) | 5 straggler | 6 record_failed
#
# Inputs: live (--ref/--start/--end) | --from-response <json> | --from-file <epoch\tmsg>.
# ===========================================================================
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
LIMIT=1000

REF=""; START=""; END=""; DIALECT="auto"; DRY_RUN=0
EXPECT_ZERO_SENDS=1; ASSERT_ALL_FINISHED=0; REQUIRE_BLOCKED=0; FAIL_ON_RECORD_FAILED=0
REQUIRE_INVOCATION=""; GATE_AT_EPOCH=""; FROM_FILE=""; FROM_RESPONSE=""
VERIFY_INVOICE=""
EVID_DIR="${ROLLOUT_EVIDENCE_DIR:-$HERE/../evidence}"
EVID_FILE="$EVID_DIR/edge-log-lines.txt"
usage() {
  cat >&2 <<'EOF'
usage: fetch-edge-logs.sh (--ref R --start ISO --end ISO | --from-response f.json | --from-file f.txt)
  [--dialect auto|clickhouse|legacy] [--allow-sends] [--assert-all-finished]
  [--require-blocked] [--require-invocation ID] [--gate-at-epoch N]
  [--fail-on-record-failed] [--dry-run]
  [--verify-step6-invoice <invoice-uuid>]   # step 6: fetch AND verify atomically
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
    --require-invocation) REQUIRE_INVOCATION="$2"; shift 2;;
    --gate-at-epoch) GATE_AT_EPOCH="$2"; shift 2;;
    --fail-on-record-failed) FAIL_ON_RECORD_FAILED=1; shift;;
    --from-file) FROM_FILE="$2"; shift 2;; --from-response) FROM_RESPONSE="$2"; shift 2;;
    --verify-step6-invoice) VERIFY_INVOICE="$2"; shift 2;;
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

# validate a Management API response, fail closed, emit "epoch<TAB>msg" lines
extract_response() { # $1 response.json  $2 out
  local resp="$1" out="$2" n; require_cmd jq
  [[ -f "$resp" ]] || die "response file not found: $resp"
  jq -e '.error == null' "$resp" >/dev/null 2>&1 || die "analytics response carries an error (or is unparseable)"
  jq -e '.result | type == "array"' "$resp" >/dev/null 2>&1 || die "response .result is missing or not an array (fail closed)"
  n="$(jq '.result | length' "$resp")"
  [[ "$n" -lt "$LIMIT" ]] || die "TRUNCATION: got ${n} rows (== LIMIT ${LIMIT}); narrow the window"
  # normalise timestamp -> epoch seconds (number=microseconds; string=ISO, drop fractional)
  jq -r '.result[]
    | ((.timestamp) as $t
       | (if ($t|type)=="number" then ($t/1000000 | floor)
          else ($t|tostring|sub("\\.[0-9]+";"")|sub("Z$";"")|(.+"Z")|fromdateiso8601) end)) as $e
    | "\($e)\t\(.event_message // "")"' "$resp" > "$out" \
    || die "could not normalise a log timestamp (unexpected format) — fail closed"
}

analyse_lines() { # $1 epoch<TAB>msg file -> code
  local f="$1" c_blocked c_finished c_recfail c_bypass n_open
  c_blocked=$(grep -c 'event:blocked'   "$f" || true)
  c_finished=$(grep -c 'event:finished' "$f" || true)
  c_recfail=$(grep -c 'record_failed'   "$f" || true)
  if [[ -n "$GATE_AT_EPOCH" ]]; then
    c_bypass=$(awk -F'\t' -v g="$GATE_AT_EPOCH" '$2 ~ /event:provider_send_started/ && ($1+0) >= g' "$f" | grep -c . || true)
  else
    c_bypass=$(grep -c 'event:provider_send_started' "$f" || true)
  fi
  local started_ids finished_ids
  started_ids="$(grep 'event:provider_send_started' "$f" | grep -oE '"invocationId":"[0-9a-fA-F-]{36}"' | sort -u || true)"
  finished_ids="$(grep 'event:finished'             "$f" | grep -oE '"invocationId":"[0-9a-fA-F-]{36}"' | sort -u || true)"
  n_open="$(comm -23 <(printf '%s\n' "$started_ids" | sed '/^$/d') <(printf '%s\n' "$finished_ids" | sed '/^$/d') | grep -c . || true)"
  log "blocked=${c_blocked} bypass(post-gate send)=${c_bypass} finished=${c_finished} record_failed=${c_recfail} in_flight=${n_open}"
  # priority: real bypass first (always fatal), then straggler, record_failed, then missing evidence (retryable)
  if [[ "$EXPECT_ZERO_SENDS" == 1 && "$c_bypass" -ne 0 ]]; then warn "gate BYPASS: ${c_bypass} post-gate provider_send_started"; return 3; fi
  if [[ "$ASSERT_ALL_FINISHED" == 1 && "$n_open" -ne 0 ]]; then warn "STRAGGLER: ${n_open} send(s) not finished"; return 5; fi
  if [[ "$FAIL_ON_RECORD_FAILED" == 1 && "$c_recfail" -ne 0 ]]; then warn "record_failed present: ${c_recfail}"; return 6; fi
  if [[ -n "$REQUIRE_INVOCATION" ]]; then
    grep 'event:blocked' "$f" | grep -qF "\"invocationId\":\"${REQUIRE_INVOCATION}\"" \
      || { warn "canary invocation ${REQUIRE_INVOCATION} not found among blocked events"; return 4; }
  elif [[ "$REQUIRE_BLOCKED" == 1 && "$c_blocked" -eq 0 ]]; then
    warn "no positive ingestion evidence (0 event:blocked)"; return 4
  fi
  return 0
}

# --- fresh-evidence ownership -----------------------------------------------
# THE contract: only the window normalised during THIS run is ever verified.
#   * $LINES lives in a per-run temp dir and is the ONLY file handed to the
#     verifier (explicitly, via --from-file);
#   * every input path (live / --from-response / --from-file) funnels through
#     `finish`, so no early `exit` can skip verification or slip a different file
#     in front of it;
#   * a live attempt REMOVES the persistent evidence file before it starts, so a
#     failed fetch can never leave apparently-current evidence behind;
#   * the persistent copy is written only AFTER a successful normalisation, and
#     exists purely for diagnosis — nothing reads it back.
# (Before this, the fetch wrote a fixed path and the verifier defaulted to
# reading that same path independently: a failed fetch left the previous run's
# file in place and the next verification consumed it.)
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
LINES="$TMP/lines.txt"

# Verification runs ONLY on a clean analysis of the fresh window. Any failure —
# fetch, normalisation, or analysis — propagates unchanged and the verifier is
# never invoked. (mutation-pinned: verify/logfetch-integration-test.sh)
finish() {   # $1 = analysis rc
  local rc="$1" vrc=0
  if [[ "$rc" != 0 ]]; then
    [[ -n "$VERIFY_INVOICE" ]] && warn "analysis failed (rc=${rc}) — step-6 verification NOT run, nothing was verified"
    exit "$rc"
  fi
  if [[ -n "$VERIFY_INVOICE" ]]; then
    log "step-6 verification against the freshly normalised window (${LINES##*/})"
    "$HERE/verify-step6-send.sh" --invoice "$VERIFY_INVOICE" --from-file "$LINES" || vrc=$?
    [[ "$vrc" == 0 ]] || exit "$vrc"
  fi
  exit 0
}

if [[ -n "$FROM_RESPONSE" ]]; then
  extract_response "$FROM_RESPONSE" "$LINES"; rc=0; analyse_lines "$LINES" || rc=$?; finish "$rc"
fi
if [[ -n "$FROM_FILE" ]]; then
  [[ -f "$FROM_FILE" ]] || die "--from-file not found"
  cp "$FROM_FILE" "$LINES"          # verify the same bytes we analysed, never a path we did not read
  rc=0; analyse_lines "$LINES" || rc=$?; finish "$rc"
fi

[[ -n "$REF" && -n "$START" && -n "$END" ]] || usage
assert_ref_format "$REF"; require_cmd curl; require_cmd jq
# validate the invoice BEFORE any network access, so a typo cannot burn a fetch
if [[ -n "$VERIFY_INVOICE" ]]; then
  [[ "$VERIFY_INVOICE" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
    || die "--verify-step6-invoice is not a uuid"
  [[ "$DRY_RUN" == 0 ]] || die "--dry-run cannot verify anything; drop one of --dry-run / --verify-step6-invoice"
fi
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
# A LIVE ATTEMPT STARTS HERE. Invalidate the previous window first — before the
# token check, before the request — so that if anything below fails there is no
# stale file left looking like current evidence. (This is the exact false-green
# that a failed fetch produced: SUPABASE_ACCESS_TOKEN was absent, the fetch died,
# and the previous run's file stayed on disk.)
# FAIL CLOSED. `rm` must not sit on the left of `&&` or inside an `if` condition:
# bash exempts non-final commands of an AND-list from `set -e`, so a failed
# deletion would be silently ignored and the fetch would proceed with the stale
# window still on disk. Delete explicitly, then assert the postcondition. `-e` is
# false for a DANGLING symlink, so `-L` is tested too — otherwise a symlink here
# would be skipped by the guard and later written THROUGH by the cp below. A
# directory (or anything else `rm -f` cannot remove) aborts the run.
if [[ -e "$EVID_FILE" || -L "$EVID_FILE" ]]; then
  rm -f -- "$EVID_FILE" \
    || die "could not invalidate the previous evidence file (${EVID_FILE}) — refusing the live fetch"
  [[ ! -e "$EVID_FILE" && ! -L "$EVID_FILE" ]] \
    || die "previous evidence still present after removal (${EVID_FILE}) — refusing the live fetch"
  log "invalidated the previous window: ${EVID_FILE##*/}"
fi
[[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]] || die "SUPABASE_ACCESS_TOKEN required"
RESP="$TMP/resp.json"
if [[ "$DIALECT" == "auto" ]]; then
  do_query clickhouse > "$RESP" || die "Management API request failed"
  if ! jq -e '.error == null and (.result|type=="array")' "$RESP" >/dev/null 2>&1; then
    warn "ClickHouse dialect rejected — retrying legacy"; do_query legacy > "$RESP" || die "request failed (legacy)"; fi
else do_query "$DIALECT" > "$RESP" || die "Management API request failed"; fi
extract_response "$RESP" "$LINES"
mkdir -p "$EVID_DIR"; cp "$LINES" "$EVID_FILE"      # diagnosis copy only; never read back
log "window ${START} .. ${END} (ref ${REF}); lines -> ${EVID_FILE##*/}"
rc=0; analyse_lines "$LINES" || rc=$?
[[ "$rc" == 0 ]] && ok "drain analysis passed for this window"
finish "$rc"
