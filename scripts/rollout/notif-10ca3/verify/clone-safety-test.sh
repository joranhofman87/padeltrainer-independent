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
  [[ -e "$STATEDIR/SCHEMA" ]] && boom "$(sfile EMPTY_MSG 'target is not empty (a previous build left a schema behind)')"
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
if [[ "$f" == *platform_stub.sql ]]; then
  [[ "$(sfile STUB_PARTIAL 0)" == 1 ]] && { echo "ERROR:  stub died part-way" >&2; exit 3; }
  [[ "$(sfile SHIM_FAIL 0)" == 0 ]] || boom "real pg_cron/pg_net present; stand-in refused"
  : > "$S/SHIM"; : > "$S/MARKER_TBL"; echo 0 > "$S/I_ACTIVE"; echo "NOTE: inert stand-ins installed"; exit 0
fi
if [[ "$f" == *clone_wipe.sql ]]; then
  [[ -e "$S/SHIM" ]] || boom "refusing to wipe: shims absent"
  rm -f "$S/SHIM" "$S/MARKER_TBL" "$S/SCHEMA" "$S/LEDGER"; echo "NOTE: wiped"; exit 0
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
# the durable recovery-eligibility probe: a COUNT, answered from real state
case "$*" in
  *rehearsal_target_marker*)
    [[ -e "$S/MARKER_TBL" ]] && { echo 1; exit 0; }
    echo 'ERROR:  relation "net.rehearsal_target_marker" does not exist' >&2; exit 1;;
esac
exit 0
EOF
cat > "$BIN/supabase" <<'EOF'
#!/usr/bin/env bash
: > "$STATEDIR/SUPABASE_WAS_CALLED"
# a push is only meaningful once the stand-ins exist AND the source is sanitized
[[ -e "$STATEDIR/SHIM" ]] && : > "$STATEDIR/PUSH_AFTER_SHIM" || : > "$STATEDIR/PUSH_BEFORE_SHIM"
[[ "$*" == *--workdir* ]] && : > "$STATEDIR/PUSH_FROM_SANITIZED"
: > "$STATEDIR/SCHEMA"; : > "$STATEDIR/LEDGER"
[[ "$(cat "$STATEDIR/PUSH_FAIL" 2>/dev/null || echo 0)" == 1 ]] && { echo "push failed" >&2; exit 1; }
exit 0
EOF
cat > "$BIN/node" <<'EOF'
#!/usr/bin/env bash
# the real node is needed for the scale-file read; only the synth loader is stubbed
if [[ "$*" == *sanitize-migrations.mjs* ]]; then
  : > "$STATEDIR/SANITIZE_WAS_CALLED"
  [[ "$(cat "$STATEDIR/SANITIZE_FAIL" 2>/dev/null || echo 0)" == 1 ]] && { echo "refusing: the migration chain has CHANGED since it was reviewed" >&2; exit 4; }
  d="${@: -1}"; mkdir -p "$d"; echo "SANITIZED files=552 neutralised_extension_statements=3 out=$d"; exit 0
fi
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
    d['byte_tolerance_pct']=50
    d['tables']['email_address_state'].update(rows=1000, avg_email_len=32, avg_reason_len=24, total_bytes=500000)
    d['tables']['email_address_state']['state_distribution']={'ok':900,'soft_bounced':50,'hard_bounced':30,'complained':20}
    d['tables']['email_delivery_events'].update(rows=5000, avg_reason_len=24, total_bytes=2000000,
        resend_event_id_pct=60, with_invoice_pct=40)
    d['tables']['email_delivery_events']['events_per_address']={'p50':2,'p90':6,'max':20}
    d['tables']['email_delivery_events']['event_type_distribution']={'sent':3000,'delivered':1500,'bounced':300,'complained':100,'delivery_delayed':50,'failed':30,'send_failed':20}
else:
    d['source']='placeholder'; d['measured_at']=None
    d['tables']['email_address_state'].update(rows=0, total_bytes=0)
    d['tables']['email_delivery_events'].update(rows=0, total_bytes=0)
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
grep -q 'from sanitized main' "$ROOT/out.txt" && pass "…and the log says so, so the migrations under test are applied separately" || fail "schema source not stated"
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
# Beyond the two tables #615 locks, the generator writes only the minimum parent
# graph the real FKs require: invoices (NOT NULL trainer_id/invoice_number/
# due_date/player_name) and the single trainer_profiles row those point at.
[[ "$TBL" == "email_address_state,email_delivery_events,invoices,trainer_profiles" ]] \
  && pass "the generator writes ONLY the two tables #615 locks plus the minimum FK parent graph ($TBL)" \
  || fail "generator touches other tables: $TBL"
