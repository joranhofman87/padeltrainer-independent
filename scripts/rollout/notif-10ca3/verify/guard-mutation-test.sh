#!/usr/bin/env bash
# ===========================================================================
# guard-mutation-test.sh — proves the rollout's CRITICAL guards are load-bearing:
# each real guard rejects the unsafe input, and a weakened MUTANT wrongly
# accepts it. Covers identity, exact-pending-set, the authoritative drain
# (incl. fail-closed log validation), the 400s drain-window floor, project-ref
# scoping, SHA-pin drift, ledger classification, and baseline key validation.
# Run: bash scripts/rollout/notif-10ca3/verify/guard-mutation-test.sh
# ===========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../lib/common.sh"
source "$HERE/../PINS.env"
FEL="$HERE/../logfetch/fetch-edge-logs.sh"
RR="$HERE/../run-rollout.sh"
V1=20261006100000; V2=20261006110000; V3=20261006120000
EXPECTED_VERSIONS="$(printf '%s\n%s\n%s\n' "$V1" "$V2" "$V3")"

P=0; F=0
pass(){ P=$((P+1)); echo "  PASS  $*"; }
fail(){ F=$((F+1)); echo "  FAIL  $*"; }
reject(){ local d="$1"; shift; if ( "$@" ) >/dev/null 2>&1; then fail "$d — ACCEPTED (should reject)"; else pass "$d"; fi; }
accept(){ local d="$1"; shift; if ( "$@" ) >/dev/null 2>&1; then pass "$d"; else fail "$d — REJECTED (should accept)"; fi; }
eq(){ local d="$1" a="$2" e="$3"; [[ "$a" == "$e" ]] && pass "$d" || fail "$d (got '$a' want '$e')"; }

REF=abcdefghijklmnopqrst
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "== guard 1: EXACT identity allow-list =="
ATTACK="db.${REF}.supabase.co.evil.com"
reject "real assert_host_user_is_ref rejects look-alike host" assert_host_user_is_ref "$REF" "$ATTACK" postgres
mutant_identity(){ [[ "$2" == *"$1"* ]]; }
accept "MUTANT substring-identity wrongly accepts look-alike (guard load-bearing)" mutant_identity "$REF" "$ATTACK"
reject "real assert_conn_url_is_ref rejects spoofed-host URL" assert_conn_url_is_ref "$REF" "postgresql://postgres:pw@db.${REF}.supabase.co.evil.com/postgres"

echo "== guard 2: EXACT pending-migration set =="
SUPERSET="$(printf '%s\n%s\n%s\n%s\n' "$V1" "$V2" "$V3" 20261006130000)"
reject "real pending-guard rejects an extra 4th migration" assert_pending_is_expected "$SUPERSET" "$EXPECTED_VERSIONS"
reject "real pending-guard rejects a missing migration" assert_pending_is_expected "$(printf '%s\n%s\n' "$V1" "$V2")" "$EXPECTED_VERSIONS"
mutant_pending(){ local v; while read -r v; do [[ -z "$v" ]] && continue; printf '%s\n' "$1" | grep -qx "$v" || return 1; done <<< "$2"; }
accept "MUTANT subset-pending wrongly accepts a superset (guard load-bearing)" mutant_pending "$SUPERSET" "$EXPECTED_VERSIONS"

