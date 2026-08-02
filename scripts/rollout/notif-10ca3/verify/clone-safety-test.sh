#!/usr/bin/env bash
# ===========================================================================
# clone-safety-test.sh — the withdrawn path must be unreachable, and the
# supported rehearsal path must be fail-closed. (ADR-001)
#
# The previous design restored production and fenced it with statement triggers
# on cron.job and net.http_request_queue. Supabase advises against triggers on
# that queue, and DROP TRIGGER needs OWNERSHIP of these extension-managed tables,
# so the fence could be installed and never removed — production inventory
# returned FENCEABLE no. The fence is withdrawn.
#
# What is tested here:
#   1. clone-source-quiesce refuses BEFORE psql, a connection, or any change
#   2. recovery (resume/abandon) still works, only with explicit window evidence
#   3. the supported target must be empty, inert, identity-checked and synthetic
#   4. a rehearsal cannot start from a drifted or failed-migration baseline
#
# No network, no production: psql/supabase/node are stubbed and state is synthetic.
# Run: bash scripts/rollout/notif-10ca3/verify/clone-safety-test.sh
# ===========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RR="$HERE/../run-rollout.sh"; SQLD="$HERE/../sql"; export SQLD
ROOT="$(mktemp -d)"
trap 'chmod -R u+w "$ROOT" 2>/dev/null; rm -rf "$ROOT"; rm -f "$HERE/../.mutant-"*.sh' EXIT
P=0; F=0
pass(){ P=$((P+1)); echo "  PASS  $*"; }
fail(){ F=$((F+1)); echo "  FAIL  $*"; }

REF=ficwbdrzefmblkbkomzw; export REF
CLONE=zzzzzzzzzzzzzzzzzzzz
PROD_URL="postgresql://postgres@db.${REF}.supabase.co:5432/postgres"
CLONE_URL="postgresql://postgres@db.${CLONE}.supabase.co:5432/postgres"
BIN="$ROOT/bin"; mkdir -p "$BIN"; export STATEDIR="$ROOT/state"; mkdir -p "$STATEDIR"
EVID="$ROOT/evidence"; mkdir -p "$EVID"; export EVIDDIR="$EVID"

cat > "$BIN/psql" <<'EOF'
#!/usr/bin/env bash
: > "$STATEDIR/PSQL_WAS_CALLED"
f=""; prev=""; for a in "$@"; do [[ "$prev" == "-f" ]] && f="$a"; prev="$a"; done
S="$STATEDIR"; sfile(){ cat "$S/$1" 2>/dev/null || echo "$2"; }
has(){ grep -q -- "$1" "$f" 2>/dev/null; }
boom(){ echo "ERROR:  $1" >&2; exit 3; }
if [[ "$f" == *empty_project_check.sql ]]; then
  for k in E_CRON E_NETQ E_VAULT E_HOOK E_OUTTRIG E_FDW E_AUTH; do
    [[ "$(sfile $k 0)" == 0 ]] || boom "target is not pristine ($k)"
  done
  echo "NOTE: empty-project check ok"; exit 0
fi
if [[ "$f" == *rehearsal_inert_check.sql ]]; then
  for k in I_ACTIVE I_NETQ I_VAULT I_HOOK I_OUTTRIG I_FDW I_AUTH; do
    [[ "$(sfile $k 0)" == 0 ]] || boom "rehearsal target not inert ($k)"
  done
  echo "NOTE: rehearsal target inert"; exit 0
fi
if [[ "$f" == *clone_deactivate_schedules.sql ]]; then
  [[ "$(sfile DEACT_FAIL 0)" == 0 ]] || boom "could not deactivate schedules"
  echo 0 > "$S/I_ACTIVE"; echo "NOTE: schedules off"; exit 0
fi
if [[ "$f" == *baseline_fingerprint.sql ]]; then
  [[ "$(sfile FP_FAIL 0)" == 0 ]] && { printf 'SHAPE %s\nROWS email_address_state %s\nSYNTHETIC %s\n' \
      "$(sfile SHAPE shape0)" "$(sfile NROWS 1000)" "$(sfile SYNTH ok)"; exit 0; }
  echo "ERROR: fingerprint failed" >&2; exit 3