GEN="$HERE/../synth/build-baseline.mjs"
grep -qF 'SYN-' "$GEN" \
  && pass "…and every invoice field is synthetic (SYN- numbering, placeholder name)" || fail "invoice rows are not obviously synthetic"
grep -qF "'synthetic'" "$GEN" \
  && pass "…and the trainer parent's only literal value is 'synthetic'" || fail "trainer parent carries real-looking data"
grep -qF 'information_schema.columns' "$GEN" && grep -qF 'is_nullable' "$GEN" \
  && pass "…filling exactly the NOT NULL columns the live schema declares, not a hard-coded guess" || fail "parent columns are hard-coded"
grep -q 'example.invalid' "$HERE/../synth/build-baseline.mjs" \
  && pass "every generated address uses the reserved, undeliverable example.invalid TLD" || fail "addresses are not on a reserved TLD"
# capture then match: `producer | grep -q` under pipefail reports the PRODUCER's
# status, which is the same false-green shape this suite exists to catch
GENSRC="$(sed -e 's|//.*$||' "$HERE/../synth/build-baseline.mjs")"
grep -qF 'Math.random' <<<"$GENSRC" \
  && fail "the generator is nondeterministic" \
  || pass "the generator is deterministic — no executable Math.random (repeatable rehearsals)"

echo "-- the build is inert WHILE it runs, not only afterwards --"
seed; measured yes
crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"
[[ -e "$STATEDIR/PUSH_AFTER_SHIM" && ! -e "$STATEDIR/PUSH_BEFORE_SHIM" ]] \
  && pass "the inert cron/pg_net shims are installed BEFORE the schema build (14 migrations on main call cron.schedule)" \
  || fail "the schema was pushed before the shims existed"
sed -n '/^clone_build_schema_and_data()/,/^}/p' "$RR" | grep -nq 'platform_stub.sql' \
  && pass "the inert stand-in is part of the shared build path" || fail "no stand-in in the build path"
[[ -e "$STATEDIR/SANITIZE_WAS_CALLED" ]] \
  && pass "the migration source is SANITIZED (the chain installs pg_cron/pg_net; stand-ins alone would collide)" || fail "source not sanitized"
[[ -e "$STATEDIR/PUSH_FROM_SANITIZED" ]] \
  && pass "…and the push runs against the sanitized directory, not the repo's" || fail "pushed the raw chain"
awk '/^clone_build_schema_and_data\(\)/{b=1} b&&/platform_stub.sql/{shim=NR} b&&/sanitize-migrations.mjs/{san=NR} b&&/supabase db push/{push=NR} b&&/^}/{exit} END{exit !(shim && san && push && shim < san && san < push)}' "$RR" \
  && pass "…and stand-in, sanitize and push are textually in that order, so it cannot drift" || fail "build ordering is wrong"
seed; measured yes; echo 1 > "$STATEDIR/SHIM_FAIL"
crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"
[[ $? -ne 0 ]] && pass "a target with REAL pg_cron/pg_net is refused (stand-ins cannot shadow them)" || fail "stand-in refusal ignored"
seed; measured yes; echo 1 > "$STATEDIR/SANITIZE_FAIL"
crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"
[[ $? -ne 0 ]] && pass "a chain that cannot be sanitized aborts the build (fail closed on the unknown)" || fail "unsanitizable chain accepted"
grep -q 'CHANGED since it was reviewed' "$ROOT/out.txt" \
  && pass "…including a chain that merely MOVED — main changing forces a re-review" || fail "no re-review message"
[[ ! -e "$STATEDIR/SUPABASE_WAS_CALLED" ]] && pass "…and nothing was pushed" || fail "pushed an unsanitized chain"
[[ ! -e "$STATEDIR/SUPABASE_WAS_CALLED" ]] && pass "…and no schema was pushed to it" || fail "pushed despite an unshimmable target"

echo "-- reset is a REAL rebuild, not a row reload --"
seed; measured yes; crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"
rm -f "$STATEDIR/SUPABASE_WAS_CALLED" "$STATEDIR/PUSH_AFTER_SHIM"
crun bash "$RR" clone-reset-baseline --yes "$CLONE_URL"; rc=$?
[[ "$rc" -eq 0 ]] && pass "reset succeeds" || fail "reset failed (exit $rc): $(tail -3 "$ROOT/out.txt")"
grep -q 'wiping the rehearsal target to bare metal' "$ROOT/out.txt" \
  && pass "…by WIPING schema, shims and the migration ledger (reloading rows cannot undo a migration)" || fail "reset did not wipe"
