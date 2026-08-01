#!/usr/bin/env bash
# ===========================================================================
# step6-verifier-test.sh — executable fixtures for logfetch/verify-step6-send.sh.
#
# The step-6 contract used to live in the README as grep counts next to comments
# ("must be exactly 1"). Nothing enforced them, so a mis-read or an empty result
# looked exactly like a pass. These fixtures prove the verifier ENFORCES each
# cardinality, and the MUTANTS prove each check is load-bearing: a verifier
# weakened to >=1, to ignore duplicates, to ignore a forbidden event, or to
# match on the time window instead of the ids must FAIL these fixtures.
#
# Run: bash scripts/rollout/notif-10ca3/verify/step6-verifier-test.sh
# ===========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VS="$HERE/../logfetch/verify-step6-send.sh"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"; rm -f "$HERE/../logfetch/.mutant-"*.sh' EXIT

P=0; F=0
pass(){ P=$((P+1)); echo "  PASS  $*"; }
fail(){ F=$((F+1)); echo "  FAIL  $*"; }

TARGET_INV=aaaaaaaa-1111-1111-1111-111111111111   # our invocation
TARGET_IC=bbbbbbbb-2222-2222-2222-222222222222    # our invoice
OTHER_INV=cccccccc-3333-3333-3333-333333333333    # somebody else's concurrent send
OTHER_IC=dddddddd-4444-4444-4444-444444444444

started(){ printf '%s\t[SEND-INVOICE-EMAIL] event:provider_send_started {"invocationId":"%s","invoiceId":"%s"}\n' "$1" "$2" "$3"; }
finished(){ printf '%s\t[SEND-INVOICE-EMAIL] event:finished {"invocationId":"%s","invoiceId":"%s","outcome":"%s"}\n' "$1" "$2" "$3" "$4"; }
finished_noic(){ printf '%s\t[SEND-INVOICE-EMAIL] event:finished {"invocationId":"%s","outcome":"%s"}\n' "$1" "$2" "$3"; }
blocked(){ printf '%s\t[SEND-INVOICE-EMAIL] event:blocked {"invocationId":"%s"}\n' "$1" "$2"; }
recfail(){ printf '%s\t[SEND-INVOICE-EMAIL] record_failed {"invoiceId":"%s","eventType":"sent","error":"boom"}\n' "$1" "$2"; }
statfail(){ printf '%s\t[SEND-INVOICE-EMAIL] status_update_failed {"invoiceId":"%s","invoiceNumber":"2026-1","error":"boom"}\n' "$1" "$2"; }
# realistic surrounding traffic that must NOT influence the verdict
noise(){
  printf '%s\t[SEND-INVOICE-EMAIL] started {"invoiceId":"%s","previewOnly":false,"testSend":false}\n' 1000000 "$OTHER_IC"
  started  1000003 "$OTHER_INV" "$OTHER_IC"
  finished 1000004 "$OTHER_INV" "$OTHER_IC" sent
  printf '%s\t[SEND-INVOICE-EMAIL] pdf_attached {"invoiceId":"%s","bytes":1234}\n' 1000005 "$OTHER_IC"
}

mk(){ local f="$ROOT/$1.txt"; shift; : > "$f"; "$@" > "$f"; printf '%s' "$f"; }
run(){ ( bash "$VS" --invoice "$2" --from-file "$1" ) >/dev/null 2>&1; }   # $1 file $2 invoice
runv(){ local v="$1" f="$2" ic="$3"; ( bash "$v" --invoice "$ic" --from-file "$f" ) >/dev/null 2>&1; }

echo "== the clean target send passes amid unrelated concurrent sends =="
clean(){ noise; started 1000001 "$TARGET_INV" "$TARGET_IC"; finished 1000002 "$TARGET_INV" "$TARGET_IC" sent; }
CLEAN="$(mk clean clean)"
run "$CLEAN" "$TARGET_IC"; rc=$?
[[ "$rc" -eq 0 ]] && pass "clean send + concurrent unrelated traffic -> exit 0" || fail "clean fixture rejected (exit=$rc)"
# and the verdict is really about OUR invoice, not "something succeeded in the window"
run "$CLEAN" "$OTHER_IC"; rc=$?
[[ "$rc" -eq 0 ]] && pass "the other party's own send verifies independently" || fail "other invoice rejected (exit=$rc)"

