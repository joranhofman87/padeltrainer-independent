#!/usr/bin/env bash
# ===========================================================================
# guard-mutation-test.sh — proves the rollout's CRITICAL guards are load-bearing:
# for each guard, the REAL implementation rejects the unsafe input, and a
# MUTATED (weakened) version wrongly accepts it. If a guard were removed the
# mutant's behaviour is what you'd get — the test makes that unsafety explicit.
# Also exercises the drain guard end-to-end via fetch-edge-logs fixtures.
# Run: bash scripts/rollout/notif-10ca3/verify/guard-mutation-test.sh
# ===========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../lib/common.sh"
FEL="$HERE/../logfetch/fetch-edge-logs.sh"
V1=20261006100000; V2=20261006110000; V3=20261006120000
EXPECTED_VERSIONS="$(printf '%s\n%s\n%s\n' "$V1" "$V2" "$V3")"

P=0; F=0
pass(){ P=$((P+1)); echo "  PASS  $*"; }
fail(){ F=$((F+1)); echo "  FAIL  $*"; }
# run a command in a subshell; die()/nonzero => "rejected", zero => "accepted"
reject(){ local d="$1"; shift; if ( "$@" ) >/dev/null 2>&1; then fail "$d — ACCEPTED (should reject)"; else pass "$d"; fi; }
accept(){ local d="$1"; shift; if ( "$@" ) >/dev/null 2>&1; then pass "$d"; else fail "$d — REJECTED (should accept)"; fi; }

REF=abcdefghijklmnopqrst
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "== guard 1: EXACT identity allow-list =="
ATTACK="db.${REF}.supabase.co.evil.com"
reject "real assert_host_user_is_ref rejects look-alike host" assert_host_user_is_ref "$REF" "$ATTACK" postgres
# MUTANT: substring match (the classic weak check) — wrongly accepts the attack
mutant_identity(){ [[ "$2" == *"$1"* ]]; }
accept "MUTANT substring-identity wrongly accepts the look-alike (guard is load-bearing)" mutant_identity "$REF" "$ATTACK"
reject "real assert_conn_url_is_ref rejects spoofed-host URL" \
  assert_conn_url_is_ref "$REF" "postgresql://postgres:pw@db.${REF}.supabase.co.evil.com/postgres"

echo "== guard 2: EXACT pending-migration set =="
SUPERSET="$(printf '%s\n%s\n%s\n%s\n' "$V1" "$V2" "$V3" 20261006130000)"
MISSING="$(printf '%s\n%s\n' "$V1" "$V2")"
reject "real pending-guard rejects an extra 4th migration" assert_pending_is_expected "$SUPERSET" "$EXPECTED_VERSIONS"
reject "real pending-guard rejects a missing migration"    assert_pending_is_expected "$MISSING"  "$EXPECTED_VERSIONS"
# MUTANT: subset check (all expected present) — wrongly accepts the superset
mutant_pending(){ local v; while read -r v; do [[ -z "$v" ]] && continue; printf '%s\n' "$1" | grep -qx "$v" || return 1; done <<< "$2"; }
accept "MUTANT subset-pending wrongly accepts an extra migration (guard is load-bearing)" mutant_pending "$SUPERSET" "$EXPECTED_VERSIONS"

echo "== guard 3: authoritative drain proof =="
ID=11111111-1111-1111-1111-111111111111
printf '%s\n' '[SEND-INVOICE-EMAIL] event:blocked {"invocationId":"aaaaaaaa-1111-1111-1111-111111111111"}' > "$TMP/clean.txt"
printf '%s\n' "[SEND-INVOICE-EMAIL] event:provider_send_started {\"invocationId\":\"$ID\",\"invoiceId\":\"x\"}" > "$TMP/bypass.txt"
printf '%s\n' "[SEND-INVOICE-EMAIL] event:provider_send_started {\"invocationId\":\"$ID\",\"invoiceId\":\"x\"}" > "$TMP/straggler.txt"
{ printf '%s\n' "[SEND-INVOICE-EMAIL] event:provider_send_started {\"invocationId\":\"$ID\"}";
  printf '%s\n' "[SEND-INVOICE-EMAIL] event:finished {\"invocationId\":\"$ID\",\"outcome\":\"sent\"}"; } > "$TMP/drained.txt"

accept "clean window (no send past the gate) passes"            bash "$FEL" --from-file "$TMP/clean.txt"
reject "real drain rejects a gate BYPASS (provider_send_started)" bash "$FEL" --from-file "$TMP/bypass.txt"
# MUTANT: --allow-sends removes the zero-send guard -> wrongly accepts the bypass
accept "MUTANT --allow-sends wrongly accepts a gate bypass (guard is load-bearing)" bash "$FEL" --from-file "$TMP/bypass.txt" --allow-sends
reject "real drain (--assert-all-finished) rejects an in-flight straggler" bash "$FEL" --from-file "$TMP/straggler.txt" --allow-sends --assert-all-finished
# MUTANT: dropping --assert-all-finished -> wrongly accepts the straggler
accept "MUTANT without --assert-all-finished wrongly accepts a straggler (guard is load-bearing)" bash "$FEL" --from-file "$TMP/straggler.txt" --allow-sends
accept "fully-drained window (started+finished) passes both checks" bash "$FEL" --from-file "$TMP/drained.txt" --allow-sends --assert-all-finished

# assert_drain_proven direct
reject "assert_drain_proven rejects elapsed < min"    assert_drain_proven 30 120 0
reject "assert_drain_proven rejects sends > 0"        assert_drain_proven 300 120 1
accept "assert_drain_proven accepts elapsed>=min & 0 sends" assert_drain_proven 300 120 0

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
