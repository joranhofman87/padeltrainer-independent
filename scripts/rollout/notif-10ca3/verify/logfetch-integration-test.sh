#!/usr/bin/env bash
# ===========================================================================
# logfetch-integration-test.sh — proves the step-6 FRESH-EVIDENCE contract.
#
# The defect this pins: fetch-edge-logs.sh wrote a fixed evidence file and
# verify-step6-send.sh independently DEFAULTED to reading that same path. When a
# live fetch failed (no PAT), the previous run's file survived and the next
# verification consumed it. It happened to fail then; a stale SUCCESSFUL file for
# the same invoice would have passed and "proved" a send nobody re-verified.
#
# Contract now enforced:
#   * only the window normalised during THIS run is verified ($LINES, a per-run
#     temp), passed to the verifier explicitly with --from-file;
#   * a live attempt REMOVES the persistent evidence file before it starts;
#   * the verifier has NO implicit input and refuses to run without --from-file;
#   * fetch / normalisation / analysis failures propagate and the verifier is
#     never invoked.
#
# No network: the live path is exercised with a stubbed `curl` (and with the PAT
# deliberately absent). Production still uses the real Management API path.
# Run: bash scripts/rollout/notif-10ca3/verify/logfetch-integration-test.sh
# ===========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FEL="$HERE/../logfetch/fetch-edge-logs.sh"
VS="$HERE/../logfetch/verify-step6-send.sh"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"; rm -f "$HERE/../logfetch/.mutant-"*.sh' EXIT

P=0; F=0
pass(){ P=$((P+1)); echo "  PASS  $*"; }
fail(){ F=$((F+1)); echo "  FAIL  $*"; }

INV=aaaaaaaa-1111-1111-1111-111111111111        # our invocation
IC=24aa09ea-ce1f-4522-b6d5-202608ce73d0         # our invoice (the real step-6 one)
OINV=cccccccc-3333-3333-3333-333333333333       # a concurrent unrelated send
OIC=dddddddd-4444-4444-4444-444444444444
REF=abcdefghijklmnopqrst

# --- response builders (Management API shape) -------------------------------
row(){ printf '{"timestamp":"%s","event_message":"%s"}' "$1" "$2"; }
ev_start(){ printf '[SEND-INVOICE-EMAIL] event:provider_send_started {\\"invocationId\\":\\"%s\\",\\"invoiceId\\":\\"%s\\"}' "$1" "$2"; }
ev_fin(){   printf '[SEND-INVOICE-EMAIL] event:finished {\\"invocationId\\":\\"%s\\",\\"invoiceId\\":\\"%s\\",\\"outcome\\":\\"%s\\"}' "$1" "$2" "$3"; }
ev_recfail(){ printf '[SEND-INVOICE-EMAIL] record_failed {\\"invoiceId\\":\\"%s\\",\\"eventType\\":\\"sent\\",\\"error\\":\\"boom\\"}' "$1"; }
resp_ok(){ # a clean target send amid unrelated concurrent traffic
  { printf '{"error":null,"result":['
    row "2026-08-01T12:38:39Z" "$(ev_start "$OINV" "$OIC")"; printf ','
    row "2026-08-01T12:38:40Z" "$(ev_start "$INV" "$IC")";  printf ','
    row "2026-08-01T12:38:41Z" "$(ev_fin "$INV" "$IC" sent)"; printf ','
    row "2026-08-01T12:38:42Z" "$(ev_fin "$OINV" "$OIC" sent)"
    printf ']}'; } > "$1"; }
resp_recfail(){
  { printf '{"error":null,"result":['
    row "2026-08-01T12:38:40Z" "$(ev_start "$INV" "$IC")"; printf ','
    row "2026-08-01T12:38:41Z" "$(ev_fin "$INV" "$IC" sent)"; printf ','
    row "2026-08-01T12:38:42Z" "$(ev_recfail "$IC")"
    printf ']}'; } > "$1"; }
resp_straggler(){   # started, never finished -> --assert-all-finished must fail
  { printf '{"error":null,"result":['
    row "2026-08-01T12:38:40Z" "$(ev_start "$INV" "$IC")"
    printf ']}'; } > "$1"; }
# A window whose ANALYSIS fails while OUR invoice looks perfect: the record_failed
# belongs to somebody else's invoice. analyse_lines counts record_failed globally
# (any untracked send in the window is a problem), but the verifier only inspects
# our invoice — so this is the fixture that distinguishes "the analysis gate is
# load-bearing" from "the verifier happened to catch it anyway".
resp_recfail_other(){
  { printf '{"error":null,"result":['
    row "2026-08-01T12:38:40Z" "$(ev_start "$INV" "$IC")"; printf ','
    row "2026-08-01T12:38:41Z" "$(ev_fin "$INV" "$IC" sent)"; printf ','
    row "2026-08-01T12:38:42Z" "$(ev_recfail "$OIC")"
    printf ']}'; } > "$1"; }