echo "== starts: missing / duplicated =="
nostart(){ noise; finished 1000002 "$TARGET_INV" "$TARGET_IC" sent; }
run "$(mk nostart nostart)" "$TARGET_IC"; rc=$?
[[ "$rc" -ne 0 ]] && pass "NO provider_send_started for the invoice -> nonzero ($rc)" || fail "accepted a send with no start"
dupstart(){ noise; started 1000001 "$TARGET_INV" "$TARGET_IC"; started 1000006 "$TARGET_INV" "$TARGET_IC"; finished 1000002 "$TARGET_INV" "$TARGET_IC" sent; }
run "$(mk dupstart dupstart)" "$TARGET_IC"; rc=$?
[[ "$rc" -ne 0 ]] && pass "DUPLICATE provider_send_started -> nonzero ($rc)" || fail "accepted duplicate starts"
# two DIFFERENT invocations claiming the same invoice must not be resolvable
twoinv(){ noise; started 1000001 "$TARGET_INV" "$TARGET_IC"; started 1000006 "$OTHER_INV" "$TARGET_IC"; finished 1000002 "$TARGET_INV" "$TARGET_IC" sent; }
run "$(mk twoinv twoinv)" "$TARGET_IC"; rc=$?
[[ "$rc" -ne 0 ]] && pass "TWO invocations for one invoice -> nonzero (ambiguous binding)" || fail "bound an ambiguous invocation"

echo "== finishes: missing / duplicated / belonging to another invocation =="
nofin(){ noise; started 1000001 "$TARGET_INV" "$TARGET_IC"; }
run "$(mk nofin nofin)" "$TARGET_IC"; rc=$?
[[ "$rc" -ne 0 ]] && pass "NO finished for the invocation -> nonzero ($rc)" || fail "accepted an unfinished send"
dupfin(){ noise; started 1000001 "$TARGET_INV" "$TARGET_IC"; finished 1000002 "$TARGET_INV" "$TARGET_IC" sent; finished 1000007 "$TARGET_INV" "$TARGET_IC" sent; }
run "$(mk dupfin dupfin)" "$TARGET_IC"; rc=$?
[[ "$rc" -ne 0 ]] && pass "DUPLICATE finished{sent} -> nonzero ($rc)" || fail "accepted duplicate finishes"
# the ONLY finished/sent in the window belongs to a DIFFERENT invocation
foreignfin(){ noise; started 1000001 "$TARGET_INV" "$TARGET_IC"; finished 1000002 "$OTHER_INV" "$TARGET_IC" sent; }
run "$(mk foreignfin foreignfin)" "$TARGET_IC"; rc=$?
[[ "$rc" -ne 0 ]] && pass "a finish from ANOTHER invocation does not satisfy the target -> nonzero" || fail "accepted a foreign finish"
# minimal variant: EXACTLY ONE sent finish exists in the whole window and it is
# not ours. A window-matching verifier would call this a pass; ours must not.
foreignfin_min(){ started 1000001 "$TARGET_INV" "$TARGET_IC"; finished 1000002 "$OTHER_INV" "$TARGET_IC" sent; }
run "$(mk foreignfin_min foreignfin_min)" "$TARGET_IC"; rc=$?
[[ "$rc" -ne 0 ]] && pass "the window's ONLY sent finish, owned by another invocation -> nonzero" || fail "accepted the window's foreign finish"