[[ -e "$STATEDIR/SUPABASE_WAS_CALLED" ]] && pass "…and re-pushing the full migration chain" || fail "reset did not rebuild the schema"
[[ -e "$STATEDIR/PUSH_AFTER_SHIM" ]] && pass "…with the shims installed first, again" || fail "rebuild pushed before shimming"
sed -n '/^cmd_clone_reset_baseline()/,/^}/p' "$RR" | grep -q 'clone_build_schema_and_data' \
  && pass "…through the SAME build path, so a reset cannot drift from the build" || fail "reset uses a different path"
grep -q 'DELETE FROM supabase_migrations.schema_migrations' "$SQLD/clone_wipe.sql" \
  && pass "the wipe empties the migration ledger (leaving it would apply a SUFFIX next time)" || fail "ledger not cleared"
grep -q 'DROP SCHEMA IF EXISTS public CASCADE' "$SQLD/clone_wipe.sql" \
  && pass "…and drops the schema, so columns/functions/constraints really are gone" || fail "schema not dropped"

echo "-- recovery is offered ONLY for a target this tooling part-built --"
seed; measured yes; echo 1 > "$STATEDIR/E_VAULT"      # a foreign, non-empty project
crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"
[[ $? -ne 0 ]] && pass "a non-empty target that this tooling did NOT build is refused" || fail "foreign target accepted"
grep -q -- '--recover is NOT offered' "$ROOT/out.txt" \
  && pass "…and --recover is explicitly NOT offered for it (destroying someone else's project is the wrong answer)" || fail "recover offered for a foreign target"
grep -q 'E_VAULT' "$ROOT/out.txt" \
  && pass "…while the ORIGINAL diagnostic is still shown (the failing check is named), not replaced by a generic message" \
  || fail "the real diagnostic was suppressed"
seed; measured yes
# CLONE_REF == EXPECTED_REF is a genuine identity failure, not an emptiness one
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$REF" bash "$RR" clone-build-baseline --yes "$CLONE_URL" ) >"$ROOT/out.txt" 2>&1
[[ $? -ne 0 ]] && pass "a clone-IDENTITY failure fails as itself" || fail "identity failure accepted"
grep -q -- '--recover' "$ROOT/out.txt" && fail "an identity failure recommends destructive recovery" \
  || pass "…and never recommends --recover (auth/connectivity/identity are not recoverable by wiping)"

echo "-- recovery eligibility comes from the MARKER, not the error wording --"
seed; measured yes; echo 1 > "$STATEDIR/SYNTH_FAIL"
crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"     # leaves schema + marker, no baseline
rm -f "$STATEDIR/SYNTH_FAIL"
echo "a completely different message" > "$STATEDIR/EMPTY_MSG"
crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"
grep -q 'clone-reset-baseline --yes --recover' "$ROOT/out.txt" \
  && pass "with the marker PRESENT, recovery is still offered even though the error wording changed" \
  || fail "wording change withdrew a valid recovery"
grep -q 'a completely different message' "$ROOT/out.txt" \
  && pass "…and the changed diagnostic itself is still shown" || fail "diagnostic not propagated"
rm -f "$STATEDIR/MARKER_TBL"
crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"
grep -q -- '--recover is NOT offered' "$ROOT/out.txt" \
  && pass "with the marker ABSENT, recovery is refused regardless of wording" || fail "recovery offered without a marker"
rm -f "$STATEDIR/EMPTY_MSG"

echo "-- a stub that dies PART-WAY leaves nothing behind --"
seed; measured yes; echo 1 > "$STATEDIR/STUB_PARTIAL"
crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"
[[ $? -ne 0 ]] && pass "a stand-in install that dies part-way fails the build" || fail "partial stub accepted"
[[ ! -e "$STATEDIR/MARKER_TBL" && ! -e "$STATEDIR/SHIM" ]] \
  && pass "…and left NOTHING behind (the artifact is one transaction), so a plain retry works" || fail "partial stub state survived"
grep -q '^BEGIN;' "$SQLD/platform_stub.sql" && grep -q '^COMMIT;' "$SQLD/platform_stub.sql" \
  && pass "the stand-in artifact is wrapped in a single transaction" || fail "stub is not transactional"