resp_empty(){ printf '{"error":null,"result":[]}' > "$1"; }
resp_malformed(){ printf '{"error":"boom","result":null}' > "$1"; }

STALE_MSG="$(ev_start "$INV" "$IC")"
seed_stale(){ # a VALID, SUCCESSFUL window for the SAME invoice, left by an earlier run
  mkdir -p "$1"
  { printf '1754051920\t[SEND-INVOICE-EMAIL] event:provider_send_started {"invocationId":"%s","invoiceId":"%s"}\n' "$INV" "$IC"
    printf '1754051921\t[SEND-INVOICE-EMAIL] event:finished {"invocationId":"%s","invoiceId":"%s","outcome":"sent"}\n' "$INV" "$IC"
  } > "$1/edge-log-lines.txt"; }

# stubbed live transport
BIN="$ROOT/bin"; mkdir -p "$BIN"
cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${STUB_RESPONSE:-}" && -f "${STUB_RESPONSE}" ]]; then cat "$STUB_RESPONSE"; exit 0; fi
exit 7      # transport failure
EOF
chmod +x "$BIN/curl"
live(){ # $1 evidence dir, $2 script, rest: extra args ; STUB_RESPONSE/token from caller
  local ev="$1" script="$2"; shift 2
  ( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$ev" bash "$script" \
      --ref "$REF" --start 2026-08-01T12:37:00Z --end 2026-08-01T12:41:00Z \
      --allow-sends --assert-all-finished --fail-on-record-failed "$@" ) >/dev/null 2>&1; }
offline(){ # $1 evidence dir, $2 script, $3 response file, rest: extra args
  local ev="$1" script="$2" resp="$3"; shift 3
  ( ROLLOUT_EVIDENCE_DIR="$ev" bash "$script" --from-response "$resp" \
      --allow-sends --assert-all-finished --fail-on-record-failed "$@" ) >/dev/null 2>&1; }

echo "== THE REGRESSION: a failed fetch must not let a stale window be verified =="
EV="$ROOT/ev1"; seed_stale "$EV"
[[ -s "$EV/edge-log-lines.txt" ]] && pass "seeded a VALID successful stale window for the same invoice" || fail "seed failed"
# no PAT, so the live attempt dies before the request — exactly the observed case
( unset SUPABASE_ACCESS_TOKEN; live "$EV" "$FEL" --verify-step6-invoice "$IC" ); rc=$?
[[ "$rc" -ne 0 ]] && pass "live fetch without a PAT -> nonzero ($rc)" || fail "failed fetch reported success"
[[ ! -f "$EV/edge-log-lines.txt" ]] && pass "the stale window was INVALIDATED before the attempt (not left looking current)" \
                                    || fail "stale evidence file survived a failed live attempt"
# and with a transport failure after the token check
EV="$ROOT/ev2"; seed_stale "$EV"
( export SUPABASE_ACCESS_TOKEN=stub-not-a-real-token; unset STUB_RESPONSE; live "$EV" "$FEL" --verify-step6-invoice "$IC" ); rc=$?
[[ "$rc" -ne 0 ]] && pass "live fetch with a failing transport -> nonzero ($rc)" || fail "transport failure reported success"
[[ ! -f "$EV/edge-log-lines.txt" ]] && pass "stale window invalidated on transport failure too" || fail "stale file survived"

echo "== a fresh, current window verifies =="
EV="$ROOT/ev3"; mkdir -p "$EV"; resp_ok "$ROOT/ok.json"
export STUB_RESPONSE="$ROOT/ok.json"
( export SUPABASE_ACCESS_TOKEN=stub-not-a-real-token; live "$EV" "$FEL" --verify-step6-invoice "$IC" ); rc=$?
[[ "$rc" -eq 0 ]] && pass "fresh live window + integrated verification -> exit 0" || fail "clean live run rejected (exit=$rc)"
[[ -s "$EV/edge-log-lines.txt" ]] && pass "a fresh PII-safe evidence copy is retained for diagnosis" || fail "no fresh evidence written"
grep -q "$IC" "$EV/edge-log-lines.txt" && pass "the retained copy is the window just fetched" || fail "retained copy does not match"
unset STUB_RESPONSE

echo "== isolation, wrong invoice, and analysis failures block verification =="
offline "$ROOT/ev4" "$FEL" "$ROOT/ok.json" --verify-step6-invoice "$IC"
[[ $? -eq 0 ]] && pass "unrelated concurrent sends in the same window stay isolated" || fail "concurrent traffic broke the verdict"
offline "$ROOT/ev5" "$FEL" "$ROOT/ok.json" --verify-step6-invoice "$OIC"
[[ $? -eq 0 ]] && pass "the other party's invoice verifies on its own record" || fail "other invoice rejected"
offline "$ROOT/ev6" "$FEL" "$ROOT/ok.json" --verify-step6-invoice 99999999-9999-9999-9999-999999999999
[[ $? -ne 0 ]] && pass "an invoice absent from the window -> nonzero" || fail "verified an absent invoice"
resp_recfail "$ROOT/recfail.json"
offline "$ROOT/ev7" "$FEL" "$ROOT/recfail.json" --verify-step6-invoice "$IC"
[[ $? -ne 0 ]] && pass "record_failed -> analysis fails, verification never runs" || fail "record_failed accepted"
resp_straggler "$ROOT/straggler.json"
offline "$ROOT/ev8" "$FEL" "$ROOT/straggler.json" --verify-step6-invoice "$IC"
[[ $? -ne 0 ]] && pass "unfinished send -> analysis fails, verification never runs" || fail "straggler accepted"
resp_recfail_other "$ROOT/recfail_other.json"
offline "$ROOT/ev7b" "$FEL" "$ROOT/recfail_other.json" --verify-step6-invoice "$IC"
[[ $? -ne 0 ]] && pass "record_failed for ANOTHER invoice still blocks verification (window-level analysis is conservative)" \
               || fail "an untracked send elsewhere in the window was ignored"
resp_empty "$ROOT/empty.json"
offline "$ROOT/ev9" "$FEL" "$ROOT/empty.json" --verify-step6-invoice "$IC"
[[ $? -ne 0 ]] && pass "empty result -> nonzero (no vacuous pass)" || fail "empty window accepted"
resp_malformed "$ROOT/bad.json"
offline "$ROOT/ev10" "$FEL" "$ROOT/bad.json" --verify-step6-invoice "$IC"
[[ $? -ne 0 ]] && pass "malformed response -> nonzero (fail closed)" || fail "malformed response accepted"
# truncation: LIMIT rows means the window may be incomplete
python3 - "$ROOT/trunc.json" "$INV" "$IC" <<'PY'
import sys,json
out,inv,ic=sys.argv[1],sys.argv[2],sys.argv[3]
rows=[{"timestamp":"2026-08-01T12:38:40Z","event_message":f'[SEND-INVOICE-EMAIL] event:provider_send_started {{"invocationId":"{inv}","invoiceId":"{ic}"}}'} for _ in range(1000)]
json.dump({"error":None,"result":rows},open(out,"w"))
PY
offline "$ROOT/ev11" "$FEL" "$ROOT/trunc.json" --verify-step6-invoice "$IC"
[[ $? -ne 0 ]] && pass "truncated page (== LIMIT) -> nonzero (window may be incomplete)" || fail "truncated window accepted"
# a verifier failure (duplicate start) must propagate through the wrapper
python3 - "$ROOT/dup.json" "$INV" "$IC" <<'PY'
import sys,json
out,inv,ic=sys.argv[1],sys.argv[2],sys.argv[3]
s=lambda t: {"timestamp":t,"event_message":f'[SEND-INVOICE-EMAIL] event:provider_send_started {{"invocationId":"{inv}","invoiceId":"{ic}"}}'}
f={"timestamp":"2026-08-01T12:38:41Z","event_message":f'[SEND-INVOICE-EMAIL] event:finished {{"invocationId":"{inv}","invoiceId":"{ic}","outcome":"sent"}}'}
json.dump({"error":None,"result":[s("2026-08-01T12:38:40Z"),s("2026-08-01T12:38:40Z"),f]},open(out,"w"))
PY
offline "$ROOT/ev12" "$FEL" "$ROOT/dup.json" --verify-step6-invoice "$IC"
[[ $? -ne 0 ]] && pass "a verifier failure propagates nonzero through the fetch wrapper" || fail "verifier failure swallowed"

echo "== the verifier has no implicit input =="
EV="$ROOT/ev13"; seed_stale "$EV"
( ROLLOUT_EVIDENCE_DIR="$EV" bash "$VS" --invoice "$IC" ) >/dev/null 2>&1
[[ $? -eq 1 ]] && pass "standalone verifier without --from-file -> usage error (exit 1)" || fail "verifier ran with an implicit default"
( bash "$VS" --invoice "$IC" --from-file "$EV/edge-log-lines.txt" ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "explicit --from-file still supported for fixtures/offline use" || fail "explicit fixture use broken"
# --dry-run can never masquerade as verification
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$ROOT/ev14" bash "$FEL" --ref "$REF" \
    --start 2026-08-01T12:37:00Z --end 2026-08-01T12:41:00Z --dry-run --verify-step6-invoice "$IC" ) >/dev/null 2>&1
[[ $? -ne 0 ]] && pass "--dry-run + --verify-step6-invoice is refused (a dry run proves nothing)" || fail "dry-run posed as verification"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$ROOT/ev15" bash "$FEL" --ref "$REF" \
    --start 2026-08-01T12:37:00Z --end 2026-08-01T12:41:00Z --verify-step6-invoice not-a-uuid ) >/dev/null 2>&1
[[ $? -ne 0 ]] && pass "a non-uuid invoice is rejected BEFORE any network access" || fail "bad uuid reached the network"

echo "== MUTANTS: each reopens the stale-evidence path and must be killed =="
mutant(){ local name="$1"; local sedexpr="$2"; local m="$HERE/../logfetch/.mutant-$name.sh"
  sed "$sedexpr" "$FEL" > "$m"; printf '%s' "$m"; }

# (i) verify the PERSISTENT file instead of the fresh temp
M="$(mutant stalefile 's|--from-file "$LINES"|--from-file "$EVID_FILE"|')"
grep -q -- '--from-file "$EVID_FILE"' "$M" && pass "mutant (i) built: verifier reads the persistent file" || fail "mutant (i) sed did not apply"
EV="$ROOT/m1"; seed_stale "$EV"; export STUB_RESPONSE="$ROOT/ok.json"
( export SUPABASE_ACCESS_TOKEN=stub-not-a-real-token; live "$EV" "$M" --verify-step6-invoice "$OIC" ); rc=$?
[[ "$rc" -eq 0 ]] && pass "MUTANT (persistent file) verifies the WRONG window — fresh-temp binding is load-bearing" \
                  || fail "mutant (i) not distinguishable (exit=$rc)"
unset STUB_RESPONSE

# (ii) ignore the fetch/analysis exit status
M="$(mutant ignorerc 's|^  local rc="$1" vrc=0|  local rc=0 vrc=0|')"
grep -q 'local rc=0 vrc=0' "$M" && pass "mutant (ii) built: analysis status ignored" || fail "mutant (ii) sed did not apply"
offline "$ROOT/m2" "$M" "$ROOT/recfail_other.json" --verify-step6-invoice "$IC"
[[ $? -eq 0 ]] && pass "MUTANT (ignores fetch/analysis status) reports success on a window with an untracked send — propagation is load-bearing" \
               || fail "mutant (ii) still rejected"

# (iii) run the verifier even when the analysis failed
M="$(mutant afterfail 's|^    \[\[ -n "$VERIFY_INVOICE" \]\] \&\& warn "analysis failed|    [[ -n "$VERIFY_INVOICE" ]] \&\& "$HERE/verify-step6-send.sh" --invoice "$VERIFY_INVOICE" --from-file "$LINES"; [[ -n "$VERIFY_INVOICE" ]] \&\& exit 0; warn "analysis failed|')"
grep -q 'exit 0; warn "analysis failed' "$M" && pass "mutant (iii) built: verifier invoked after a failed analysis" || fail "mutant (iii) sed did not apply"
offline "$ROOT/m3" "$M" "$ROOT/recfail_other.json" --verify-step6-invoice "$IC"
[[ $? -eq 0 ]] && pass "MUTANT (verify after failed analysis) reports success despite a failed analysis — the gate is load-bearing" \
               || fail "mutant (iii) still rejected"

# (iv) restore the verifier's implicit default input
MV="$HERE/../logfetch/.mutant-implicit.sh"
sed 's|^INVOICE=""; LINES=""|INVOICE=""; LINES="${ROLLOUT_EVIDENCE_DIR:-$HERE/../evidence}/edge-log-lines.txt"|' "$VS" > "$MV"
grep -q 'LINES="${ROLLOUT_EVIDENCE_DIR' "$MV" && pass "mutant (iv) built: verifier default input restored" || fail "mutant (iv) sed did not apply"
EV="$ROOT/m4"; seed_stale "$EV"
( ROLLOUT_EVIDENCE_DIR="$EV" bash "$MV" --invoice "$IC" ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (implicit default) silently verifies a STALE file — requiring --from-file is load-bearing" \
               || fail "mutant (iv) still rejected"

# (v) remove the prior-evidence invalidation
M="$(mutant noinvalidate 's|^if \[\[ -f "$EVID_FILE" \]\]; then rm -f "$EVID_FILE".*|:|')"
grep -qv 'invalidated the previous window' "$M" && pass "mutant (v) built: invalidation removed" || fail "mutant (v) sed did not apply"
EV="$ROOT/m5"; seed_stale "$EV"
( unset SUPABASE_ACCESS_TOKEN; live "$EV" "$M" --verify-step6-invoice "$IC" )
[[ -f "$EV/edge-log-lines.txt" ]] && pass "MUTANT (no invalidation) leaves a stale window looking current — invalidation is load-bearing" \
                                  || fail "mutant (v) still removed the file"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
