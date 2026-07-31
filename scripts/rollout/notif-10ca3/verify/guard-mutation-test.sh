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

echo "== guard 3: authoritative drain proof (bypass / straggler) =="
ID=11111111-1111-1111-1111-111111111111
printf '%s\n' "t\t[SEND-INVOICE-EMAIL] event:blocked {\"invocationId\":\"aaaaaaaa-1111-1111-1111-111111111111\"}" > "$TMP/clean.txt"
printf '%s\n' "t\t[SEND-INVOICE-EMAIL] event:provider_send_started {\"invocationId\":\"$ID\"}" > "$TMP/bypass.txt"
printf '%s\n' "t\t[SEND-INVOICE-EMAIL] event:provider_send_started {\"invocationId\":\"$ID\"}" > "$TMP/straggler.txt"
{ printf '%s\n' "t\t[SEND-INVOICE-EMAIL] event:provider_send_started {\"invocationId\":\"$ID\"}";
  printf '%s\n' "t\t[SEND-INVOICE-EMAIL] event:finished {\"invocationId\":\"$ID\"}"; } > "$TMP/drained.txt"
accept "clean window (no send past the gate) passes" bash "$FEL" --from-file "$TMP/clean.txt"
reject "real drain rejects a gate BYPASS" bash "$FEL" --from-file "$TMP/bypass.txt"
accept "MUTANT --allow-sends wrongly accepts a bypass (guard load-bearing)" bash "$FEL" --from-file "$TMP/bypass.txt" --allow-sends
reject "real drain (--assert-all-finished) rejects a straggler" bash "$FEL" --from-file "$TMP/straggler.txt" --allow-sends --assert-all-finished
accept "MUTANT without --assert-all-finished wrongly accepts a straggler (guard load-bearing)" bash "$FEL" --from-file "$TMP/straggler.txt" --allow-sends
accept "fully-drained window passes both checks" bash "$FEL" --from-file "$TMP/drained.txt" --allow-sends --assert-all-finished
reject "assert_drain_proven rejects elapsed < min" assert_drain_proven 30 520 0
reject "assert_drain_proven rejects sends > 0" assert_drain_proven 600 520 1
accept "assert_drain_proven accepts elapsed>=min & 0 sends" assert_drain_proven 600 520 0

echo "== guard 3b: FAIL-CLOSED log validation (empty/missing/truncated/delayed/record_failed) =="
printf '%s' '{"result":[],"error":null}'   > "$TMP/empty.json"
printf '%s' '{"error":null}'               > "$TMP/missing.json"
jq -n '{result:[range(1000)|{timestamp:"t",event_message:"[SEND-INVOICE-EMAIL] event:blocked {}"}],error:null}' > "$TMP/trunc.json"
printf '%s' '{"result":[{"timestamp":"t","event_message":"[SEND-INVOICE-EMAIL] event:blocked {\"invocationId\":\"aaaaaaaa-1111-1111-1111-111111111111\"}"}],"error":null}' > "$TMP/valid.json"
{ printf '%s\n' "t\t[SEND-INVOICE-EMAIL] event:provider_send_started {\"invocationId\":\"$ID\"}";
  printf '%s\n' "t\t[SEND-INVOICE-EMAIL] event:finished {\"invocationId\":\"$ID\"}"; } > "$TMP/delayed.txt"   # no blocked
{ printf '%s\n' "t\t[SEND-INVOICE-EMAIL] event:blocked {}";
  printf '%s\n' "t\t[SEND-INVOICE-EMAIL] record_failed {\"eventType\":\"sent\"}"; } > "$TMP/recfail.txt"
reject "empty .result fails drain (require-blocked)"        bash "$FEL" --from-response "$TMP/empty.json" --require-blocked
reject "missing .result fails closed"                       bash "$FEL" --from-response "$TMP/missing.json"
reject "truncated page (== LIMIT) fails closed"             bash "$FEL" --from-response "$TMP/trunc.json"
reject "delayed canary (no event:blocked) fails require-blocked" bash "$FEL" --from-file "$TMP/delayed.txt" --require-blocked
reject "record_failed fails when --fail-on-record-failed"   bash "$FEL" --from-file "$TMP/recfail.txt" --allow-sends --fail-on-record-failed
accept "MUTANT without --fail-on-record-failed ignores record_failed (guard load-bearing)" bash "$FEL" --from-file "$TMP/recfail.txt" --allow-sends
accept "valid response with event:blocked passes"          bash "$FEL" --from-response "$TMP/valid.json" --require-blocked

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

echo "== guard 8: baseline key validation =="
good="$TMP/good.txt"; printf 'eas_rows=5\nede_rows=3\neas_bad_state_rows=1\nreader_academy_md5=%s\nreader_overview_md5=absent\n' "$(printf 'a%.0s' $(seq 32))" > "$good"
accept "validate_baseline_keys accepts a well-formed snapshot" validate_baseline_keys "$good" ok
grep -v '^ede_rows=' "$good" > "$TMP/missing_key.txt"
reject "validate_baseline_keys rejects a missing key" validate_baseline_keys "$TMP/missing_key.txt" missing
{ cat "$good"; echo 'ede_rows=99'; } > "$TMP/dup_key.txt"
reject "validate_baseline_keys rejects a duplicated key" validate_baseline_keys "$TMP/dup_key.txt" dup
sed 's/^eas_rows=5/eas_rows=oops/' "$good" > "$TMP/badval.txt"
reject "validate_baseline_keys rejects a non-numeric count" validate_baseline_keys "$TMP/badval.txt" badval

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
