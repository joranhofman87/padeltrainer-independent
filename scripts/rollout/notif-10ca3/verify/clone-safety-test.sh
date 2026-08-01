#!/usr/bin/env bash
# ===========================================================================
# clone-safety-test.sh — the sealed window must be DURABLE, and leaving it must
# be ATOMIC.
#
# A Supabase restore copies pg_cron jobs, the pg_net queue, database webhooks,
# Auth data and Vault-readable secrets, so a restored project boots with REAL
# credentials and resumes cron immediately. Production inventory (read-only,
# 2026-08-01) found notification-email-worker and notification-whatsapp-worker
# on */2 issuing outbound HTTP.
#
# An ACCESS EXCLUSIVE lock ends at COMMIT, so it cannot protect the interval in
# which restores are actually requested. public.schedule_*_job are SECURITY
# DEFINER and run as their owner, so role-level REVOKEs cannot stop them either.
# The fence is therefore a statement-level trigger on cron.job: it fires for any
# role, is copied into the clone, and needs no local shell.
#
# The psql stub INTERPRETS the SQL artifacts — it enforces exactly the assertions
# and performs exactly the effects the artifact text contains — so deleting a
# statement FROM THE SQL changes behaviour and is genuinely mutation-testable.
# It also records every COMMITTED state to a log, which lets the suite assert a
# property over all of them rather than at hand-picked moments.
#
# No network, no production: psql is stubbed and every state is synthetic.
# Run: bash scripts/rollout/notif-10ca3/verify/clone-safety-test.sh
# ===========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RR="$HERE/../run-rollout.sh"; SQLD="$HERE/../sql"
ROOT="$(mktemp -d)"
restore_sql(){ local f; for f in "$ROOT"/sqlbak/*; do [[ -e "$f" ]] || continue; cp "$f" "$SQLD/$(basename "$f")"; done; }
trap 'restore_sql; rm -rf "$ROOT"; rm -f "$HERE/../.mutant-"*.sh' EXIT
mkdir -p "$ROOT/sqlbak"

P=0; F=0
pass(){ P=$((P+1)); echo "  PASS  $*"; }
fail(){ F=$((F+1)); echo "  FAIL  $*"; }

REF=ficwbdrzefmblkbkomzw; export REF
CLONE=zzzzzzzzzzzzzzzzzzzz
PROD_URL="postgresql://postgres@db.${REF}.supabase.co:5432/postgres"
CLONE_URL="postgresql://postgres@db.${CLONE}.supabase.co:5432/postgres"
BIN="$ROOT/bin"; mkdir -p "$BIN"; export STATEDIR="$ROOT/state"; mkdir -p "$STATEDIR"
EVID="$ROOT/evidence"; mkdir -p "$EVID"
export QUIESCE_WAIT_SECS=0   # the drain loop still runs its iterations, without wall-clock sleep

# --- psql stub --------------------------------------------------------------
# $STATEDIR/jobs rows:  id <TAB> name <TAB> active <TAB> outbound <TAB> cfg
#   cfg stands in for every behaviour-bearing field the real fingerprint covers
#   (schedule, database, username, command hash, node) collapsed into one token.
cat > "$BIN/psql" <<'EOF'
#!/usr/bin/env bash
args="$*"
f=""; prev=""; nonce=""; expect_fp=""; allow_unarmed=0
for a in "$@"; do
  [[ "$prev" == "-f" ]] && f="$a"
  [[ "$a" == nonce=*         ]] && nonce="${a#nonce=}"
  [[ "$a" == expect_fp=*     ]] && expect_fp="${a#expect_fp=}"
  [[ "$a" == allow_unarmed=* ]] && allow_unarmed="${a#allow_unarmed=}"
  prev="$a"
done
S="$STATEDIR"
sfile(){ cat "$S/$1" 2>/dev/null || echo "$2"; }
md5s(){ if command -v md5sum >/dev/null 2>&1; then md5sum | awk '{print $1}'; else md5 -q; fi; }
# the cron CONFIGURATION fingerprint: id, name and every behaviour-bearing field
cfgfp(){ awk -F'\t' '{printf "%s:%s:%s\n", $1, $2, $5}' "$S/jobs" | sort -n | md5s; }
snapfp(){ awk -F'\t' '{printf "%s:%s:%s\n", $1, $2, $4}' "$S/SNAP" 2>/dev/null | sort -n | md5s; }
actives(){ awk -F'\t' '$3=="true"' "$S/jobs" | grep -c . || true; }
has(){ grep -q -- "$1" "$f"; }
boom(){ echo "ERROR:  $1" >&2; exit 3; }
# every COMMITTED state, for whole-history invariants
commit_log(){ printf 'marker=%s state=%s fence=%s active=%s  (%s)\n' \
  "$( [[ -s "$S/MARKER" ]] && echo present || echo none )" "$(sfile MSTATE -)" \
  "$( [[ -e "$S/FENCE" ]] && echo 1 || echo 0 )" "$(actives)" "$1" >> "$S/commits.log"; }

if [[ "$f" == *clone_source_inventory.sql ]]; then
  [[ "$(sfile INV_FAIL 0)" == 1 ]] && { echo "connection failed" >&2; exit 1; }
  while IFS=$'\t' read -r id n act out cfg; do [[ -n "$n" ]] && echo "CRONJOB $n $act $out"; done < "$S/jobs"
  echo "CFGFP $(cfgfp)"
  echo "FENCEABLE $(sfile FENCEABLE yes)"
  echo "PRIORWINDOW $( [[ -s "$S/MARKER" ]] && echo 1 || echo 0 )"
  echo "RUNNING $(sfile RUNNING 0)";   echo "NETQUEUE $(sfile NETQUEUE 0)"
  echo "HOOKTRIG $(sfile HOOKTRIG 0)"; echo "OUTTRIG $(sfile OUTTRIG 0)"
  echo "FDWSRV $(sfile FDWSRV 0)"
  [[ -s "$S/outfns" ]] && while read -r n; do [[ -n "$n" ]] && echo "OUTFN $n"; done < "$S/outfns"
  [[ -s "$S/exts"   ]] && while read -r n; do [[ -n "$n" ]] && echo "EXT $n";   done < "$S/exts"
  echo "VAULTCOUNT 1"; exit 0
fi

if [[ "$f" == *clone_source_seal.sql ]]; then
  # --- preconditions: everything checkable BEFORE any effect (one transaction,
  #     so a failure here must leave the database untouched)
  has "pg_try_advisory_xact_lock" && { [[ "$(sfile ADVLOCK free)" == free ]] || boom "another quiesce is running"; }
  has "schema_name = 'rollout_clone'" && { [[ ! -s "$S/MARKER" ]] || boom "a prior sealed window exists"; }
  has ":'expect_fp'" && { [[ "$(cfgfp)" == "$expect_fp" ]] || boom "cron configuration is not the reviewed set"; }
  has "net.http_request_queue" && { [[ "$(sfile NETQUEUE 0)" == 0 ]] || boom "pg_net queue not empty"; }
  [[ -n "$nonce" ]] || boom "no nonce"
  # --- effects, in the artifact's own order
  has "INSERT INTO rollout_clone.snapshot_job_state" \
    && awk -F'\t' '{printf "%s\t%s\t%s\t%s\n", $1, $2, $3, $5}' "$S/jobs" > "$S/SNAP"
  has "SELECT cron.alter_job(jobid, active := false) FROM cron.job WHERE active" \
    && { awk -F'\t' '{print $1"\t"$2"\tfalse\t"$4"\t"$5}' "$S/jobs" > "$S/j.n"; mv "$S/j.n" "$S/jobs"; }
  has "CREATE TRIGGER rollout_clone_fence_dml" && : > "$S/FENCE"
  has "assert_fence_effective('seal')" && { [[ -e "$S/FENCE" ]] || boom "fence probe FAILED: cron.job still writable"; }
  has "FROM cron.job WHERE active" && { [[ "$(actives)" == 0 ]] || boom "active jobs at the boundary"; }
  printf '%s\n' "$nonce" > "$S/MARKER"; echo sealing > "$S/MSTATE"; cfgfp > "$S/MFP"
  has "REVOKE ALL ON SCHEMA rollout_clone FROM PUBLIC" && : > "$S/ACL_LOCKED"
  commit_log seal
  echo "SEAL_OBSERVED_AFTER_COMMIT 2026-08-01T18:00:00.123456Z"; exit 0
fi

if [[ "$f" == *clone_source_arm.sql ]]; then
  has "state = 'sealing'" && { [[ "$(cat "$S/MARKER" 2>/dev/null)" == "$nonce" && "$(sfile MSTATE -)" == sealing ]] || boom "no un-armed marker for this nonce"; }
  has "assert_fence_effective('arm')" && { [[ -e "$S/FENCE" ]] || boom "fence not effective at arm"; }
  has "snapshot_config_fp" && { [[ "$(cfgfp)" == "$(snapfp)" ]] || boom "cron configuration changed since the seal"; }
  has "FROM cron.job WHERE active" && { [[ "$(actives)" == 0 ]] || boom "active jobs at arm"; }
  has "status = 'running'" && { [[ "$(sfile RUNNING 0)" == 0 ]] || boom "running executions at arm"; }
  has "net.http_request_queue" && { [[ "$(sfile NETQUEUE 0)" == 0 ]] || boom "pg_net queue not empty at arm"; }
  echo sealed > "$S/MSTATE"; commit_log arm
  echo "ARM_OBSERVED_AFTER_COMMIT 2026-08-01T18:05:00.654321Z"; exit 0
fi

if [[ "$f" == *clone_source_resume.sql ]]; then
  has "state = 'sealed' OR" && {
    [[ "$(cat "$S/MARKER" 2>/dev/null)" == "$nonce" ]] || boom "marker nonce mismatch"
    [[ "$(sfile MSTATE -)" == sealed || "$allow_unarmed" == 1 ]] || boom "window is not armed"; }
  has "assert_fence_effective('resume')" && { [[ -e "$S/FENCE" ]] || boom "fence not effective at resume"; }
  has "snapshot_config_fp" && { [[ "$(cfgfp)" == "$(snapfp)" ]] || boom "configuration drifted while the window was open"; }
  # effects — all of them, or none: this whole block is ONE transaction
  cp "$S/jobs" "$S/jobs.tx"
  has "DROP TRIGGER rollout_clone_fence_dml" && rm -f "$S/FENCE.tx" && touch "$S/UNFENCED.tx"
  if has "SELECT cron.alter_job(s.jobid, active := s.prior_active)"; then
    awk -F'\t' 'NR==FNR{p[$1"|"$2]=$3; next}
                { k=$1"|"$2; print $1"\t"$2"\t"((k in p)?p[k]:$3)"\t"$4"\t"$5 }' \
        "$S/SNAP" "$S/jobs.tx" > "$S/jobs.n" && mv "$S/jobs.n" "$S/jobs.tx"
  fi
  if has "FULL OUTER JOIN rollout_clone.snapshot_job_state"; then
    # cfgcmp: only compare the behaviour-bearing config when the artifact still does
    cfgcmp=0; has "IS DISTINCT FROM s.command_md5" && cfgcmp=1
    mism="$(awk -F'\t' -v cc="$cfgcmp" 'NR==FNR{s[$1"|"$2]=$3"\t"$4; seen[$1"|"$2]=1; next}
              { k=$1"|"$2
                if (!(k in s)) { n++ }
                else { split(s[k],e,"\t"); if ($3!=e[1] || (cc==1 && $5!=e[2])) n++; delete seen[k] } }
              END{ for (k in seen) n++; print n+0 }' "$S/SNAP" "$S/jobs.tx")"
    [[ "$mism" == 0 ]] && : || { rm -f "$S/jobs.tx" "$S/UNFENCED.tx"; boom "${mism} job(s) differ from the sealed set"; }
  fi
  # COMMIT: apply every effect at once
  mv "$S/jobs.tx" "$S/jobs"
  [[ -e "$S/UNFENCED.tx" ]] && { rm -f "$S/FENCE" "$S/UNFENCED.tx"; }
  has "DROP TABLE rollout_clone.snapshot_marker" && rm -f "$S/MARKER" "$S/MSTATE" "$S/MFP" "$S/SNAP" "$S/ACL_LOCKED"
  commit_log resume
  echo "RESUME_OBSERVED_AFTER_COMMIT 2026-08-01T18:40:00.111222Z"; exit 0
fi

if [[ "$f" == *clone_isolation.sql ]]; then
  C="$S/clone"
  cl(){ cat "$C/$1" 2>/dev/null || echo "$2"; }
  clcfg(){ awk -F'\t' '{printf "%s:%s:%s\n", $1, $2, $5}' "$C/jobs" 2>/dev/null | sort -n | md5s; }
  clsnap(){ awk -F'\t' '{printf "%s:%s:%s\n", $1, $2, $4}' "$C/SNAP" 2>/dev/null | sort -n | md5s; }
  has "table_name = 'snapshot_marker'" && { [[ -s "$C/MARKER" ]] || boom "clone carries no snapshot marker"; }
  has "WHERE nonce = :'nonce'" && { [[ "$(cl MARKER)" == "$nonce" ]] || boom "clone marker nonce mismatch"; }
  has "'sealed'," && { [[ "$(cl MSTATE -)" == sealed ]] || boom "clone marker is not ARMED"; }
  has "assert_fence_effective('clone')" && { [[ -e "$C/FENCE" ]] || boom "the clone's fence is gone — restore point is outside the window"; }
  has "snapshot_config_fp" && { [[ "$(clcfg)" == "$(clsnap)" ]] || boom "clone cron configuration differs from the sealed one"; }
  has "has_schema_privilege" && { [[ -e "$C/ACL_LOCKED" ]] || boom "clone marker objects are not owner-only"; }
  has "FROM cron.job WHERE active" && { [[ "$(awk -F'\t' '$3=="true"' "$C/jobs" 2>/dev/null | grep -c . || true)" == 0 ]] || boom "clone active cron"; }
  has "status = 'running'"          && { [[ "$(cl C_RUNNING 0)" == 0 ]] || boom "clone running"; }
  has "net.http_request_queue"      && { [[ "$(cl C_NETQ 0)"    == 0 ]] || boom "clone queue"; }
  has "proname = 'http_request'"    && { [[ "$(cl C_HOOK 0)"    == 0 ]] || boom "clone webhooks"; }
  has "including nested call paths" && { [[ "$(cl C_OUTTRIG 0)" == 0 ]] || boom "clone outbound triggers"; }
  has "pg_foreign_server"           && { [[ "$(cl C_FDW 0)"     == 0 ]] || boom "clone FDW"; }
  echo "NOTE: clone isolation ok"; exit 0
fi

if [[ "$f" == *clone_unfence.sql ]]; then
  rm -f "$S/clone/FENCE"; echo "NOTE: clone unfenced"; exit 0
fi

if [[ "$args" == *-Atqc* ]]; then
  q="${*: -1}"
  case "$q" in
    *"rollout_clone.snapshot_job_state"*)
      [[ "$(sfile EXPORT_FAIL 0)" == 1 ]] && exit 1
      awk -F'\t' '{printf "JOB\t%s\t%s\t%s\n", $1, $2, $3}' "$S/SNAP"
      [[ "$(sfile EXPORT_TRUNC 0)" == 1 ]] && printf 'JOB\t77\ttruncated-tail\tfalse'   # no newline
      exit 0;;
    # a runtime schedule_*_job / direct cron.schedule attempt
    *"SCHEDULE_ATTEMPT"*)
      [[ -e "$S/FENCE" ]] && { echo "ERROR:  clone-safety fence: cron.job is FROZEN" >&2; exit 3; }
      printf '%s\tsneaked-in-job\ttrue\tyes\tcfg-new\n' "$(( $(wc -l < "$S/jobs") + 90 ))" >> "$S/jobs"
      echo ok; exit 0;;
    *"status = 'running'"*) sfile RUNNING 0; exit 0;;
  esac
  echo ""; exit 0
fi
exit 0
EOF
chmod +x "$BIN/psql"
bash -n "$BIN/psql" && echo "stub syntax OK"
PRODJOBS=$'1\trelease-expired-rebook-holds\ttrue\tno\tcfg-1\n9\tnotification-email-worker\ttrue\tyes\tcfg-9\n10\tnotification-whatsapp-worker\ttrue\tyes\tcfg-10'
seed(){ rm -rf "$STATEDIR"; mkdir -p "$STATEDIR"; printf '%s\n' "$PRODJOBS" > "$STATEDIR/jobs"; rm -f "$EVID/clone-source-nonce.txt"; }
run(){ ( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" "$@" ) >"$ROOT/out.txt" 2>&1; }
actives(){ awk -F'\t' '$3=="true"' "$STATEDIR/jobs" | grep -c . || true; }
nonce_file="$EVID/clone-source-nonce.txt"
# a runtime schedule_*_job / direct cron.schedule attempt against the source
attempt_schedule(){ ( PATH="$BIN:$PATH" psql "$PROD_URL" -Atqc "SELECT SCHEDULE_ATTEMPT" ) >/dev/null 2>&1; }
# take a restore point: a Supabase restore copies the whole database state
take_restore_point(){ rm -rf "$STATEDIR/clone"; mkdir -p "$STATEDIR/clone"
  cp "$STATEDIR"/jobs "$STATEDIR/clone/" 2>/dev/null
  for k in MARKER MSTATE MFP SNAP FENCE ACL_LOCKED; do [[ -e "$STATEDIR/$k" ]] && cp "$STATEDIR/$k" "$STATEDIR/clone/$k"; done; true; }
clone_gate(){ ( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$CLONE" \
  CAP_STMT=30000 SUPABASE_DB_PASSWORD=x bash "$RR" "$@" ) >"$ROOT/c.txt" 2>&1; }
# Drive ONE artifact directly. Downstream guards in later artifacts would
# otherwise mask a mutation in an earlier one, so a claim about a single
# artifact is proven against that artifact alone.
md5s(){ if command -v md5sum >/dev/null 2>&1; then md5sum | awk '{print $1}'; else md5 -q; fi; }
fp_of_jobs(){ awk -F'\t' '{printf "%s:%s:%s\n", $1, $2, $5}' "$STATEDIR/jobs" | sort -n | md5s; }
artifact(){ local a="$1"; shift; ( PATH="$BIN:$PATH" psql "$PROD_URL" -f "$SQLD/$a" "$@" ) >"$ROOT/a.txt" 2>&1; }
NONCE_FIX=0123456789abcdef0123456789abcdef

echo "== read-only inventory: safe metadata, fail closed, and SEALABILITY =="
seed; run bash "$RR" clone-source-inventory "$PROD_URL"; rc=$?
[[ "$rc" -eq 0 ]] && pass "inventory of a reviewed, sealable source succeeds" || fail "inventory rejected a reviewed set (exit $rc): $(tail -2 "$ROOT/out.txt")"
grep -qE 'md5|command|http|Bearer|apikey|token' "$EVID/clone-source-inventory.txt" && fail "the inventory artifact contains command/secret-shaped text" \
  || pass "the inventory artifact carries no command, URL, header or secret text"
[[ "$(actives)" == 3 ]] && pass "inventory is READ-ONLY: nothing was paused" || fail "inventory mutated state"
seed; echo no > "$STATEDIR/FENCEABLE"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "a role that CANNOT create the fence trigger stops the procedure in the READ-ONLY step" || fail "unfenceable source accepted"
grep -q 'fails closed rather than sealing an unprotected window' "$ROOT/out.txt" \
  && pass "…and says so, rather than degrading to a weaker guarantee" || fail "no fail-closed explanation"
seed; printf 'deadbeefdeadbeefdeadbeefdeadbeef\n' > "$STATEDIR/MARKER"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "an EXISTING sealed window stops a new one (never overwritten implicitly)" || fail "prior window ignored"
grep -q 'clone-source-abandon' "$ROOT/out.txt" && pass "…and names the explicit, reviewed recovery path" || fail "no recovery path named"
seed; printf '77\ta-brand-new-runtime-job\ttrue\tyes\tcfg-77\n' >> "$STATEDIR/jobs"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "an UNREVIEWED job (added at runtime by schedule_*_job) stops the procedure" || fail "unknown job accepted"
seed; awk -F'\t' '$1==1{print $1"\t"$2"\t"$3"\tyes\t"$5; next}{print}' "$STATEDIR/jobs" > "$STATEDIR/j2"; mv "$STATEDIR/j2" "$STATEDIR/jobs"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "OUTBOUND CLASSIFICATION DRIFT on a reviewed job stops the procedure" || fail "classification drift accepted"
seed; printf 'public.blast_everyone\n' > "$STATEDIR/outfns"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "an UNREVIEWED outbound-capable function (incl. nested paths) stops the procedure" || fail "unknown OUTFN accepted"
seed; printf 'pg_net\nhttp\n' > "$STATEDIR/exts"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "an UNREVIEWED extension with external capability stops the procedure" || fail "unknown EXT accepted"
for k in HOOKTRIG OUTTRIG FDWSRV; do
  seed; echo 1 > "$STATEDIR/$k"; run bash "$RR" clone-source-inventory "$PROD_URL"
  [[ $? -ne 0 ]] && pass "a non-zero ${k} count stops the procedure" || fail "${k} accepted"
done
seed; echo 1 > "$STATEDIR/INV_FAIL"; run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "a FAILED inventory read stops the procedure (never classifies blind)" || fail "failed read accepted"
seed; run bash "$RR" clone-source-inventory "$CLONE_URL"
[[ $? -ne 0 ]] && pass "inventory refuses a non-production URL (exact identity)" || fail "wrong-ref URL accepted"

echo "== quiesce: one transaction, then a DURABLE fence, then ARM =="
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; rc=$?
[[ "$rc" -eq 0 ]] && pass "quiesce succeeds on a reviewed, sealable source" || fail "quiesce failed (exit $rc): $(tail -3 "$ROOT/out.txt")"
[[ "$(actives)" == 0 ]] && pass "every cron job is paused" || fail "$(actives) job(s) still active"
[[ -e "$STATEDIR/FENCE" ]] && pass "the fence is installed on cron.job" || fail "no fence installed"
[[ "$(cat "$STATEDIR/MSTATE")" == sealed ]] && pass "the window is ARMED after the drain" || fail "window not armed"
[[ -e "$STATEDIR/ACL_LOCKED" ]] && pass "the marker/fence objects are revoked from PUBLIC/anon/authenticated/service_role" || fail "ACLs not locked down"
grep -qE '^[0-9a-f]{32,}$' "$nonce_file" && pass "a high-entropy snapshot NONCE was recorded" || fail "no nonce recorded"
[[ "$(cat "$nonce_file")" == "$(cat "$STATEDIR/MARKER")" ]] && pass "the marker COMMITTED IN THE DATABASE carries exactly the recorded nonce" || fail "marker/nonce mismatch"
grep -q 'cron.alter_job' "$RR" "$SQLD/clone_source_seal.sql" && pass "the pause uses cron.alter_job (reversible)" || fail "no cron.alter_job"
grep -qE '^[^-]*cron\.unschedule' "$SQLD/clone_source_seal.sql" "$SQLD/clone_source_resume.sql" && fail "cron.unschedule is CALLED (irreversible)" \
  || pass "cron.unschedule is never called (only named in the comment that forbids it)"

echo "-- THE POST-SEAL RACE: a job attempted after the seal must be REJECTED --"
attempt_schedule
[[ $? -ne 0 ]] && pass "a schedule_*_job / cron.schedule attempt INSIDE the armed window is rejected AT THE SOURCE" || fail "a job was created inside the sealed window"
[[ "$(wc -l < "$STATEDIR/jobs" | tr -d ' ')" == 3 ]] && pass "…and no job row was created (the fence rejects, it does not merely detect)" || fail "a job row appeared"
grep -q 'FOR EACH STATEMENT' "$SQLD/clone_source_seal.sql" \
  && pass "the fence is STATEMENT-level, so it fires even for a zero-row write" || fail "fence is not statement-level"
grep -q 'BEFORE TRUNCATE ON cron.job' "$SQLD/clone_source_seal.sql" \
  && pass "TRUNCATE on cron.job is fenced too" || fail "TRUNCATE is not fenced"
grep -q 'assert_fence_effective' "$SQLD/clone_source_seal.sql" \
  && pass "the seal PROVES the fence by probing it, not by asserting its presence" || fail "fence is not probed"

echo "-- the seal is one transaction: a failure changes NOTHING --"
for cond in "NETQUEUE 5 queued pg_net requests" "ADVLOCK held a concurrent quiesce"; do
  set -- $cond; key="$1"; val="$2"; shift 2; desc="$*"
  seed; echo "$val" > "$STATEDIR/$key"
  run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
  [[ $? -ne 0 ]] && pass "quiesce refuses with ${desc}" || fail "${desc} accepted"
  [[ "$(actives)" == 3 && ! -e "$STATEDIR/FENCE" && ! -s "$STATEDIR/MARKER" ]] \
    && pass "…and NOTHING was paused, fenced or marked (${desc})" || fail "partial effect left behind after ${desc}"
done
seed; echo 3 > "$STATEDIR/RUNNING"
run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "quiesce refuses when in-flight executions never drain" || fail "undrained source armed"
[[ "$(actives)" == 3 && ! -e "$STATEDIR/FENCE" && ! -s "$STATEDIR/MARKER" ]] \
  && pass "…and it LEFT THE WINDOW atomically: unpaused, unfenced, unmarked" || fail "production left paused/fenced after a drain failure"
seed; echo 1 > "$STATEDIR/EXPORT_TRUNC"
run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "an exported manifest with a TRUNCATED final record is refused (never silently dropped)" || fail "truncated manifest accepted"
seed; echo 1 > "$STATEDIR/EXPORT_FAIL"
run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "a failed manifest export is refused" || fail "failed export accepted"

echo "== resume: ONE atomic transition, and the whole-history invariant =="
seed; printf '1\trelease-expired-rebook-holds\tfalse\tno\tcfg-1\n9\tnotification-email-worker\ttrue\tyes\tcfg-9\n10\tnotification-whatsapp-worker\ttrue\tyes\tcfg-10\n' > "$STATEDIR/jobs"
run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
run bash "$RR" clone-source-resume --yes "$PROD_URL"; rc=$?
[[ "$rc" -eq 0 ]] && pass "resume succeeds" || fail "resume failed (exit $rc): $(tail -3 "$ROOT/out.txt")"
[[ "$(awk -F'\t' '$1==1{print $3}' "$STATEDIR/jobs")" == false ]] \
  && pass "a job that was ALREADY inactive is restored to inactive (not blanket-enabled)" || fail "prior-inactive job was wrongly enabled"
[[ "$(actives)" == 2 ]] && pass "the two previously-active jobs are active again" || fail "actives=$(actives)"
[[ ! -s "$STATEDIR/MARKER" && ! -e "$STATEDIR/FENCE" ]] && pass "resume removes BOTH the marker and the fence" || fail "marker or fence left behind"
[[ -s "$nonce_file" ]] && pass "the nonce file is RETAINED (clones are verified after production resumes)" || fail "nonce discarded at resume"
attempt_schedule
[[ $? -eq 0 ]] && pass "after resume, cron.job is writable again (the fence is not sticky)" || fail "production left fenced after resume"

echo "-- no COMMITTED state ever carries a valid marker beside active cron --"
bad="$(awk '/marker=present/ && !/active=0/' "$STATEDIR/commits.log" | wc -l | tr -d ' ')"
n="$(wc -l < "$STATEDIR/commits.log" | tr -d ' ')"
[[ "$n" -ge 3 && "$bad" == 0 ]] \
  && pass "across all ${n} committed states, marker-present ALWAYS implies zero active cron" \
  || fail "${bad} committed state(s) carried a marker beside active cron: $(cat "$STATEDIR/commits.log")"

echo "-- a hypothetical restore on each side of every commit --"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; NONCE="$(cat "$nonce_file")"
take_restore_point; clone_gate preflight "$CLONE_URL" --clone
[[ $? -eq 0 ]] && pass "restore point INSIDE the armed window: accepted" || fail "armed-window restore rejected: $(tail -2 "$ROOT/c.txt")"
echo sealing > "$STATEDIR/clone/MSTATE"; clone_gate preflight "$CLONE_URL" --clone
[[ $? -ne 0 ]] && pass "restore point BEFORE the arm commit (marker still 'sealing'): refused" || fail "un-armed restore accepted"
take_restore_point; rm -f "$STATEDIR/clone/MARKER" "$STATEDIR/clone/MSTATE" "$STATEDIR/clone/FENCE"
clone_gate preflight "$CLONE_URL" --clone
[[ $? -ne 0 ]] && pass "restore point BEFORE the seal commit (no marker, no fence): refused" || fail "pre-seal restore accepted"
take_restore_point; run bash "$RR" clone-source-resume --yes "$PROD_URL"
rm -rf "$STATEDIR/clone"; mkdir -p "$STATEDIR/clone"; cp "$STATEDIR/jobs" "$STATEDIR/clone/"
clone_gate preflight "$CLONE_URL" --clone
[[ $? -ne 0 ]] && pass "restore point AFTER the resume commit (marker gone, cron live): refused" || fail "post-resume restore accepted"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; NONCE="$(cat "$nonce_file")"
take_restore_point; rm -f "$STATEDIR/clone/FENCE"
clone_gate preflight "$CLONE_URL" --clone
[[ $? -ne 0 ]] && pass "a clone whose FENCE is missing is refused (its restore point is outside the window)" || fail "unfenced clone accepted"
take_restore_point; printf 'deadbeefdeadbeefdeadbeefdeadbeef\n' > "$STATEDIR/clone/MARKER"
clone_gate preflight "$CLONE_URL" --clone
[[ $? -ne 0 ]] && pass "a clone carrying a DIFFERENT run's marker is refused (exact nonce)" || fail "foreign marker accepted"
take_restore_point; rm -f "$STATEDIR/clone/ACL_LOCKED"
clone_gate preflight "$CLONE_URL" --clone
[[ $? -ne 0 ]] && pass "a clone whose marker objects are reachable by anon/authenticated/service_role is refused" || fail "leaky marker ACLs accepted"
take_restore_point; awk -F'\t' '$1==9{print $1"\t"$2"\t"$3"\t"$4"\tcfg-CHANGED"; next}{print}' "$STATEDIR/clone/jobs" > "$STATEDIR/clone/j2"; mv "$STATEDIR/clone/j2" "$STATEDIR/clone/jobs"
clone_gate preflight "$CLONE_URL" --clone
[[ $? -ne 0 ]] && pass "a clone whose cron CONFIGURATION drifted from the sealed one is refused" || fail "clone config drift accepted"
take_restore_point
for k in C_RUNNING C_NETQ C_HOOK C_OUTTRIG C_FDW; do
  echo 1 > "$STATEDIR/clone/$k"; clone_gate preflight "$CLONE_URL" --clone
  [[ $? -ne 0 ]] && pass "clone with non-zero ${k} is refused" || fail "${k} accepted on the clone"
  rm -f "$STATEDIR/clone/$k"
done
awk -F'\t' 'NR==1{print $1"\t"$2"\ttrue\t"$4"\t"$5; next}{print}' "$STATEDIR/clone/jobs" > "$STATEDIR/clone/j2"; mv "$STATEDIR/clone/j2" "$STATEDIR/clone/jobs"
clone_gate preflight "$CLONE_URL" --clone
[[ $? -ne 0 ]] && pass "a clone with an ACTIVE cron job is refused" || fail "active-cron clone accepted"
take_restore_point
mv "$nonce_file" "$ROOT/n.bak"; clone_gate preflight "$CLONE_URL" --clone
[[ $? -ne 0 ]] && pass "with NO sealed snapshot on file, no clone command may run" || fail "ran without a sealed snapshot"
printf 'not-hex!!\n' > "$nonce_file"; clone_gate preflight "$CLONE_URL" --clone
[[ $? -ne 0 ]] && pass "a malformed recorded nonce is refused" || fail "malformed nonce accepted"
mv "$ROOT/n.bak" "$nonce_file"
for sub in clone-push clone-make-prefix verify-clone clone-unfence; do
  sed -n "/^cmd_${sub//-/_}()/,/^}/p" "$RR" | grep -q 'assert_clone_isolated' \
    && pass "$sub is gated on the isolation assertion" || fail "$sub is NOT gated"
done

echo "-- restoration is exact over EVERY behaviour-bearing field --"
exact_case(){ # $1 = description, $2.. = mutation applied to $STATEDIR/jobs after quiesce
  seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; "$@" >/dev/null
  run bash "$RR" clone-source-resume --yes "$PROD_URL"; }
add_job(){ printf '99\tadded-after-capture\tfalse\tyes\tcfg-99\n' >> "$STATEDIR/jobs"; }
drop_job(){ sed -i.bak '$d' "$STATEDIR/jobs"; rm -f "$STATEDIR/jobs.bak"; }
rename_job(){ awk -F'\t' '$1==9{print $1"\trenamed-worker\t"$3"\t"$4"\t"$5; next}{print}' "$STATEDIR/jobs" > "$STATEDIR/j2"; mv "$STATEDIR/j2" "$STATEDIR/jobs"; }
reid_job(){ awk -F'\t' '$1==9{print "42\t"$2"\t"$3"\t"$4"\t"$5; next}{print}' "$STATEDIR/jobs" > "$STATEDIR/j2"; mv "$STATEDIR/j2" "$STATEDIR/jobs"; }
recfg_job(){ awk -F'\t' '$1==9{print $1"\t"$2"\t"$3"\t"$4"\tcfg-9-CHANGED"; next}{print}' "$STATEDIR/jobs" > "$STATEDIR/j2"; mv "$STATEDIR/j2" "$STATEDIR/jobs"; }
for c in "a job ADDED after capture:add_job" "a job MISSING at resume:drop_job" \
         "a job RENAMED under the same id:rename_job" "a job whose ID CHANGED:reid_job" \
         "a same-id/same-name job whose SCHEDULE, COMMAND, USER, DATABASE or NODE changed:recfg_job"; do
  desc="${c%%:*}"; fn="${c##*:}"
  exact_case "$fn"
  [[ $? -ne 0 ]] && pass "${desc} makes resume fail loudly" || fail "${desc} was silently accepted"
done
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; recfg_job
run bash "$RR" clone-source-resume --yes "$PROD_URL"
[[ "$(actives)" == 0 ]] && pass "…and a failed resume restores NOTHING (one transaction: all or none)" || fail "resume applied partial effects"
grep -q 'production remains paused and fenced with its marker intact' "$ROOT/out.txt" \
  && pass "…and says production is still paused and fenced, so the operator retries" || fail "no actionable failure message"

echo "-- explicit, reviewed stale-window recovery --"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; NONCE="$(cat "$nonce_file")"
echo sealing > "$STATEDIR/MSTATE"    # a run that died between seal and arm
run bash "$RR" clone-source-resume --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "an UN-ARMED window is not resumable by the ordinary path" || fail "un-armed window resumed silently"
run bash "$RR" clone-source-abandon --yes --nonce "$NONCE" "$PROD_URL"; rc=$?
[[ "$rc" -eq 0 ]] && pass "clone-source-abandon recovers it when the operator names the nonce" || fail "abandon failed (exit $rc)"
[[ "$(actives)" == 3 && ! -e "$STATEDIR/FENCE" && ! -s "$STATEDIR/MARKER" ]] && pass "…restoring prior state and removing the fence and marker" || fail "abandon left state behind"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
run bash "$RR" clone-source-abandon --yes --nonce deadbeefdeadbeefdeadbeefdeadbeef "$PROD_URL"
[[ $? -ne 0 ]] && pass "abandon with the WRONG nonce is refused (no window is cleared by accident)" || fail "wrong-nonce abandon accepted"
run bash "$RR" clone-source-abandon --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "abandon without --nonce is refused" || fail "abandon without a nonce accepted"

echo "-- clone-unfence is clone-only and gated --"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; take_restore_point
clone_gate clone-unfence --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "clone-unfence refuses a production URL" || fail "clone-unfence accepted production"
clone_gate clone-unfence --yes "$CLONE_URL"; rc=$?
[[ "$rc" -eq 0 ]] && pass "clone-unfence lifts the barrier on a proven clone" || fail "clone-unfence failed on a clone (exit $rc): $(tail -2 "$ROOT/c.txt")"
[[ ! -e "$STATEDIR/clone/FENCE" && -s "$STATEDIR/clone/MARKER" ]] \
  && pass "…removing only the fence; the marker stays so provenance remains provable" || fail "clone-unfence removed the wrong thing"
[[ -e "$STATEDIR/FENCE" ]] && pass "…and production's own fence is untouched" || fail "clone-unfence touched production"

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
# SQL mutants: the stub enforces exactly the assertions and performs exactly the
# effects the artifact contains, so deleting a statement really does weaken it.
sqlmut(){ local f="$SQLD/$1"; [[ -e "$ROOT/sqlbak/$1" ]] || cp "$f" "$ROOT/sqlbak/$1"
  python3 - "$f" "$2" <<'PYX'
import sys,re
f,pat=sys.argv[1],sys.argv[2]
s=open(f).read(); n=len(re.findall(pat,s,re.M)); assert n==1, (pat,n)
open(f,"w").write(re.sub(pat,"-- MUTANT: statement deleted",s,flags=re.M))
PYX
}
unsqlmut(){ cp "$ROOT/sqlbak/$1" "$SQLD/$1"; }

echo "-- (1) the durable fence --"
# Each artifact is driven DIRECTLY here: a mutation in the seal would otherwise be
# masked by the fence checks in arm, resume and the clone gate, and a mutant that
# a different guard catches proves nothing about the one under test.
seed; artifact clone_source_seal.sql -v "nonce=$NONCE_FIX" -v "expect_fp=$(fp_of_jobs)"
[[ $? -eq 0 && -e "$STATEDIR/FENCE" ]] && pass "baseline: the seal artifact alone installs the fence" || fail "baseline seal did not fence"
attempt_schedule
[[ $? -ne 0 ]] && pass "baseline: a cron.schedule attempt after that seal is rejected" || fail "baseline fence not effective"

# the fence MECHANISM removed: the trigger and the probe that proves it. Both go
# together — with no trigger to install there is nothing for a probe to verify,
# so the claim is scoped to the mechanism as a whole.
sqlmut clone_source_seal.sql "^CREATE TRIGGER rollout_clone_fence_dml\n  BEFORE INSERT OR UPDATE OR DELETE ON cron\.job\n  FOR EACH STATEMENT EXECUTE FUNCTION rollout_clone\.fence_cron_job\(\);$"
sqlmut clone_source_seal.sql "^SELECT pg_temp\.assert_fence_effective\('seal'\);$"
seed; artifact clone_source_seal.sql -v "nonce=$NONCE_FIX" -v "expect_fp=$(fp_of_jobs)"
sealed_rc=$?
attempt_schedule; sched_rc=$?
[[ "$sealed_rc" -eq 0 && "$sched_rc" -eq 0 ]] \
  && pass "MUTANT (fence mechanism removed) SEALS a window in which a job can still be CREATED — the fence, not the commit lock, is what makes the window durable" \
  || fail "fence mutant not distinguishable (seal=$sealed_rc schedule=$sched_rc)"
[[ "$(grep -c 'sneaked-in-job' "$STATEDIR/jobs")" == 1 ]] \
  && pass "…and that job is a real, ACTIVE row a clone would boot and run" || fail "no job row appeared under the mutant"
unsqlmut clone_source_seal.sql

# presence vs effectiveness: with the trigger gone but the PROBE kept, the seal
# must refuse. That is the whole difference the probe makes.
sqlmut clone_source_seal.sql "^CREATE TRIGGER rollout_clone_fence_dml\n  BEFORE INSERT OR UPDATE OR DELETE ON cron\.job\n  FOR EACH STATEMENT EXECUTE FUNCTION rollout_clone\.fence_cron_job\(\);$"
seed; artifact clone_source_seal.sql -v "nonce=$NONCE_FIX" -v "expect_fp=$(fp_of_jobs)"
[[ $? -ne 0 ]] && pass "MUTANT (trigger deleted, probe kept) is REFUSED at the seal — probing is what turns 'the artifact says it fences' into 'the fence works'" || fail "probe did not catch a missing fence"
[[ ! -s "$STATEDIR/MARKER" ]] && pass "…and no marker was committed, so no restore point looks valid" || fail "marker committed without a fence"
unsqlmut clone_source_seal.sql

M="$(mut nofenceable 'assert_source_is_sealable "$inv"||=||:' cmd_clone_source_quiesce)"
seed; echo no > "$STATEDIR/FENCEABLE"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" bash "$M" clone-source-quiesce --yes "$PROD_URL" ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (no sealability check) proceeds on a source where the fence cannot be installed — the read-only check is load-bearing" || fail "nofenceable mutant not distinguishable"
rm -f "$M"

echo "-- (2) the atomic transition --"
sqlmut clone_source_resume.sql "^DROP TRIGGER rollout_clone_fence_dml ON cron\.job;$"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
run bash "$RR" clone-source-resume --yes "$PROD_URL"
[[ -e "$STATEDIR/FENCE" ]] && pass "MUTANT (unfence removed from resume) leaves production FENCED after resume — the unfence must be inside the same transaction" || fail "unfence mutant not distinguishable"
unsqlmut clone_source_resume.sql

sqlmut clone_source_resume.sql "^SELECT pg_temp\.assert_fence_effective\('resume'\);$"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; rm -f "$STATEDIR/FENCE"
run bash "$RR" clone-source-resume --yes "$PROD_URL"
[[ $? -eq 0 ]] && pass "MUTANT (no fence check at resume) resumes a window whose fence had already been dropped — the check is load-bearing" || fail "resume-fence mutant not distinguishable"
unsqlmut clone_source_resume.sql

ARM_DRAIN="^SELECT pg_temp\.assert_eq\(\(SELECT count\(\*\) FROM cron\.job_run_details WHERE status = 'running'\)::bigint, 0::bigint,\n  'zero RUNNING cron executions \(drained\)'\);$"
seed; artifact clone_source_seal.sql -v "nonce=$NONCE_FIX" -v "expect_fp=$(fp_of_jobs)"
echo 3 > "$STATEDIR/RUNNING"
artifact clone_source_arm.sql -v "nonce=$NONCE_FIX"
[[ $? -ne 0 ]] && pass "baseline: the arm artifact refuses to arm with 3 executions still running" || fail "baseline arm accepted a running source"
sqlmut clone_source_arm.sql "$ARM_DRAIN"
artifact clone_source_arm.sql -v "nonce=$NONCE_FIX"
[[ $? -eq 0 && "$(cat "$STATEDIR/MSTATE")" == sealed ]] \
  && pass "MUTANT (drain assertion deleted from arm) ARMS a window with 3 executions still running — the SQL assertion, not just the shell wait, is load-bearing" || fail "arm-drain mutant not distinguishable"
unsqlmut clone_source_arm.sql

sqlmut clone_isolation.sql "^SELECT pg_temp\.assert_eq\(\(SELECT state FROM rollout_clone\.snapshot_marker\), 'sealed',\n  'the clone''s marker is ARMED \(restore point is at/after the arm commit, so in-flight executions had drained\)'\);$"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; take_restore_point; echo sealing > "$STATEDIR/clone/MSTATE"
clone_gate preflight "$CLONE_URL" --clone
[[ $? -eq 0 ]] && pass "MUTANT (armed check deleted) accepts a clone restored BEFORE the arm commit — the state check bounds the window's near edge" || fail "armed-state mutant not distinguishable"
unsqlmut clone_isolation.sql

sqlmut clone_isolation.sql "^SELECT pg_temp\.assert_fence_effective\('clone'\);$"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; take_restore_point; rm -f "$STATEDIR/clone/FENCE"
clone_gate preflight "$CLONE_URL" --clone
[[ $? -eq 0 ]] && pass "MUTANT (clone fence check deleted) accepts a clone from OUTSIDE the fenced window — the fence bounds the window's far edge" || fail "clone-fence mutant not distinguishable"
unsqlmut clone_isolation.sql

echo "-- (3) exact restoration --"
# resume compares the configuration twice: once as a whole-set fingerprint (b) and
# once field-by-field in the FULL OUTER JOIN (e). Deleting either alone is caught
# by the other, so they are mutated TOGETHER and the claim is scoped to that:
# comparing every behaviour-bearing field, somewhere, is load-bearing.
CFG_B="^SELECT pg_temp\.assert_eq\(pg_temp\.cron_config_fp\(\), pg_temp\.snapshot_config_fp\(\),\n  'cron configuration matches the sealed snapshot EXACTLY \(schedule, database, username, command hash and node all included\)'\);$"
CFG_E="^       OR md5\(j\.command\)            IS DISTINCT FROM s\.command_md5$"
sqlmut clone_source_resume.sql "$CFG_B"
sqlmut clone_source_resume.sql "$CFG_E"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; recfg_job
run bash "$RR" clone-source-resume --yes "$PROD_URL"
[[ $? -eq 0 ]] && pass "MUTANT (every configuration comparison deleted) re-enables a job whose COMMAND changed under the same id and name — a same-id/same-name drift is otherwise invisible" || fail "config-compare mutant not distinguishable"
unsqlmut clone_source_resume.sql

SET_E="^SELECT pg_temp\.assert_eq\(\n  \(SELECT count\(\*\)\n     FROM cron\.job j\n     FULL OUTER JOIN rollout_clone\.snapshot_job_state s\n(.|\n)*?  'production cron restored to its EXACT recorded set, configuration and active state'\);$"
sqlmut clone_source_resume.sql "$CFG_B"
sqlmut clone_source_resume.sql "$SET_E"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; add_job
run bash "$RR" clone-source-resume --yes "$PROD_URL"
[[ $? -eq 0 ]] && pass "MUTANT (set-equality proof and the fingerprint compare deleted) resumes with an EXTRA job unnoticed — exact set equality is load-bearing" || fail "set-equality mutant not distinguishable"
unsqlmut clone_source_resume.sql

M="$(mut noval 'validate_source_manifest "$SRC_MANIFEST"||=||:' export_source_manifest)"
seed; echo 1 > "$STATEDIR/EXPORT_TRUNC"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" bash "$M" clone-source-quiesce --yes "$PROD_URL" ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (no manifest validation) accepts an evidence manifest whose final record is truncated — the fail-closed check is load-bearing" || fail "manifest mutant not distinguishable"
rm -f "$M"

echo "-- (4) marker ownership and lifecycle --"
sqlmut clone_source_seal.sql "^SELECT pg_temp\.assert\(\n  \(SELECT count\(\*\) FROM information_schema\.schemata WHERE schema_name = 'rollout_clone'\) = 0,\n  'no prior sealed window exists \(if this fails: a previous run was not resumed — use clone-source-abandon with its nonce\)'\);$"
M="$(mut nopriorwindow '  [[ "$prior" -eq 0 ]] \
    || die "a sealed window ALREADY exists in this database (rollout_clone). Resume it with '"'"'clone-source-resume --yes <url>'"'"', or recover an abandoned one explicitly with '"'"'clone-source-abandon --yes --nonce <its nonce> <url>'"'"'. Nothing is ever overwritten implicitly."||=||  :' assert_source_is_sealable)"
seed; printf 'deadbeefdeadbeefdeadbeefdeadbeef\n' > "$STATEDIR/MARKER"; echo sealed > "$STATEDIR/MSTATE"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" bash "$M" clone-source-quiesce --yes "$PROD_URL" ) >/dev/null 2>&1
if [[ $? -eq 0 ]] && [[ "$(cat "$STATEDIR/MARKER")" != "deadbeefdeadbeefdeadbeefdeadbeef" ]]; then
  pass "MUTANT (both prior-window guards deleted) OVERWRITES another run's marker — refusing to reuse a window is load-bearing"
else fail "prior-window mutant not distinguishable"; fi
unsqlmut clone_source_seal.sql; rm -f "$M"

sqlmut clone_source_seal.sql "^SELECT pg_temp\.assert\(pg_try_advisory_xact_lock\(431097, 626\),\n  'no other clone-safety quiesce/resume is running \(advisory lock acquired\)'\);$"
seed; echo held > "$STATEDIR/ADVLOCK"
run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
[[ $? -eq 0 ]] && pass "MUTANT (advisory lock deleted) seals while another quiesce is running — run-level exclusion is load-bearing" || fail "advisory-lock mutant not distinguishable"
unsqlmut clone_source_seal.sql

sqlmut clone_source_seal.sql "^REVOKE ALL ON SCHEMA rollout_clone FROM PUBLIC;$"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
[[ ! -e "$STATEDIR/ACL_LOCKED" ]] && pass "MUTANT (REVOKE deleted) leaves the marker objects on ambient default grants — the explicit lockdown is load-bearing" || fail "ACL mutant not distinguishable"
unsqlmut clone_source_seal.sql

sqlmut clone_isolation.sql '^DO \$acl\$\n(.|\n)*?END \$acl\$;$'
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; take_restore_point; rm -f "$STATEDIR/clone/ACL_LOCKED"
clone_gate preflight "$CLONE_URL" --clone
[[ $? -eq 0 ]] && pass "MUTANT (clone ACL check deleted) accepts a clone whose marker objects are world-readable — verifying ACLs in the CLONE is load-bearing" || fail "clone-ACL mutant not distinguishable"
unsqlmut clone_isolation.sql

echo "-- (5) timing honesty --"
grep -q 'sealed_tx_start' "$SQLD/clone_source_seal.sql" && grep -q 'TRANSACTION START, not the commit instant' "$SQLD/clone_source_seal.sql" \
  && pass "now() is stored as sealed_tx_start and labelled transaction-start, not the commit instant" || fail "now() still presented as the commit instant"
grep -q 'OBSERVED_AFTER_COMMIT' "$SQLD/clone_source_seal.sql" && grep -q 'clock_timestamp' "$SQLD/clone_source_seal.sql" \
  && pass "the informational instant is clock_timestamp() read AFTER the commit" || fail "no post-commit reading"
grep -q 'HH24:MI:SS.US' "$SQLD/clone_source_seal.sql" && pass "it is rendered to microseconds, not truncated to seconds" || fail "still second-resolution"
grep -q 'Provenance is established by the marker nonce in the database, never by a timestamp' "$RR" \
  && pass "the operator is told only the nonce establishes provenance" || fail "no provenance disclaimer"
README="$HERE/../README.md"
# the honest statement must be present, in the artifact AND in the runbook...
grep -q 'releases its \|lock is released at commit\|ends at COMMIT\|ends at commit' "$SQLD/clone_source_seal.sql" \
  && pass "the seal artifact states plainly that its lock ends at COMMIT" || fail "the seal does not say its lock ends at commit"
grep -q 'ends at `COMMIT`' "$README" && pass "the runbook states plainly that the lock ends at COMMIT" || fail "the runbook does not say the lock ends at commit"
# ...and no AFFIRMATIVE claim to the contrary may survive anywhere
aff="$(grep -rihE '(commit lock|the lock) [a-z ]*protect' "$SQLD" "$RR" "$README" 2>/dev/null | grep -vciE 'never claims|does not protect|cannot protect|protects nothing' || true)"
[[ "$aff" -eq 0 ]] && pass "no surviving AFFIRMATIVE claim that the lock protects the window after commit" \
  || fail "${aff} affirmative lock-protection claim(s) survive"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