echo "== guard 3: authoritative drain proof (exact canary correlation) =="
GATE=1000000
CANARY=aaaaaaaa-1111-1111-1111-111111111111
OTHER=bbbbbbbb-2222-2222-2222-222222222222
mkb(){ printf '%s\t[SEND-INVOICE-EMAIL] event:blocked {"invocationId":"%s"}\n' "$1" "$2"; }
mks(){ printf '%s\t[SEND-INVOICE-EMAIL] event:provider_send_started {"invocationId":"%s"}\n' "$1" "$2"; }
mkf(){ printf '%s\t[SEND-INVOICE-EMAIL] event:finished {"invocationId":"%s"}\n' "$1" "$2"; }
mkb 1000001 "$CANARY" > "$TMP/drained.txt"                                        # exact canary, clean
mkb 946684800 "$OTHER" > "$TMP/stale.txt"                                         # unrelated blocked, year 2000
{ mkb 1000001 "$CANARY"; mks 1000005 "$OTHER"; mkf 1000006 "$OTHER"; } > "$TMP/bypass.txt"   # post-gate send (finished)
{ mkb 1000001 "$CANARY"; mks 999000 "$OTHER"; mkf 999500 "$OTHER"; } > "$TMP/pregate.txt"   # pre-gate, finished
{ mkb 1000001 "$CANARY"; mks 999000 "$OTHER"; } > "$TMP/straggler.txt"            # pre-gate, unfinished
{ mkb 1000001 "$CANARY"; printf '%s\t[SEND-INVOICE-EMAIL] record_failed {}\n' 1000002; } > "$TMP/recfail.txt"
: > "$TMP/empty.txt"
D=(--gate-at-epoch "$GATE" --require-invocation "$CANARY" --assert-all-finished --fail-on-record-failed)
accept "exact canary evidence + clean window passes"                 bash "$FEL" --from-file "$TMP/drained.txt" "${D[@]}"
reject "unrelated/stale blocked (dated 2000) fails exact correlation" bash "$FEL" --from-file "$TMP/stale.txt" "${D[@]}"
reject "WRONG canary id fails"                                        bash "$FEL" --from-file "$TMP/drained.txt" --gate-at-epoch "$GATE" --require-invocation "$OTHER" --assert-all-finished
reject "gate BYPASS (post-gate provider_send_started) fails"         bash "$FEL" --from-file "$TMP/bypass.txt" "${D[@]}"
accept "pre-gate finished send is NOT a bypass (exact local boundary)" bash "$FEL" --from-file "$TMP/pregate.txt" "${D[@]}"
reject "in-flight straggler fails"                                    bash "$FEL" --from-file "$TMP/straggler.txt" "${D[@]}"
reject "record_failed fails"                                          bash "$FEL" --from-file "$TMP/recfail.txt" "${D[@]}"
reject "EMPTY widened snapshot fails exact correlation (no false-green)" bash "$FEL" --from-file "$TMP/empty.txt" "${D[@]}"
# MUTANTS — each weakened guard wrongly accepts the unsafe input
accept "MUTANT --allow-sends wrongly accepts a bypass (gate guard load-bearing)" bash "$FEL" --from-file "$TMP/bypass.txt" --gate-at-epoch "$GATE" --require-invocation "$CANARY" --allow-sends --assert-all-finished
accept "MUTANT require-blocked(any) wrongly accepts the stale-2000 event (exact-id guard load-bearing)" bash "$FEL" --from-file "$TMP/stale.txt" --gate-at-epoch "$GATE" --require-blocked
accept "MUTANT without --assert-all-finished wrongly accepts a straggler (guard load-bearing)" bash "$FEL" --from-file "$TMP/straggler.txt" --gate-at-epoch "$GATE" --require-invocation "$CANARY" --fail-on-record-failed
accept "MUTANT without --require-invocation wrongly accepts an EMPTY window (guard load-bearing)" bash "$FEL" --from-file "$TMP/empty.txt" --gate-at-epoch "$GATE"
reject "assert_drain_proven rejects elapsed < min" assert_drain_proven 30 520 0
accept "assert_drain_proven accepts elapsed>=min & 0 sends" assert_drain_proven 600 520 0

echo "== guard 3b: FAIL-CLOSED response validation (empty/missing/truncated) =="
printf '%s' '{"result":[],"error":null}' > "$TMP/empty.json"
printf '%s' '{"error":null}'             > "$TMP/missing.json"
jq -n '{result:[range(1000)|{timestamp:"t",event_message:"[SEND-INVOICE-EMAIL] event:blocked {}"}],error:null}' > "$TMP/trunc.json"
printf '%s' '{"result":[{"timestamp":"2026-07-31T13:00:00Z","event_message":"[SEND-INVOICE-EMAIL] event:blocked {\"invocationId\":\"aaaaaaaa-1111-1111-1111-111111111111\"}"}],"error":null}' > "$TMP/valid.json"
reject "empty .result fails exact correlation (narrow-ok/wide-empty defeated)" bash "$FEL" --from-response "$TMP/empty.json" --require-invocation "$CANARY"
reject "missing .result fails closed"                          bash "$FEL" --from-response "$TMP/missing.json"
reject "truncated page (== LIMIT) fails closed"                bash "$FEL" --from-response "$TMP/trunc.json"
accept "valid response with the exact canary passes"           bash "$FEL" --from-response "$TMP/valid.json" --require-invocation "$CANARY"

echo "== guard 4: 400s drain-window floor =="
reject "assert_drain_window rejects 180s (< 400s function wall)" assert_drain_window 180
reject "assert_drain_window rejects 120s default of prior version" assert_drain_window 120
accept "assert_drain_window accepts 520s floor" assert_drain_window 520