fi
if [[ "$f" == *clone_source_resume.sql ]]; then
  [[ "$(sfile RESUME_FAIL 0)" == 0 ]] || boom "resume refused (injected)"
  rm -f "$S/WINDOW"; echo "NOTE: resumed"; exit 0
fi
exit 0
EOF
cat > "$BIN/supabase" <<'EOF'
#!/usr/bin/env bash
: > "$STATEDIR/SUPABASE_WAS_CALLED"
[[ "$(cat "$STATEDIR/PUSH_FAIL" 2>/dev/null || echo 0)" == 1 ]] && { echo "push failed" >&2; exit 1; }
exit 0
EOF
cat > "$BIN/node" <<'EOF'
#!/usr/bin/env bash
# the real node is needed for the scale-file read; only the synth loader is stubbed
if [[ "$*" == *build-baseline.mjs* ]]; then
  : > "$STATEDIR/SYNTH_WAS_CALLED"
  [[ "$(cat "$STATEDIR/SYNTH_FAIL" 2>/dev/null || echo 0)" == 1 ]] && { echo "synth failed" >&2; exit 1; }
  echo "SYNTH email_address_state=1000 email_delivery_events=5000 all_addresses_synthetic=yes"; exit 0
fi
exec /usr/bin/env -i PATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" node "$@"
EOF
chmod +x "$BIN/psql" "$BIN/supabase" "$BIN/node"