echo "== forbidden events =="
sendfailed(){ noise; started 1000001 "$TARGET_INV" "$TARGET_IC"; finished 1000002 "$TARGET_INV" "$TARGET_IC" send_failed; }
run "$(mk sendfailed sendfailed)" "$TARGET_IC"; rc=$?
[[ "$rc" -ne 0 ]] && pass "finished{send_failed} -> nonzero ($rc)" || fail "accepted send_failed"
errored(){ noise; started 1000001 "$TARGET_INV" "$TARGET_IC"; finished_noic 1000002 "$TARGET_INV" error; }
run "$(mk errored errored)" "$TARGET_IC"; rc=$?
[[ "$rc" -ne 0 ]] && pass "finished{error} (no invoiceId, as the handler emits) -> nonzero" || fail "accepted an error outcome"
blockedf(){ noise; blocked 1000000 "$TARGET_INV"; started 1000001 "$TARGET_INV" "$TARGET_IC"; finished 1000002 "$TARGET_INV" "$TARGET_IC" sent; }
run "$(mk blockedf blockedf)" "$TARGET_IC"; rc=$?
[[ "$rc" -ne 0 ]] && pass "event:blocked for the invocation -> nonzero (gate was ON)" || fail "accepted a blocked invocation"
recf(){ noise; started 1000001 "$TARGET_INV" "$TARGET_IC"; finished 1000002 "$TARGET_INV" "$TARGET_IC" sent; recfail 1000003 "$TARGET_IC"; }
run "$(mk recf recf)" "$TARGET_IC"; rc=$?
[[ "$rc" -ne 0 ]] && pass "record_failed for the invoice -> nonzero (sent but untracked)" || fail "accepted record_failed"
statf(){ noise; started 1000001 "$TARGET_INV" "$TARGET_IC"; finished 1000002 "$TARGET_INV" "$TARGET_IC" sent; statfail 1000003 "$TARGET_IC"; }
run "$(mk statf statf)" "$TARGET_IC"; rc=$?
[[ "$rc" -ne 0 ]] && pass "status_update_failed for the invoice -> nonzero (UI/DB disagree)" || fail "accepted status_update_failed"
# ...but the SAME failures against somebody else's invoice must not taint ours
foreignfailures(){ noise; recfail 1000008 "$OTHER_IC"; statfail 1000009 "$OTHER_IC"
  started 1000001 "$TARGET_INV" "$TARGET_IC"; finished 1000002 "$TARGET_INV" "$TARGET_IC" sent; }
run "$(mk foreignfailures foreignfailures)" "$TARGET_IC"; rc=$?
[[ "$rc" -eq 0 ]] && pass "another invoice's record/status failures do NOT fail ours (exact invoice binding)" || fail "cross-contaminated by another invoice (exit=$rc)"

echo "== fail closed on malformed input =="
: > "$ROOT/empty.txt"
run "$ROOT/empty.txt" "$TARGET_IC"; rc=$?
[[ "$rc" -ne 0 ]] && pass "EMPTY log file -> nonzero ($rc), never a vacuous pass" || fail "empty file passed"
printf 'not-a-log-line\n' > "$ROOT/noepoch.txt"
run "$ROOT/noepoch.txt" "$TARGET_IC"; rc=$?
[[ "$rc" -eq 2 ]] && pass "line without epoch<TAB> -> fail closed (exit 2)" || fail "malformed line not fail-closed (exit=$rc)"
printf '1000001\t[SEND-INVOICE-EMAIL] event:finished {not json}\n' > "$ROOT/badjson.txt"
run "$ROOT/badjson.txt" "$TARGET_IC"; rc=$?
[[ "$rc" -eq 2 ]] && pass "non-JSON payload -> fail closed (exit 2)" || fail "bad JSON not fail-closed (exit=$rc)"
printf '1000001\t[SEND-INVOICE-EMAIL] event:provider_send_started {"invocationId":"nope","invoiceId":"%s"}\n' "$TARGET_IC" > "$ROOT/baduuid.txt"
run "$ROOT/baduuid.txt" "$TARGET_IC"; rc=$?
[[ "$rc" -eq 2 ]] && pass "malformed invocationId -> fail closed (exit 2)" || fail "bad uuid not fail-closed (exit=$rc)"
printf '1000001\t[SEND-INVOICE-EMAIL] event:finished {"invoiceId":"%s","outcome":"sent"}\n' "$TARGET_IC" > "$ROOT/noinv.txt"
run "$ROOT/noinv.txt" "$TARGET_IC"; rc=$?
[[ "$rc" -eq 2 ]] && pass "lifecycle event without invocationId -> fail closed (exit 2)" || fail "missing id not fail-closed (exit=$rc)"
printf '1000001\t[SEND-INVOICE-EMAIL] record_failed {"eventType":"sent"}\n' > "$ROOT/recnoic.txt"
run "$ROOT/recnoic.txt" "$TARGET_IC"; rc=$?
[[ "$rc" -eq 2 ]] && pass "record_failed without invoiceId -> fail closed (cannot prove it is unrelated)" || fail "uncorrelatable failure ignored (exit=$rc)"
printf '1000001\t[OTHER-FUNCTION] event:finished {"invocationId":"%s","outcome":"sent"}\n' "$TARGET_INV" > "$ROOT/prefix.txt"
run "$ROOT/prefix.txt" "$TARGET_IC"; rc=$?
[[ "$rc" -eq 2 ]] && pass "foreign log prefix -> fail closed (input did not come from the documented fetch)" || fail "foreign prefix accepted (exit=$rc)"
( bash "$VS" --invoice not-a-uuid --from-file "$CLEAN" ) >/dev/null 2>&1
[[ $? -eq 1 ]] && pass "non-uuid --invoice -> usage error (exit 1)" || fail "accepted a non-uuid invoice arg"
( bash "$VS" --invoice "$TARGET_IC" --from-file "$ROOT/does-not-exist.txt" ) >/dev/null 2>&1
[[ $? -eq 1 ]] && pass "missing log file -> setup error (exit 1)" || fail "accepted a missing log file"

