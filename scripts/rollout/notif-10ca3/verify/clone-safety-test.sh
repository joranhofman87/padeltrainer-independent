#!/usr/bin/env bash
# ===========================================================================
# clone-safety-test.sh — a clone must be provably INERT before any rehearsal.
#
# A Supabase restore copies pg_cron jobs, the pg_net queue, database webhooks,
# Auth data and Vault-readable secrets, so a restored project boots with REAL
# credentials and resumes cron immediately. Production inventory (read-only,
# 2026-08-01) found notification-email-worker and notification-whatsapp-worker
# on */2 issuing outbound HTTP: a naive clone would send real email/WhatsApp to
# real customers within minutes.
#
# No network, no production: psql is stubbed and every state is synthetic.
# Run: bash scripts/rollout/notif-10ca3/verify/clone-safety-test.sh
# ===========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RR="$HERE/../run-rollout.sh"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"; rm -f "$HERE/../.mutant-"*.sh' EXIT

P=0; F=0
pass(){ P=$((P+1)); echo "  PASS  $*"; }
fail(){ F=$((F+1)); echo "  FAIL  $*"; }

REF=ficwbdrzefmblkbkomzw; export REF
CLONE=zzzzzzzzzzzzzzzzzzzz
PROD_URL="postgresql://postgres@db.${REF}.supabase.co:5432/postgres"
CLONE_URL="postgresql://postgres@db.${CLONE}.supabase.co:5432/postgres"
BIN="$ROOT/bin"; mkdir -p "$BIN"; export STATEDIR="$ROOT/state"; mkdir -p "$STATEDIR"
EVID="$ROOT/evidence"; mkdir -p "$EVID"
APPROVED_TS="2026-08-01T18:00:00Z"

# --- psql stub: synthesises inventory + counts + alter_job effects ----------
cat > "$BIN/psql" <<'EOF'
#!/usr/bin/env bash
args="$*"
f=""; prev=""; for a in "$@"; do [[ "$prev" == "-f" ]] && f="$a"; prev="$a"; done
sfile(){ cat "$STATEDIR/$1" 2>/dev/null || echo "$2"; }
# artifact runs
if [[ "$f" == *clone_source_inventory.sql ]]; then
  [[ "$(sfile INV_FAIL 0)" == 1 ]] && { echo "connection failed" >&2; exit 1; }
  while IFS=$'\t' read -r n act out; do [[ -n "$n" ]] && echo "CRONJOB $n $act $out"; done < "$STATEDIR/jobs"
  echo "RUNNING $(sfile RUNNING 0)"
  echo "NETQUEUE $(sfile NETQUEUE 0)"
  echo "HOOKTRIG $(sfile HOOKTRIG 0)"
  echo "OUTTRIG $(sfile OUTTRIG 0)"
  echo "FDWSRV $(sfile FDWSRV 0)"
  echo "VAULTCOUNT 1"
  exit 0
fi
if [[ "$f" == *clone_isolation.sql ]]; then
  a="$(sfile C_ACTIVE 0)"; r="$(sfile C_RUNNING 0)"; q="$(sfile C_NETQ 0)"; h="$(sfile C_HOOK 0)"; t="$(sfile C_OUTTRIG 0)"; s="$(sfile C_FDW 0)"
  for v in "$a" "$r" "$q" "$h" "$t" "$s"; do
    [[ "$v" == 0 ]] || { echo "ERROR:  assertion failed" >&2; exit 3; }
  done
  echo "NOTE: clone isolation ok"; exit 0