SCALE="$HERE/../clone-safety/rehearsal-scale.json"
seed(){ rm -rf "$STATEDIR"; mkdir -p "$STATEDIR"; chmod u+w "$EVID" 2>/dev/null; rm -rf "$EVID"/*; }
run(){ ( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" "$@" ) >"$ROOT/out.txt" 2>&1; }
crun(){ ( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$CLONE" "$@" ) >"$ROOT/out.txt" 2>&1; }
measured(){ python3 - "$SCALE" "$1" <<'PY'
import json,sys
p,mode=sys.argv[1],sys.argv[2]
d=json.load(open(p))
if mode=='yes':
    d['source']='measured'; d['measured_at']='2026-08-02'
    d['tables']['email_address_state'].update(rows=1000, avg_email_len=32)
    d['tables']['email_address_state']['state_distribution']={'ok':900,'soft_bounced':50,'hard_bounced':30,'complained':20}
    d['tables']['email_delivery_events'].update(rows=5000, avg_reason_len=24)
    d['tables']['email_delivery_events']['event_type_distribution']={'sent':3000,'delivered':1500,'bounced':300,'complained':100,'delivery_delayed':50,'failed':30,'send_failed':20}
else:
    d['source']='placeholder'; d['measured_at']=None
    d['tables']['email_address_state'].update(rows=0)
    d['tables']['email_delivery_events'].update(rows=0)
json.dump(d,open(p,'w'),indent=2)
PY
}
cp "$SCALE" "$ROOT/scale.orig.json"
restore_scale(){ cp "$ROOT/scale.orig.json" "$SCALE"; }
trap 'restore_scale; chmod -R u+w "$ROOT" 2>/dev/null; rm -rf "$ROOT"; rm -f "$HERE/../.mutant-"*.sh' EXIT

echo "== the withdrawn fence path is unreachable =="
# A working PATH with INSTRUMENTED tools: the point is not that psql is missing,
# it is that the refusal happens before the tooling would ever reach for it.
seed
run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
rc=$?
[[ "$rc" -ne 0 ]] && pass "clone-source-quiesce REFUSES (exit ${rc})" || fail "quiesce ran"
[[ ! -e "$STATEDIR/PSQL_WAS_CALLED" ]] && pass "…without ever invoking psql — the refusal precedes any connection" || fail "psql was invoked"
[[ ! -e "$STATEDIR/SUPABASE_WAS_CALLED" ]] && pass "…and without invoking the Supabase CLI" || fail "supabase was invoked"
[[ ! -s "$EVID/clone-source-nonce.txt" ]] && pass "…and wrote no window evidence" || fail "window evidence written"
grep -q 'withdrawn' "$ROOT/out.txt" && pass "…and says the command is withdrawn" || fail "no withdrawal notice"
grep -q 'FENCEABLE no' "$ROOT/out.txt" && pass "…citing the measured production result" || fail "does not cite FENCEABLE no"
grep -q 'ADR-001' "$ROOT/out.txt" && pass "…and points at the ADR" || fail "no ADR reference"
grep -q 'clone-build-baseline' "$ROOT/out.txt" && pass "…and names the supported replacement" || fail "no replacement named"
grep -q 'nothing was connected to, read or changed' "$ROOT/out.txt" && pass "…and states plainly that nothing was touched" || fail "no no-op statement"
for a in seal arm fence marker; do
  grep -qi "clone-source-$a)" "$RR" && fail "a '$a' subcommand is still dispatchable" || pass "no '$a' subcommand exists"
done

echo "== recovery survives, and only with explicit window evidence =="
seed
crun bash "$RR" clone-source-resume --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "resume refuses with NO recorded window" || fail "resume ran without a window"
seed; printf 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6\n' > "$EVID/clone-source-nonce.txt"
run bash "$RR" clone-source-resume --yes "$PROD_URL"
[[ $? -eq 0 ]] && pass "resume works for a window whose nonce is on file (recovery preserved)" || fail "recovery broken: $(tail -2 "$ROOT/out.txt")"
seed
run bash "$RR" clone-source-abandon --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "abandon refuses without --nonce" || fail "abandon ran without a nonce"
seed
run bash "$RR" clone-source-abandon --yes --nonce deadbeefdeadbeefdeadbeefdeadbeef "$PROD_URL"
[[ $? -eq 0 ]] && pass "abandon works when the operator names the nonce" || fail "abandon broken"
seed
run bash "$RR" clone-source-abandon --yes --nonce not-hex "$PROD_URL"
[[ $? -ne 0 ]] && pass "a malformed nonce is refused" || fail "malformed nonce accepted"

echo "== the rehearsal target must be a real, distinct, EMPTY project =="
seed; measured yes
crun bash "$RR" clone-verify-empty "$CLONE_URL"
[[ $? -eq 0 ]] && pass "an empty, inert, correctly-identified target is accepted" || fail "empty target rejected: $(tail -2 "$ROOT/out.txt")"
seed; measured yes
crun bash "$RR" clone-verify-empty "$PROD_URL"
[[ $? -ne 0 ]] && pass "a PRODUCTION url is refused as a rehearsal target" || fail "production accepted as a target"
seed; measured yes
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$REF" bash "$RR" clone-verify-empty "$CLONE_URL" ) >/dev/null 2>&1
[[ $? -ne 0 ]] && pass "a CLONE_REF equal to production is refused" || fail "CLONE_REF==EXPECTED_REF accepted"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="not-a-ref" bash "$RR" clone-verify-empty "$CLONE_URL" ) >/dev/null 2>&1
[[ $? -ne 0 ]] && pass "a malformed CLONE_REF is refused" || fail "malformed CLONE_REF accepted"
for k in E_CRON E_NETQ E_VAULT E_HOOK E_OUTTRIG E_FDW E_AUTH; do
  seed; measured yes; echo 1 > "$STATEDIR/$k"
  crun bash "$RR" clone-verify-empty "$CLONE_URL"
  [[ $? -ne 0 ]] && pass "a target with non-zero ${k} is refused BEFORE anything is loaded" || fail "${k} accepted"
done

echo "== the baseline is synthetic, measured, and only the affected tables =="
seed; measured no
crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"
[[ $? -ne 0 ]] && pass "an UNMEASURED scale file is refused (invented rows give an invented timing)" || fail "placeholder scale accepted"
[[ ! -e "$STATEDIR/SYNTH_WAS_CALLED" ]] && pass "…and no data was loaded" || fail "data loaded despite an unmeasured scale"
seed; measured yes
crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"; rc=$?
[[ "$rc" -eq 0 ]] && pass "a measured scale builds the baseline" || fail "baseline build failed (exit $rc): $(tail -3 "$ROOT/out.txt")"
[[ -e "$STATEDIR/SUPABASE_WAS_CALLED" ]] && pass "…schema comes from a db push (main), not from the #615 pin" || fail "no schema build"
grep -q 'from main' "$ROOT/out.txt" && pass "…and the log says so, so the migrations under test are applied separately" || fail "schema source not stated"
[[ "$(cat "$STATEDIR/I_ACTIVE" 2>/dev/null)" == 0 ]] && pass "…every schedule the migrations created was deactivated" || fail "schedules left active"
[[ -s "$EVID/rehearsal-baseline-fingerprint.txt" ]] && pass "…and a pristine baseline fingerprint was recorded" || fail "no baseline recorded"
seed; measured yes; echo VIOLATION > "$STATEDIR/SYNTH"
crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"
[[ $? -ne 0 ]] && pass "a baseline containing a NON-synthetic address is refused" || fail "non-synthetic baseline recorded"
[[ ! -s "$EVID/rehearsal-baseline-fingerprint.txt" ]] && pass "…and not recorded" || fail "non-synthetic baseline was recorded"
python3 - "$HERE/../synth/build-baseline.mjs" <<'PY'
import re,sys
s=open(sys.argv[1]).read()
tbl=set(re.findall(r'public\.([a-z_]+)', s))
print("TABLES " + ",".join(sorted(tbl)))
PY
TBL=$(python3 -c "
import re,sys
s=open('$HERE/../synth/build-baseline.mjs').read()
print(','.join(sorted(set(re.findall(r'public\.([a-z_]+)', s)))))")
[[ "$TBL" == "email_address_state,email_delivery_events" ]] \
  && pass "the generator writes ONLY the two tables #615 locks ($TBL)" || fail "generator touches other tables: $TBL"
grep -q 'example.invalid' "$HERE/../synth/build-baseline.mjs" \
  && pass "every generated address uses the reserved, undeliverable example.invalid TLD" || fail "addresses are not on a reserved TLD"
sed -e 's|//.*$||' "$HERE/../synth/build-baseline.mjs" | grep -qE 'Math\.random' \
  && fail "the generator is nondeterministic" \
  || pass "the generator is deterministic — no executable Math.random (repeatable rehearsals)"

echo "== a rehearsal cannot start from a drifted or failed-migration baseline =="
seed; measured yes; crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"
crun bash "$RR" clone-baseline-verify "$CLONE_URL"
[[ $? -eq 0 ]] && pass "an untouched target matches its recorded baseline" || fail "fresh baseline did not verify"
echo shape-CHANGED > "$STATEDIR/SHAPE"
crun bash "$RR" clone-baseline-verify "$CLONE_URL"
[[ $? -ne 0 ]] && pass "a target whose SHAPE changed (a part-applied migration) is refused" || fail "drifted shape accepted"
echo shape0 > "$STATEDIR/SHAPE"; echo 999 > "$STATEDIR/NROWS"
crun bash "$RR" clone-baseline-verify "$CLONE_URL"
[[ $? -ne 0 ]] && pass "a target whose ROW COUNT changed is refused" || fail "drifted rows accepted"
crun bash "$RR" clone-reset-baseline --yes "$CLONE_URL"
[[ $? -ne 0 ]] && pass "reset also fails while the target still reports drift" || fail "reset reported success on a drifted target"
echo 1000 > "$STATEDIR/NROWS"
crun bash "$RR" clone-reset-baseline --yes "$CLONE_URL"
[[ $? -eq 0 ]] && pass "reset restores the pristine baseline WITHOUT a production snapshot" || fail "reset failed"
[[ -e "$STATEDIR/SYNTH_WAS_CALLED" ]] && pass "…by reloading synthetic data" || fail "reset did not reload"
seed
crun bash "$RR" clone-baseline-verify "$CLONE_URL"
[[ $? -ne 0 ]] && pass "with no recorded baseline, verification refuses" || fail "verified against nothing"

echo "== the clone gate is wired into every target-touching command =="
for sub in clone-push clone-make-prefix verify-clone; do
  sed -n "/^cmd_${sub//-/_}()/,/^}/p" "$RR" | grep -q 'assert_clone_isolated' \
    && pass "$sub is gated" || fail "$sub is NOT gated"
done
sed -n '/^assert_clone_isolated()/,/^}/p' "$RR" | grep -q 'rehearsal_inert_check.sql' \
  && pass "the gate proves INERTNESS (no marker, no fence — there is no provenance question)" || fail "gate does not check inertness"
sed -n '/^assert_clone_isolated()/,/^}/p' "$RR" | grep -q 'cmd_clone_baseline_verify' \
  && pass "…and that the target still matches the pristine baseline" || fail "gate does not check the baseline"

echo "== MUTANTS =="
mut(){ local n="$1"; local expr="$2"; local sc="${3:-}"; local m="$HERE/../.mutant-$n.sh"
  python3 - "$RR" "$m" "$expr" "$sc" <<'PYX'
import sys, re
src,dst,expr,scope=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]
s=open(src).read(); old,new=expr.split("||=||")
if scope:
    m=re.search(r"^%s\(\) \{.*?^\}$"%re.escape(scope), s, re.S|re.M); assert m, scope
    b=m.group(0); assert b.count(old)==1, (scope, b.count(old))
    s=s[:m.start()]+b.replace(old,new,1)+s[m.end():]
else:
    assert s.count(old)==1, (old[:50], s.count(old))
    s=s.replace(old,new,1)
open(dst,"w").write(s)
PYX
  printf '%s' "$m"; }

M="$(mut norefuse '  refuse_unsupported_fence "clone-source-quiesce"||=||  warn "withdrawn (advisory only)"; return 0' cmd_clone_source_quiesce)"
seed
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" bash "$M" clone-source-quiesce --yes "$PROD_URL" ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (refusal downgraded to a warning) lets the withdrawn command proceed — a hard die, not a warn, is load-bearing" || fail "norefuse mutant not distinguishable"
rm -f "$M"

M="$(mut noempty '  run_artifact "$1" empty_project_check.sql||=||  :' assert_rehearsal_target)"
seed; measured yes; echo 1 > "$STATEDIR/E_VAULT"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$CLONE" bash "$M" clone-verify-empty "$CLONE_URL" ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (empty-project check removed) accepts a target holding Vault secrets — proving inertness before loading is load-bearing" || fail "noempty mutant not distinguishable"
rm -f "$M"

M="$(mut nomeasured '  assert_scale_is_measured||=||  :' cmd_clone_build_baseline)"
seed; measured no
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$CLONE" bash "$M" clone-build-baseline --yes "$CLONE_URL" ) >/dev/null 2>&1
[[ $? -eq 0 && -e "$STATEDIR/SYNTH_WAS_CALLED" ]] \
  && pass "MUTANT (measured-scale check removed) builds a baseline from placeholder row counts — an invented scale would be reported as a real timing" || fail "nomeasured mutant not distinguishable"
rm -f "$M"

M="$(mut nosynth '  grep -q '"'"'^SYNTHETIC ok$'"'"' "$tmp" || { rm -f "$tmp"; die "baseline contains a NON-SYNTHETIC address — refusing to record it"; }||=||  :' clone_capture_baseline)"
seed; measured yes; echo VIOLATION > "$STATEDIR/SYNTH"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$CLONE" bash "$M" clone-build-baseline --yes "$CLONE_URL" ) >/dev/null 2>&1
[[ -s "$EVID/rehearsal-baseline-fingerprint.txt" ]] \
  && pass "MUTANT (synthetic assertion removed) records a baseline containing a real-looking address — the PII guard is load-bearing" || fail "nosynth mutant not distinguishable"
rm -f "$M"

M="$(mut nobaseline '  cmd_clone_baseline_verify "$url"||=||  :' assert_clone_isolated)"
seed; measured yes; crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"
echo shape-CHANGED > "$STATEDIR/SHAPE"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$CLONE" CAP_STMT=30000 \
  bash "$M" verify-clone "$CLONE_URL" --clone ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (baseline check removed from the gate) rehearses against a drifted target — a failed migration could leave a reusable false green" || fail "nobaseline mutant not distinguishable"
rm -f "$M"

M="$(mut nodeact '  run_artifact "$url" clone_deactivate_schedules.sql||=||  :' cmd_clone_build_baseline)"
seed; measured yes
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$CLONE" bash "$M" clone-build-baseline --yes "$CLONE_URL" ) >/dev/null 2>&1
[[ ! -e "$STATEDIR/I_ACTIVE" ]] \
  && pass "MUTANT (deactivation removed) leaves the schema build's cron jobs ACTIVE on the target — deactivation is load-bearing" || fail "nodeact mutant not distinguishable"
rm -f "$M"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