echo "== a malformed record MID-WINDOW cannot be silently skipped =="
# `jq -R` reports a per-input error() on stderr and then CONTINUES to the next
# input, exiting 0. So before the parse-completeness guard, a bad record in the
# MIDDLE of a window was dropped and the verification proceeded on the survivors
# — the documented fail-closed property only held when the bad line was the sole
# input. The verifier now requires one parsed record per input line.
midbad(){ noise; started 1000001 "$TARGET_INV" "$TARGET_IC"
  printf '1000002\tthis-record-has-no-tab-separator\n'
  finished 1000003 "$TARGET_INV" "$TARGET_IC" sent; }
MIDBAD="$(mk midbad midbad)"
run "$MIDBAD" "$TARGET_IC"; rc=$?
[[ "$rc" -eq 2 ]] && pass "a malformed record mid-window -> fail closed (exit 2), not skipped" || fail "mid-window malformed record was skipped (exit=$rc)"
blankmid(){ noise; started 1000001 "$TARGET_INV" "$TARGET_IC"; printf '\n'
  finished 1000003 "$TARGET_INV" "$TARGET_IC" sent; }
run "$(mk blankmid blankmid)" "$TARGET_IC"; rc=$?
[[ "$rc" -eq 2 ]] && pass "a BLANK line mid-window -> fail closed (exit 2)" || fail "blank line was skipped (exit=$rc)"
# MUTANT = the PRE-FIX state: trust jq's exit status alone. Both added checks are
# neutralised together, because they form one guard — the stderr test alone also
# catches a dropped record, so neither is independently killable, and claiming
# otherwise would be a mutation pin that proves less than it says.
MPC="$HERE/../logfetch/.mutant-nocount.sh"
python3 - "$VS" "$MPC" <<'PYX'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
a = 'if [[ -s "$TSV.err" ]]; then fail_closed'
b = '[[ "$in_n" -eq "$out_n" ]] \\'
assert s.count(a) == 1 and s.count(b) == 1, "guard anchors not unique"
s = s.replace(a, 'if false; then fail_closed', 1).replace(b, '[[ 1 -eq 1 ]] \\', 1)
open(dst, "w").write(s)
PYX
grep -q 'if false; then fail_closed' "$MPC" && grep -q '\[\[ 1 -eq 1 \]\]' "$MPC" \
  && pass "mutant built: back to trusting jq's exit status alone (the pre-fix state)" || fail "mutant not applied"