fi
# -Atqc scalar queries
if [[ "$args" == *-Atqc* ]]; then
  q="${*: -1}"
  case "$q" in
    *"format('JOB"*)
      [[ "$(sfile MANIFEST_FAIL 0)" == 1 ]] && exit 1
      i=0; while IFS=$'\t' read -r n act out; do i=$((i+1)); [[ -n "$n" ]] && printf 'JOB\t%s\t%s\t%s\n' "$i" "$n" "$act"; done < "$STATEDIR/jobs"; exit 0;;
    *"alter_job"*"active := false"*)
      [[ "$(sfile PAUSE_FAIL 0)" == 1 ]] && exit 1
      if [[ "$(sfile PARTIAL_PAUSE 0)" == 1 ]]; then
        awk -F'\t' 'NR==1{print $1"\ttrue\t"$3; next}{print $1"\tfalse\t"$3}' "$STATEDIR/jobs" > "$STATEDIR/jobs.n"
      else
        awk -F'\t' '{print $1"\tfalse\t"$3}' "$STATEDIR/jobs" > "$STATEDIR/jobs.n"
      fi
      mv "$STATEDIR/jobs.n" "$STATEDIR/jobs"; echo ok; exit 0;;
    *"alter_job("*)
      want="$(sed -n 's/.*active := \([a-z]*\).*/\1/p' <<<"$q")"
      jid="$(sed -n 's/.*alter_job(\([0-9]*\).*/\1/p' <<<"$q")"
      [[ "$(sfile RESTORE_FAIL 0)" == 1 ]] && exit 1
      awk -F'\t' -v j="$jid" -v w="$want" 'NR==j{print $1"\t"w"\t"$3; next}{print}' "$STATEDIR/jobs" > "$STATEDIR/jobs.n"
      mv "$STATEDIR/jobs.n" "$STATEDIR/jobs"; echo ok; exit 0;;
    *"FROM cron.job WHERE active"*)  awk -F'\t' '$2=="true"' "$STATEDIR/jobs" | grep -c . || true; exit 0;;
    *"status = 'running'"*)          sfile RUNNING 0; exit 0;;
    *"net.http_request_queue"*)      sfile NETQUEUE 0; exit 0;;
    *"IS DISTINCT FROM m.want"*)     sfile DRIFT 0; exit 0;;
    *"to_char(now()"*)               [[ "$(sfile TS_FAIL 0)" == 1 ]] && exit 1; echo "2026-08-01T18:00:00Z"; exit 0;;
  esac
  echo ""; exit 0
fi
exit 0
EOF
chmod +x "$BIN/psql"