awk '/^BEGIN;/{b=NR} /rehearsal_target_marker/{m=NR} /^COMMIT;/{c=NR} END{exit !(b && m && c && b<m && m<c)}' "$SQLD/platform_stub.sql" \
  && pass "…and the recovery marker is created INSIDE it, early, so a later failure is still recoverable" || fail "marker is not created early inside the transaction"
rm -f "$STATEDIR/STUB_PARTIAL"

echo "-- a FIRST build that fails part-way is recoverable, and only explicitly --"
seed; measured yes; echo 1 > "$STATEDIR/SYNTH_FAIL"
crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"
[[ $? -ne 0 ]] && pass "a generator failure fails the first build" || fail "failed build reported success"
[[ ! -s "$EVID/rehearsal-baseline-fingerprint.txt" ]] && pass "…and records NO fingerprint, so nothing false is left behind" || fail "a fingerprint was recorded for a failed build"
[[ -e "$STATEDIR/SCHEMA" ]] && pass "…but the schema DID land, so the target is no longer empty (the stuck state)" || fail "no partial state to recover from"
rm -f "$STATEDIR/SYNTH_FAIL"
crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"
[[ $? -ne 0 ]] && pass "a plain retry is refused — the target is not empty" || fail "retry accepted a non-empty target"
grep -q 'clone-reset-baseline --yes --recover' "$ROOT/out.txt" \
  && pass "…and the refusal names the recovery command instead of leaving the operator stuck" || fail "no recovery path offered"
crun bash "$RR" clone-reset-baseline --yes "$CLONE_URL"
[[ $? -ne 0 ]] && pass "a plain reset is refused too — there is no baseline to verify against" || fail "plain reset accepted"
grep -q -- '--recover' "$ROOT/out.txt" && pass "…and it too points at --recover" || fail "reset does not mention --recover"
crun bash "$RR" clone-reset-baseline --yes --recover "$CLONE_URL"; rc=$?
[[ "$rc" -eq 0 ]] && pass "clone-reset-baseline --recover wipes, rebuilds and records a pristine baseline" || fail "recovery failed (exit $rc): $(tail -3 "$ROOT/out.txt")"
[[ -s "$EVID/rehearsal-baseline-fingerprint.txt" ]] && pass "…and the fingerprint now exists" || fail "no baseline after recovery"
crun bash "$RR" clone-reset-baseline --yes --recover "$CLONE_URL"
[[ $? -ne 0 ]] && pass "--recover is REFUSED once a baseline exists (it discards a target; that must stay deliberate)" || fail "--recover accepted with a baseline on file"

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

# The shim makes every scheduled job inert at creation, and the post-push
# deactivation is belt-and-braces behind it. Either alone is masked by the other,
# so they are mutated TOGETHER and the claim is scoped to that: SOMETHING must
# keep the build's cron jobs from becoming active.
M="$(mut noinert '  run_artifact "$url" platform_stub.sql||=||  :' clone_build_schema_and_data)"
python3 - "$M" <<'PYX'
import sys,re
p=sys.argv[1]; s=open(p).read()
m=re.search(r"^clone_build_schema_and_data\(\) \{.*?^\}$", s, re.S|re.M)
b=m.group(0).replace('  run_artifact "$url" clone_deactivate_schedules.sql', '  :', 1)
open(p,"w").write(s[:m.start()]+b+s[m.end():])
PYX
seed; measured yes; echo 1 > "$STATEDIR/PRE_ACTIVE"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$CLONE" bash "$M" clone-build-baseline --yes "$CLONE_URL" ) >/dev/null 2>&1
[[ ! -e "$STATEDIR/SHIM" && ! -e "$STATEDIR/I_ACTIVE" ]] \
  && pass "MUTANT (shim AND deactivation removed) builds the schema with nothing keeping cron inert — one of the two is load-bearing" \
  || fail "noinert mutant not distinguishable"
rm -f "$M"

M="$(mut norebuild '  run_artifact "$url" clone_wipe.sql||=||  :' cmd_clone_reset_baseline)"
seed; measured yes; crun bash "$RR" clone-build-baseline --yes "$CLONE_URL"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$CLONE" bash "$M" clone-reset-baseline --yes "$CLONE_URL" ) >/dev/null 2>&1
[[ -e "$STATEDIR/SHIM" ]] \
  && pass "MUTANT (wipe removed from reset) leaves the previous rehearsal's schema, shims and ledger in place — the wipe is what makes a reset pristine" \
  || fail "norebuild mutant not distinguishable"
rm -f "$M"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
