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

echo "== guard 8: manifest COMPLETENESS + snapshot-consistency + no-loss =="
h(){ printf "%0.s$1" $(seq 64); }         # a 64-hex fingerprint of the given nibble
FA=$(h a); FB=$(h b); FC=$(h c); E1=$(h 1); E2=$(h 3); E3=$(h e)
R32A=$(printf 'a%.0s' $(seq 32)); R32B=$(printf 'b%.0s' $(seq 32)); R32C=$(printf 'c%.0s' $(seq 32)); R32D=$(printf 'd%.0s' $(seq 32))
evblock(){ printf 'EV eas_rows=%s\nEV ede_rows=%s\nEV eas_bad_state_rows=%s\nEV reader_academy_md5=%s\nEV reader_overview_md5=%s\n' "$1" "$2" "$3" "$4" "$5"; }
{ echo "EAS $FA"; echo "EAS $FB"; echo "EDE $E1"; echo "EDE $E2"; evblock 2 2 1 "$R32A" "$R32B"; } > "$TMP/man_pre.txt"
accept "validate_manifest accepts a complete, consistent manifest" validate_manifest "$TMP/man_pre.txt" ok
# COMPLETENESS mutations (the vacuous-manifest class Codex reproduced)
{ evblock 2 2 1 "$R32A" "$R32B"; } > "$TMP/man_zero.txt"                                   # counts say 2/2 but ZERO fingerprints
reject "validate_manifest rejects zero fingerprints with positive counts" validate_manifest "$TMP/man_zero.txt" zero
{ echo "EAS $FA"; echo "EDE $E1"; echo "EDE $E2"; evblock 2 2 1 "$R32A" "$R32B"; } > "$TMP/man_omit.txt"  # one EAS omitted
reject "validate_manifest rejects an omitted fingerprint (count mismatch)" validate_manifest "$TMP/man_omit.txt" omit
{ echo "EAS $FA"; echo "EAS $FA"; echo "EDE $E1"; echo "EDE $E2"; evblock 2 2 1 "$R32A" "$R32B"; } > "$TMP/man_dupfp.txt"  # duplicate EAS
reject "validate_manifest rejects duplicate fingerprints" validate_manifest "$TMP/man_dupfp.txt" dupfp
{ echo 'EAS deadbeef'; echo "EAS $FB"; echo "EDE $E1"; echo "EDE $E2"; evblock 2 2 1 "$R32A" "$R32B"; } > "$TMP/man_malformed.txt"  # short hex
reject "validate_manifest rejects a malformed fingerprint line" validate_manifest "$TMP/man_malformed.txt" malformed
{ echo "EAS $FA"; echo "EAS $FB"; echo 'WAT something'; echo "EDE $E1"; echo "EDE $E2"; evblock 2 2 1 "$R32A" "$R32B"; } > "$TMP/man_unknown.txt"
reject "validate_manifest rejects an unknown line" validate_manifest "$TMP/man_unknown.txt" unknown
{ cat "$TMP/man_pre.txt"; echo 'EV unexpected=accepted'; } > "$TMP/man_unknown_ev.txt"
reject "validate_manifest rejects an unknown EV key (explicit allow-list)" validate_manifest "$TMP/man_unknown_ev.txt" unknown_ev
{ echo "EAS $FA"; echo "EAS $FB"; echo "EDE $E1"; echo "EDE $E2"; evblock 2 2 5 "$R32A" "$R32B"; } > "$TMP/man_badgt.txt"
reject "validate_manifest rejects eas_bad_state_rows > eas_rows (impossible)" validate_manifest "$TMP/man_badgt.txt" badgt
grep -v '^EV ede_rows=' "$TMP/man_pre.txt" > "$TMP/man_evmiss.txt"
reject "validate_manifest rejects a missing EV key" validate_manifest "$TMP/man_evmiss.txt" evmiss
# no-loss: new rows + changed readers OK; a lost key/id fails; unchanged readers fail
{ echo "EAS $FA"; echo "EAS $FB"; echo "EAS $FC"; echo "EDE $E1"; echo "EDE $E2"; echo "EDE $E3"; evblock 3 3 3 "$R32C" "$R32D"; } > "$TMP/man_ok.txt"
{ echo "EAS $FA";               echo "EAS $FC"; echo "EDE $E1"; echo "EDE $E2";  evblock 2 2 1 "$R32C" "$R32D"; } > "$TMP/man_easloss.txt"   # FB lost, FC new
{ echo "EAS $FA"; echo "EAS $FB"; echo "EDE $E1"; echo "EDE $E3";                evblock 2 2 1 "$R32C" "$R32D"; } > "$TMP/man_edeloss.txt"   # E2 lost, E3 new
{ echo "EAS $FA"; echo "EAS $FB"; echo "EAS $FC"; echo "EDE $E1"; echo "EDE $E2"; echo "EDE $E3"; evblock 3 3 3 "$R32A" "$R32B"; } > "$TMP/man_readersame.txt"
accept "no-loss accepts NEW rows (pre-gate finish / webhook) + changed readers" assert_manifest_no_loss "$TMP/man_pre.txt" "$TMP/man_ok.txt"
reject "no-loss rejects a LOST email_address_state key"   assert_manifest_no_loss "$TMP/man_pre.txt" "$TMP/man_easloss.txt"
reject "no-loss rejects a LOST email_delivery_events id"  assert_manifest_no_loss "$TMP/man_pre.txt" "$TMP/man_edeloss.txt"
reject "no-loss rejects unchanged reader fingerprints"    assert_manifest_no_loss "$TMP/man_pre.txt" "$TMP/man_readersame.txt"

echo "== guard 9: the production drain wait has no env backdoor =="
no_wait_backdoor(){ ! grep -qE 'ROLLOUT_TEST_FAST_DRAIN|elapsed=("?\$min"?|"?\$\{min)' "$1"; }
accept "run-rollout.sh has NO env-based drain-wait shortcut" no_wait_backdoor "$RR"
grep -q 'while :; do now_epoch="\$(date -u +%s)"' "$RR" && pass "the wait advances only via the real clock (date/sleep)" || fail "wait loop not found"
{ cat "$RR"; printf '%s\n' '  [[ "${ROLLOUT_TEST_FAST_DRAIN:-}" == 1 ]] && elapsed="$min"'; } > "$TMP/mutant-drain.sh"
reject "MUTANT re-introducing a fast-drain env flag is caught" no_wait_backdoor "$TMP/mutant-drain.sh"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