PRODJOBS_OK=$'release-expired-rebook-holds\ttrue\tno\nnotification-email-worker\ttrue\tyes\nnotification-whatsapp-worker\ttrue\tyes'
seed(){ rm -f "$STATEDIR"/*; printf '%s\n' "$PRODJOBS_OK" > "$STATEDIR/jobs"; }
run(){ ( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" "$@" ) >"$ROOT/out.txt" 2>&1; }
actives(){ awk -F'\t' '$2=="true"' "$STATEDIR/jobs" | grep -c . || true; }

echo "== read-only inventory: safe metadata only, fail closed on the unknown =="
seed; run bash "$RR" clone-source-inventory "$PROD_URL"; rc=$?
[[ "$rc" -eq 0 ]] && pass "inventory of a reviewed job set succeeds" || fail "inventory rejected a reviewed set (exit $rc): $(tail -2 "$ROOT/out.txt")"
grep -qE 'md5|command|http|Bearer|apikey|token' "$EVID/clone-source-inventory.txt" && fail "the inventory artifact contains command/secret-shaped text" \
  || pass "the inventory artifact carries no command, URL, header or secret text"
grep -q 'notification-email-worker' "$ROOT/out.txt" && pass "job names and outbound flags are reported" || fail "no job names reported"
[[ "$(actives)" == 3 ]] && pass "inventory is READ-ONLY: nothing was paused" || fail "inventory mutated state"

seed; printf 'a-brand-new-runtime-job\ttrue\tyes\n' >> "$STATEDIR/jobs"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "an UNREVIEWED job (e.g. added at runtime by schedule_*_job) stops the procedure" || fail "unknown job accepted"
seed; echo 1 > "$STATEDIR/HOOKTRIG"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "an enabled database webhook stops the procedure" || fail "webhook accepted"
seed; echo 2 > "$STATEDIR/OUTTRIG"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "an unclassified outbound trigger stops the procedure" || fail "outbound trigger accepted"
seed; echo 1 > "$STATEDIR/FDWSRV"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "a foreign server / FDW stops the procedure" || fail "FDW accepted"
seed; echo 1 > "$STATEDIR/INV_FAIL"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "a FAILED inventory read stops the procedure (never classifies blind)" || fail "failed read accepted"
seed; run bash "$RR" clone-source-inventory "$CLONE_URL"
[[ $? -ne 0 ]] && pass "inventory refuses a non-production URL (exact identity)" || fail "wrong-ref URL accepted"

echo "== quiesce: reversible pause, proof of inertness, then the PITR instant =="
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; rc=$?
[[ "$rc" -eq 0 ]] && pass "quiesce succeeds on a reviewed, quiescent source" || fail "quiesce failed (exit $rc): $(tail -3 "$ROOT/out.txt")"
[[ "$(actives)" == 0 ]] && pass "every cron job is paused" || fail "$(actives) job(s) still active"
grep -q 'cron.alter_job' "$RR" && pass "the pause uses cron.alter_job (reversible)" || fail "no cron.alter_job in the tooling"
grep -qE '^[^#]*cron\.unschedule' "$RR" && fail "cron.unschedule is CALLED in the tooling (irreversible)" \
  || pass "cron.unschedule is never called (only named in the comment that forbids it)"
[[ -s "$EVID/clone-source-manifest.txt" ]] && pass "a prior-state manifest was written before pausing" || fail "no manifest"
grep -qE 'true|false' "$EVID/clone-source-manifest.txt" && pass "the manifest records each job's exact prior active state" || fail "manifest lacks prior states"
grep -qiE 'password|secret|token|http' "$EVID/clone-source-manifest.txt" && fail "the manifest contains secret-shaped text" \
  || pass "the manifest is non-secret (id/name/active only)"
[[ "$(cat "$EVID/clone-source-timestamp.txt")" == "$APPROVED_TS" ]] && pass "the PITR instant is recorded only after inertness" || fail "no/incorrect timestamp"

for cond in "RUNNING 2 running cron executions" "NETQUEUE 5 queued pg_net requests"; do
  set -- $cond; key="$1"; val="$2"; shift 2; desc="$*"
  seed; echo "$val" > "$STATEDIR/$key"
  run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
  [[ $? -ne 0 ]] && pass "quiesce refuses with ${desc}" || fail "${desc} accepted"
  [[ "$(actives)" == 3 ]] && pass "…and production was RESTORED, never left paused (${desc})" || fail "production left paused after ${desc}"
  [[ ! -f "$EVID/clone-source-timestamp.txt" ]] || { rm -f "$EVID/clone-source-timestamp.txt"; }
done
seed; echo 1 > "$STATEDIR/PARTIAL_PAUSE"
run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "a PARTIAL pause is detected and refused" || fail "partial pause accepted"
[[ "$(actives)" == 3 ]] && pass "…and production was restored after the partial pause" || fail "production left partially paused"
seed; echo 1 > "$STATEDIR/MANIFEST_FAIL"
run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "a failed prior-state capture stops BEFORE anything is paused" || fail "paused without a way back"
[[ "$(actives)" == 3 ]] && pass "…and nothing was paused" || fail "state changed despite a failed manifest"
seed; echo 1 > "$STATEDIR/TS_FAIL"
run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "a failed snapshot-instant read aborts and restores" || fail "timestamp failure accepted"

echo "== resume: restores the EXACT prior states and verifies them =="
seed; printf 'release-expired-rebook-holds\tfalse\tno\nnotification-email-worker\ttrue\tyes\nnotification-whatsapp-worker\ttrue\tyes\n' > "$STATEDIR/jobs"
run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
run bash "$RR" clone-source-resume --yes "$PROD_URL"; rc=$?
[[ "$rc" -eq 0 ]] && pass "resume succeeds" || fail "resume failed (exit $rc)"
[[ "$(awk -F'\t' 'NR==1{print $2}' "$STATEDIR/jobs")" == false ]] \
  && pass "a job that was ALREADY inactive is restored to inactive (not blanket-enabled)" || fail "prior-inactive job was wrongly enabled"
[[ "$(actives)" == 2 ]] && pass "the two previously-active jobs are active again" || fail "actives=$(actives)"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
echo 1 > "$STATEDIR/RESTORE_FAIL"
run bash "$RR" clone-source-resume --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "a FAILED restore is loud and non-zero (production may still be paused)" || fail "failed restore reported success"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
rm -f "$STATEDIR/RESTORE_FAIL"; echo 1 > "$STATEDIR/DRIFT"
run bash "$RR" clone-source-resume --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "post-restore STATE DRIFT is detected and refused" || fail "drift accepted"

echo "== clone-side isolation gates every rehearsal command =="
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"    # establishes the approved TS
clone_run(){ ( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$CLONE" \
    CLONE_SOURCE_TS="${1:-$APPROVED_TS}" CAP_STMT=30000 SUPABASE_DB_PASSWORD=x bash "$RR" "${@:2}" ) >"$ROOT/c.txt" 2>&1; }
clone_run "$APPROVED_TS" preflight "$CLONE_URL" --clone
[[ $? -eq 0 ]] && pass "an inert clone from the approved snapshot passes the gate" || fail "inert clone rejected: $(tail -2 "$ROOT/c.txt")"
clone_run "2026-01-01T00:00:00Z" preflight "$CLONE_URL" --clone
[[ $? -ne 0 ]] && pass "a clone from a DIFFERENT snapshot instant is refused" || fail "unapproved snapshot accepted"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$CLONE" CAP_STMT=30000 \
  bash "$RR" preflight "$CLONE_URL" --clone ) >/dev/null 2>&1
[[ $? -ne 0 ]] && pass "a missing CLONE_SOURCE_TS is refused (cannot prove the source was inert)" || fail "missing CLONE_SOURCE_TS accepted"
for k in C_ACTIVE C_RUNNING C_NETQ C_HOOK C_OUTTRIG C_FDW; do
  echo 1 > "$STATEDIR/$k"
  clone_run "$APPROVED_TS" preflight "$CLONE_URL" --clone
  [[ $? -ne 0 ]] && pass "clone with non-zero ${k} is refused" || fail "${k} accepted on the clone"
  rm -f "$STATEDIR/$k"
done
mv "$EVID/clone-source-timestamp.txt" "$ROOT/ts.bak"
clone_run "$APPROVED_TS" preflight "$CLONE_URL" --clone
[[ $? -ne 0 ]] && pass "with NO approved snapshot on file, no clone command may run" || fail "ran without an approved snapshot"
mv "$ROOT/ts.bak" "$EVID/clone-source-timestamp.txt"
for sub in clone-push clone-make-prefix verify-clone; do
  sed -n "/^cmd_${sub//-/_}()/,/^}/p" "$RR" | grep -q 'assert_clone_isolated' \
    && pass "$sub is gated on the isolation assertion" || fail "$sub is NOT gated"
done

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
    assert s.count(old)==1, (old[:40], s.count(old))
    s=s.replace(old,new,1)
open(dst,"w").write(s)
PYX
  printf '%s' "$m"; }

M="$(mut nogate 'assert_clone_isolated "$url"          # no rehearsal touches a clone that is not provably inert||=||:' cmd_clone_push)"
grep -q '^  :$' "$M" && pass "mutant built: clone-push isolation gate removed" || fail "nogate mutant not applied"
echo 1 > "$STATEDIR/C_ACTIVE"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$CLONE" CLONE_SOURCE_TS="$APPROVED_TS" \
  CAP_STMT=30000 SUPABASE_DB_PASSWORD=x bash "$M" clone-push --yes "$CLONE_URL" ) >"$ROOT/m.txt" 2>&1
grep -q 'clone isolation' "$ROOT/m.txt" && fail "mutant still asserted isolation" \
  || pass "MUTANT (no gate) proceeds against a clone with LIVE cron — the gate is load-bearing"
rm -f "$STATEDIR/C_ACTIVE" "$M"

M="$(mut noreview 'assert_inventory_is_reviewed "$inv"||=||:' cmd_clone_source_quiesce)"
grep -q 'cmd_clone_source_quiesce' "$M" && pass "mutant built: reviewed-inventory check removed from quiesce" || fail "noreview mutant not applied"
seed; printf 'a-brand-new-runtime-job\ttrue\tyes\n' >> "$STATEDIR/jobs"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" bash "$M" clone-source-quiesce --yes "$PROD_URL" ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (no completeness check) quiesces with an UNKNOWN job — the check is load-bearing" || fail "noreview mutant not distinguishable"
rm -f "$M"

M="$(mut noqueue 'n="$(psql "$url" -v ON_ERROR_STOP=1 -Atqc "SELECT count(*) FROM net.http_request_queue")" || return 1||=||n=0' quiesce_guards)"
grep -q '^  n=0$' "$M" && pass "mutant built: pg_net queue check removed" || fail "noqueue mutant not applied"
seed; echo 5 > "$STATEDIR/NETQUEUE"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" bash "$M" clone-source-quiesce --yes "$PROD_URL" ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (no queue check) snapshots with 5 QUEUED outbound requests — the check is load-bearing" || fail "noqueue mutant not distinguishable"
rm -f "$M"

M="$(mut norestore 'clone_source_restore "$url" || warn "AUTOMATIC RESTORE ALSO FAILED — run '"'"'clone-source-resume --yes <url>'"'"' IMMEDIATELY"
    die "clone-source quiesce aborted (production state restored, or restore attempted and reported above)"||=||die "aborted"' cmd_clone_source_quiesce)"
grep -q 'die "aborted"' "$M" && pass "mutant built: automatic restore removed from the failure path" || fail "norestore mutant not applied"
seed; echo 5 > "$STATEDIR/NETQUEUE"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" bash "$M" clone-source-quiesce --yes "$PROD_URL" ) >/dev/null 2>&1
[[ "$(actives)" == 0 ]] && pass "MUTANT (no auto-restore) LEAVES PRODUCTION PAUSED — the restore path is load-bearing" || fail "norestore mutant not distinguishable"
rm -f "$M"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
