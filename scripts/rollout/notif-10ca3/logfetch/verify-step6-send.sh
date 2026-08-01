#!/usr/bin/env bash
# ===========================================================================
# verify-step6-send.sh — ENFORCE the step-6 correlation contract for ONE real
# invoice send. The runbook used to print grep counts next to comments saying
# "must be exactly 1" / "must be exactly 0"; nothing checked them, so a
# mis-read (or a vacuous/empty result) looked identical to a pass. This exits
# NONZERO unless every cardinality holds.
#
# Input is the normalised `epoch<TAB>event_message` file that
# fetch-edge-logs.sh writes to evidence/edge-log-lines.txt. Lines are parsed
# STRUCTURALLY (jq over the JSON payload), never grepped as free text, so a
# substring appearing inside an unrelated field can neither satisfy nor break a
# check.
#
# Contract (all six must hold):
#   1. exactly ONE event:provider_send_started for the target invoice
#      -> that line's invocationId is THE invocation (never transcribed by hand)
#   2. exactly ONE event:provider_send_started for that invocationId
#   3. exactly ONE event:finished {"outcome":"sent"} for that invocationId
#   4. ZERO event:finished with any other outcome for that invocationId
#   5. ZERO event:blocked for that invocationId
#   6. ZERO record_failed and ZERO status_update_failed for the target invoice
#      (those two log an invoiceId and NOT an invocationId, so they correlate by
#       invoice — exact for a single send of a single invoice)
#
# FAIL CLOSED: a malformed line, a non-JSON payload, a missing/!uuid id, or an
# empty file is a FAILURE, never a silent pass. Unrelated concurrent sends in
# the same window are ignored by construction — every check is keyed on an id.
#
# PII: prints ONLY counts + the two correlation uuids. Never a recipient
# address, response body, message body, error string or token.
#
# Exit: 0 pass | 1 usage/setup | 2 malformed input (fail closed) | 3 FAILED
# ===========================================================================
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"

UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
INVOICE=""; LINES=""
# --from-file is REQUIRED and has NO default. It used to default to the fixed
# evidence/edge-log-lines.txt that fetch-edge-logs.sh writes, which meant a FAILED
# fetch left the previous run's window on disk for this script to verify — a
# stale pass waiting to happen. The caller must now name the file it just
# produced; for production that is done for it by
# `fetch-edge-logs.sh --verify-step6-invoice`, which passes its own fresh temp.
usage() { cat >&2 <<'EOF'
usage: verify-step6-send.sh --invoice <invoice-uuid> --from-file <epoch\tmessage file>
  --from-file is REQUIRED (no implicit default): only a window the caller just
  fetched may be verified. Production entry point:
    fetch-edge-logs.sh --ref R --start S --end E [...] --verify-step6-invoice <uuid>
EOF
  exit 1; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --invoice)   INVOICE="${2:-}"; shift 2;;
    --from-file) LINES="${2:-}"; shift 2;;
    -h|--help)   usage;;
    *) printf 'unknown arg: %s\n' "$1" >&2; usage;;
  esac