( bash "$MPC" --invoice "$TARGET_IC" --from-file "$MIDBAD" ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (jq exit status alone) verifies a window with a SKIPPED record — the parse-completeness guard is load-bearing" \
               || fail "mutant not distinguishable"
rm -f "$MPC"

echo "== output carries no PII =="
OUT="$( bash "$VS" --invoice "$TARGET_IC" --from-file "$CLEAN" 2>&1 )"
grep -qiE '@|password|bearer|authorization|"email"' <<<"$OUT" \
  && fail "verifier output contains something address/token-shaped" \
  || pass "verifier output is counts + uuids only (no address/token shapes)"
grep -q "$TARGET_INV" <<<"$OUT" && pass "the bound invocation id is reported as evidence" || fail "no invocation id in the summary"

echo "== MUTANTS: every cardinality + the id binding are load-bearing =="
# Mutants MUST live in the bundle dir: the script derives HERE from its own path
# and sources ../lib/common.sh relatively, so a /tmp copy dies while sourcing and
# yields a false "the mutant also fails" result.
# NB: separate declarations — `local a="$1" b="...$a..."` self-references on one
# line and dies under `set -u` (bash evaluates the initialisers left to right but
# $a is not yet in scope for the same `local`).
mutant(){ local name="$1"; local sedexpr="$2"; local m="$HERE/../logfetch/.mutant-$name.sh"
  sed "$sedexpr" "$VS" > "$m"; printf '%s' "$m"; }
# (a) >=1 instead of ==1 for the sent finish -> duplicate finishes wrongly accepted
M="$(mutant ge1 's|\[\[ "$n" -eq 1 \]\] \&\& good "finished{outcome=sent}|[[ "$n" -ge 1 ]] \&\& good "finished{outcome=sent}|')"
grep -q '"$n" -ge 1' "$M" && pass "mutant (a) built: finished{sent} accepts >=1" || fail "mutant (a) sed did not apply"
runv "$M" "$ROOT/dupfin.txt" "$TARGET_IC" && pass "MUTANT (>=1 finishes) ACCEPTS duplicates — the ==1 check is load-bearing" \
                                          || fail "mutant (a) still rejected"
# (b) ignore duplicate STARTS
M="$(mutant dupstart 's|\[\[ "$starts_for_invoice" -ne 1 \]\]|[[ "$starts_for_invoice" -lt 1 ]]|; s|\[\[ "$n" -eq 1 \]\] \&\& good "provider_send_started|[[ "$n" -ge 1 ]] \&\& good "provider_send_started|')"
grep -q '"$starts_for_invoice" -lt 1' "$M" && grep -q '"$n" -ge 1 ]] && good "provider_send_started' "$M" \
  && pass "mutant (b) built: BOTH start cardinalities relaxed to >=1" || fail "mutant (b) sed did not apply"
runv "$M" "$ROOT/dupstart.txt" "$TARGET_IC" && pass "MUTANT (>=1 starts) ACCEPTS duplicate starts — the ==1 check is load-bearing" \
                                            || fail "mutant (b) still rejected"
# (c) ignore a forbidden event (record_failed)
M="$(mutant norecfail 's|n="$(cnt record_failed "" "$INVOICE")"|n=0|')"
grep -q '^n=0$' "$M" && pass "mutant (c) built: record_failed check neutralised" || fail "mutant (c) sed did not apply"
runv "$M" "$ROOT/recf.txt" "$TARGET_IC" && pass "MUTANT (ignores record_failed) ACCEPTS an untracked send — the check is load-bearing" \
                                        || fail "mutant (c) still rejected"
# (d) ignore blocked
M="$(mutant noblocked 's|n="$(cnt event:blocked "$INVOCATION")"|n=0|')"
grep -q '^n=0$' "$M" && pass "mutant (d) built: blocked check neutralised" || fail "mutant (d) sed did not apply"
runv "$M" "$ROOT/blockedf.txt" "$TARGET_IC" && pass "MUTANT (ignores blocked) ACCEPTS a gated invocation — the check is load-bearing" \
                                            || fail "mutant (d) still rejected"
# (e) TIME-WINDOW matching instead of id binding: drop the invocation filter from
#     every count, i.e. "was there a sent finish anywhere in the window".
M="$(mutant window 's|cnt event:finished "$INVOCATION"|cnt event:finished ""|g')"
grep -q 'cnt event:finished ""' "$M" && ! grep -q 'cnt event:finished "$INVOCATION"' "$M" \
  && pass "mutant (e) built: every finished count matched by window, not by id" || fail "mutant (e) sed did not apply"
runv "$M" "$ROOT/foreignfin_min.txt" "$TARGET_IC" && pass "MUTANT (window-only) ACCEPTS another invocation's finish — exact id binding is load-bearing" \
                                                  || fail "mutant (e) still rejected"
# ...and the real verifier must still pass the clean fixture (not merely strict)
run "$CLEAN" "$TARGET_IC" && pass "the REAL verifier still passes the clean fixture (not vacuously strict)" \
                          || fail "real verifier rejects the clean fixture"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