echo "== guard 5: --project-ref scoping on deploy/secret =="
check_scoping(){ ! grep -nE 'supabase (secrets (set|unset)|functions deploy)' "$1" | grep -vq -- '--project-ref'; }
accept "run-rollout.sh has no unscoped secrets/deploy commands" check_scoping "$RR"
sed 's/ --project-ref "\$EXPECTED_REF"//g' "$RR" > "$TMP/mutant-rr.sh"
reject "MUTANT (project-ref stripped) is caught by the scoping check" check_scoping "$TMP/mutant-rr.sh"

echo "== guard 6: SHA-pin drift =="
reject "assert_sha_matches_pin rejects a drifted head" assert_sha_matches_pin "$(printf 'a%.0s' $(seq 40))" "$PR615_SHA" "#615"
accept "assert_sha_matches_pin accepts the exact pin" assert_sha_matches_pin "$PR615_SHA" "$PR615_SHA" "#615"

echo "== guard 7: ledger classification (only ordered prefixes) =="
eq "classify none"          "$(classify_ledger ""            "$V1" "$V2" "$V3")" none
eq "classify prefix1 {V1}"  "$(classify_ledger "$V1"         "$V1" "$V2" "$V3")" prefix1
eq "classify prefix2 {V1,V2}" "$(classify_ledger "$V1,$V2"   "$V1" "$V2" "$V3")" prefix2
eq "classify all"           "$(classify_ledger "$V1,$V2,$V3" "$V1" "$V2" "$V3")" all
eq "classify {V2} = invalid"     "$(classify_ledger "$V2"      "$V1" "$V2" "$V3")" invalid
eq "classify {V1,V3} = invalid"  "$(classify_ledger "$V1,$V3"  "$V1" "$V2" "$V3")" invalid
mutant_count_classify(){ local n; n=$(printf '%s' "$1" | tr ',' '\n' | sed '/^$/d' | grep -c .); case "$n" in 0) echo none;; 3) echo all;; *) echo prefix;; esac; }
eq "MUTANT count-classifier wrongly calls {V1,V3} a prefix (guard load-bearing)" "$(mutant_count_classify "$V1,$V3")" prefix

echo "== guard 8: baseline key validation + CORRECT preserve set =="
A=$(printf 'a%.0s' $(seq 32)); B=$(printf 'b%.0s' $(seq 32)); C=$(printf 'c%.0s' $(seq 32)); Dd=$(printf 'd%.0s' $(seq 32))
mkbase(){ printf 'eas_rows=%s\nede_rows=%s\neas_bad_state_rows=%s\nreader_academy_md5=%s\nreader_overview_md5=%s\n' "$1" "$2" "$3" "$4" "$5"; }
mkbase 5 3 1 "$A" "$B" > "$TMP/good.txt"
accept "validate_baseline_keys accepts a well-formed snapshot" validate_baseline_keys "$TMP/good.txt" ok
grep -v '^ede_rows=' "$TMP/good.txt" > "$TMP/missing_key.txt"
reject "validate_baseline_keys rejects a missing key" validate_baseline_keys "$TMP/missing_key.txt" missing
{ cat "$TMP/good.txt"; echo 'ede_rows=99'; } > "$TMP/dup_key.txt"
reject "validate_baseline_keys rejects a duplicated key" validate_baseline_keys "$TMP/dup_key.txt" dup
sed 's/^eas_rows=5/eas_rows=oops/' "$TMP/good.txt" > "$TMP/badval.txt"
reject "validate_baseline_keys rejects a non-numeric count" validate_baseline_keys "$TMP/badval.txt" badval
# CORRECT preserve set: bad_state MAY change (recompute), rows must not, readers must change
mkbase 5 3 1 "$A" "$B" > "$TMP/pre.txt"
mkbase 5 3 9 "$C" "$Dd" > "$TMP/post_ok.txt"            # rows same, bad_state changed, readers changed
mkbase 4 3 1 "$C" "$Dd" > "$TMP/post_rowloss.txt"       # eas rows differ
mkbase 5 3 9 "$A" "$B"  > "$TMP/post_readersame.txt"    # readers unchanged
accept "assert_baseline_preserved accepts a legitimate bad_state recomputation" assert_baseline_preserved "$TMP/pre.txt" "$TMP/post_ok.txt"
reject "assert_baseline_preserved rejects row loss"            assert_baseline_preserved "$TMP/pre.txt" "$TMP/post_rowloss.txt"
reject "assert_baseline_preserved rejects unchanged readers"   assert_baseline_preserved "$TMP/pre.txt" "$TMP/post_readersame.txt"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