done
[[ -n "$INVOICE" ]] || usage
[[ -n "$LINES" ]] || { printf '[step6] SETUP: --from-file is required (no implicit evidence-file default)\n' >&2; exit 1; }
[[ "$INVOICE" =~ $UUID_RE ]] || { printf '[step6] SETUP: --invoice is not a uuid\n' >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { printf '[step6] SETUP: jq is required\n' >&2; exit 1; }
[[ -f "$LINES" ]] || { printf '[step6] SETUP: log file not found: %s\n' "$LINES" >&2; exit 1; }

fail_closed() { printf '[step6] MALFORMED (fail closed): %s\n' "$1" >&2; exit 2; }

# --- structured parse: one jq pass -> step \t invocationId \t invoiceId \t outcome
TSV="$(mktemp)"; trap 'rm -f "$TSV"' EXIT
if ! jq -R -r '
  . as $line
  | (if ($line | test("\t")) then . else error("no epoch<TAB>message separator") end)
  | ($line | split("\t")) as $p
  | $p[0] as $epoch
  | ($p[1:] | join("\t")) as $msg
  | (if ($epoch | test("^[0-9]+$")) then . else error("non-numeric epoch") end)
  | (if ($msg | startswith("[SEND-INVOICE-EMAIL] ")) then . else error("unexpected log prefix") end)
  | ($msg | ltrimstr("[SEND-INVOICE-EMAIL] ")) as $rest
  | ($rest | split(" ")[0]) as $step
  | (if ($rest | test(" ")) then ($rest | sub("^[^ ]+ "; "")) else "" end) as $raw
  | (if ($raw | length) > 0
       then (try ($raw | fromjson) catch error("payload is not valid JSON"))
       else {} end) as $o
  | (if ($o | type) == "object" then . else error("payload is not a JSON object") end)
  | (($o.invocationId // "") | tostring) as $inv
  | (($o.invoiceId    // "") | tostring) as $invoice
  | (($o.outcome      // "") | tostring) as $outcome
  # ids, when present, must be well-formed; the events we assert on must carry theirs
  | ($inv     | test("^$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")) as $invok
  | ($invoice | test("^$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")) as $icok
  | (if $invok then . else error("malformed invocationId") end)
  | (if $icok  then . else error("malformed invoiceId") end)
  | (if (["event:blocked","event:provider_send_started","event:finished"] | index($step)) and ($inv | length) == 0
       then error("lifecycle event without an invocationId") else . end)
  | (if ($step == "event:provider_send_started") and ($invoice | length) == 0
       then error("provider_send_started without an invoiceId") else . end)
  | (if ($step == "event:finished") and ($outcome | length) == 0
       then error("finished without an outcome") else . end)
  | (if (["record_failed","status_update_failed"] | index($step)) and ($invoice | length) == 0
       then error("failure record without an invoiceId") else . end)
  | [$step, $inv, $invoice, $outcome] | @tsv
' "$LINES" > "$TSV" 2>"$TSV.err"; then
  fail_closed "$(head -c 400 "$TSV.err" | tr '\n' ' ')"
fi
rm -f "$TSV.err"

cnt() { awk -F'\t' -v s="$1" -v inv="${2-}" -v ic="${3-}" -v oc="${4-}" '
  $1==s && (inv=="" || $2==inv) && (ic=="" || $3==ic) && (oc=="" || $4==oc) {n++}
  END{print n+0}' "$TSV"; }

RC=0
bad() { printf '[step6] FAIL  %s\n' "$1" >&2; RC=3; }
good(){ printf '[step6] ok    %s\n' "$1" >&2; }

# 1) the ONE start for this invoice derives the invocation — no hand transcription
starts_for_invoice="$(cnt event:provider_send_started "" "$INVOICE")"
if [[ "$starts_for_invoice" -ne 1 ]]; then
  bad "provider_send_started for this invoice: ${starts_for_invoice} (need exactly 1)"
  printf '[step6] RESULT: FAILED — cannot bind an invocation for invoice %s\n' "$INVOICE" >&2
  exit 3
fi
INVOCATION="$(awk -F'\t' -v ic="$INVOICE" '$1=="event:provider_send_started" && $3==ic {print $2; exit}' "$TSV")"
[[ "$INVOCATION" =~ $UUID_RE ]] || fail_closed "derived invocationId is not a uuid"
good "bound invocation ${INVOCATION} from the single provider_send_started for this invoice"

# 2) that invocation started exactly once (a duplicate record must not pass)
n="$(cnt event:provider_send_started "$INVOCATION")"
[[ "$n" -eq 1 ]] && good "provider_send_started for this invocation: 1" \
                || bad  "provider_send_started for this invocation: ${n} (need exactly 1)"

# 3) exactly one finished/sent for THAT invocation (another invocation's finish cannot satisfy it)
n="$(cnt event:finished "$INVOCATION" "" sent)"
[[ "$n" -eq 1 ]] && good "finished{outcome=sent} for this invocation: 1" \
                || bad  "finished{outcome=sent} for this invocation: ${n} (need exactly 1)"

# 4) no other outcome for that invocation
n_all="$(cnt event:finished "$INVOCATION")"; n_sent="$(cnt event:finished "$INVOCATION" "" sent)"
n=$(( n_all - n_sent ))
[[ "$n" -eq 0 ]] && good "finished with a non-sent outcome for this invocation: 0" \
                || bad  "finished with a non-sent outcome for this invocation: ${n} (need 0)"

# 5) never blocked
n="$(cnt event:blocked "$INVOCATION")"
[[ "$n" -eq 0 ]] && good "blocked for this invocation: 0" \
                || bad  "blocked for this invocation: ${n} (need 0) — the gate was ON"

# 6) tracking + status stamp: correlated by invoice id (these carry no invocationId)
n="$(cnt record_failed "" "$INVOICE")"
[[ "$n" -eq 0 ]] && good "record_failed for this invoice: 0" \
                || bad  "record_failed for this invoice: ${n} (need 0) — sent but NOT tracked"
n="$(cnt status_update_failed "" "$INVOICE")"
[[ "$n" -eq 0 ]] && good "status_update_failed for this invoice: 0" \
                || bad  "status_update_failed for this invoice: ${n} (need 0) — UI/DB disagree"

total="$(wc -l < "$TSV" | tr -d ' ')"
if [[ "$RC" -eq 0 ]]; then
  printf '[step6] RESULT: PASS — invoice %s, invocation %s (%s parsed records)\n' "$INVOICE" "$INVOCATION" "$total" >&2
else
  printf '[step6] RESULT: FAILED — invoice %s, invocation %s (%s parsed records)\n' "$INVOICE" "$INVOCATION" "$total" >&2
fi
exit "$RC"
