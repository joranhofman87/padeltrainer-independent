#!/usr/bin/env bash
# ===========================================================================
# clone-safety-test.sh — a clone must PROVE its own provenance and inertness.
#
# A Supabase restore copies pg_cron jobs, the pg_net queue, database webhooks,
# Auth data and Vault-readable secrets, so a restored project boots with REAL
# credentials and resumes cron immediately. Production inventory (read-only,
# 2026-08-01) found notification-email-worker and notification-whatsapp-worker
# on */2 issuing outbound HTTP: a naive clone would send real email/WhatsApp to
# real customers within minutes.
#
# Provenance is NOT asserted by the caller. clone-source-quiesce SEALS a snapshot
# boundary inside one locked transaction and commits a marker row; only a restore
# taken between that COMMIT and the resume's unseal carries the marker.
#
# The psql stub INTERPRETS the SQL artifacts (it enforces exactly the assertions
# the artifact text contains), so deleting an assertion FROM THE SQL changes
# behaviour and is genuinely mutation-testable — not merely grepped for.
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
export QUIESCE_WAIT_SECS=0   # the settle loop still runs its 10 iterations, without wall-clock sleep

# --- psql stub --------------------------------------------------------------
# $STATEDIR/jobs rows are:  id <TAB> name <TAB> active <TAB> outbound
cat > "$BIN/psql" <<'EOF'
#!/usr/bin/env bash
args="$*"
f=""; prev=""; nonce=""; expect_fp=""
for a in "$@"; do
  [[ "$prev" == "-f" ]] && f="$a"
  [[ "$a" == nonce=*     ]] && nonce="${a#nonce=}"
  [[ "$a" == expect_fp=* ]] && expect_fp="${a#expect_fp=}"
  prev="$a"
done
sfile(){ cat "$STATEDIR/$1" 2>/dev/null || echo "$2"; }
md5s(){ if command -v md5sum >/dev/null 2>&1; then md5sum | awk '{print $1}'; else md5 -q; fi; }
# fingerprint of the LIVE job set, byte-identical to manifest_fingerprint()
livefp(){ awk -F'\t' '{print $1"\t"$2}' "$STATEDIR/jobs" | sort -n -k1,1 \
          | awk -F'\t' '{ if (n++) printf "\n"; printf "%s:%s", $1, $2 }' | md5s; }
# the stub enforces exactly the assertions the ARTIFACT TEXT contains
has(){ grep -q -- "$1" "$f"; }
boom(){ echo "ERROR:  $1" >&2; exit 3; }

if [[ "$f" == *clone_source_inventory.sql ]]; then
  [[ "$(sfile INV_FAIL 0)" == 1 ]] && { echo "connection failed" >&2; exit 1; }
  while IFS=$'\t' read -r id n act out; do [[ -n "$n" ]] && echo "CRONJOB $n $act $out"; done < "$STATEDIR/jobs"
  echo "RUNNING $(sfile RUNNING 0)";   echo "NETQUEUE $(sfile NETQUEUE 0)"
  echo "HOOKTRIG $(sfile HOOKTRIG 0)"; echo "OUTTRIG $(sfile OUTTRIG 0)"
  echo "FDWSRV $(sfile FDWSRV 0)"
  [[ -s "$STATEDIR/outfns" ]] && while read -r n; do [[ -n "$n" ]] && echo "OUTFN $n"; done < "$STATEDIR/outfns"
  [[ -s "$STATEDIR/exts"   ]] && while read -r n; do [[ -n "$n" ]] && echo "EXT $n";   done < "$STATEDIR/exts"
  echo "VAULTCOUNT 1"; exit 0
fi

if [[ "$f" == *clone_source_seal.sql ]]; then
  # (a) EXACT captured set — only enforced if the artifact still asserts it
  if has ":'expect_fp'"; then          # the ASSERTION, not the header comment
    [[ "$(livefp)" == "$expect_fp" ]] || boom "cron job set at the boundary is NOT the captured set"
  fi
  if has "LOCK TABLE cron.job IN ACCESS EXCLUSIVE MODE"; then :; else echo "WARNING: unlinearized seal" >&2; fi
  has "FROM cron.job WHERE active" && { [[ "$(awk -F'\t' '$3=="true"' "$STATEDIR/jobs" | grep -c . || true)" == 0 ]] || boom "active jobs at the boundary"; }
  has "status = 'running'"         && { [[ "$(sfile RUNNING 0)"  == 0 ]] || boom "running executions at the boundary"; }
  has "net.http_request_queue"     && { [[ "$(sfile NETQUEUE 0)" == 0 ]] || boom "pg_net queue not empty at the boundary"; }
  [[ -n "$nonce" ]] || boom "no nonce"
  printf '%s\n' "$nonce" > "$STATEDIR/MARKER"; livefp > "$STATEDIR/MARKER_FP"
  echo "SEALED_AT 2026-08-01T18:00:00Z"; exit 0
fi

if [[ "$f" == *clone_source_unseal.sql ]]; then
  rm -f "$STATEDIR/MARKER" "$STATEDIR/MARKER_FP"; exit 0
fi

if [[ "$f" == *clone_isolation.sql ]]; then
  if has "table_name = 'snapshot_marker'"; then
    [[ -s "$STATEDIR/CLONE_MARKER" ]] || boom "clone carries no snapshot marker"
  fi
  if has "WHERE nonce = :'nonce'"; then
    [[ "$(cat "$STATEDIR/CLONE_MARKER" 2>/dev/null)" == "$nonce" ]] || boom "clone marker nonce mismatch"
  fi
  if has "matches the set sealed at the snapshot boundary"; then
    [[ "$(sfile CLONE_MARKER_FP x)" == "$(sfile CLONE_FP x)" ]] || boom "clone cron set differs from the sealed set"
  fi
  has "FROM cron.job WHERE active"    && { [[ "$(sfile C_ACTIVE 0)"  == 0 ]] || boom "clone active cron"; }
  has "status = 'running'"            && { [[ "$(sfile C_RUNNING 0)" == 0 ]] || boom "clone running"; }
  has "net.http_request_queue"        && { [[ "$(sfile C_NETQ 0)"    == 0 ]] || boom "clone queue"; }
  has "proname = 'http_request'"      && { [[ "$(sfile C_HOOK 0)"    == 0 ]] || boom "clone webhooks"; }
  has "including nested call paths"   && { [[ "$(sfile C_OUTTRIG 0)" == 0 ]] || boom "clone outbound triggers"; }
  has "pg_foreign_server"             && { [[ "$(sfile C_FDW 0)"     == 0 ]] || boom "clone FDW"; }
  echo "NOTE: clone isolation ok"; exit 0
fi

if [[ "$args" == *-Atqc* ]]; then
  q="${*: -1}"
  case "$q" in
    *"format('JOB"*)
      [[ "$(sfile MANIFEST_FAIL 0)" == 1 ]] && exit 1
      awk -F'\t' '{printf "JOB\t%s\t%s\t%s\n", $1, $2, $3}' "$STATEDIR/jobs"; exit 0;;
    *"alter_job"*"active := false"*)
      [[ "$(sfile PAUSE_FAIL 0)" == 1 ]] && exit 1
      if [[ "$(sfile PARTIAL_PAUSE 0)" == 1 ]]; then
        awk -F'\t' 'NR==1{print; next}{print $1"\t"$2"\tfalse\t"$4}' "$STATEDIR/jobs" > "$STATEDIR/jobs.n"
      else
        awk -F'\t' '{print $1"\t"$2"\tfalse\t"$4}' "$STATEDIR/jobs" > "$STATEDIR/jobs.n"
      fi
      mv "$STATEDIR/jobs.n" "$STATEDIR/jobs"
      # a runtime schedule_*_job firing AFTER the pause, BEFORE the marker
      [[ "$(sfile RUNTIME_ADD 0)" == 1 ]] && printf '99\truntime-arrival\tfalse\tyes\n' >> "$STATEDIR/jobs"
      echo ok; exit 0;;
    *"alter_job("*)
      [[ "$(sfile RESTORE_FAIL 0)" == 1 ]] && exit 1
      want="$(sed -n "s/.*active := \([a-z]*\).*/\1/p" <<<"$q")"
      jid="$(sed -n "s/.*alter_job(\([0-9]*\).*/\1/p" <<<"$q")"
      jnm="$(sed -n "s/.*jobname = '\([^']*\)'.*/\1/p" <<<"$q")"
      awk -F'\t' -v j="$jid" -v nm="$jnm" -v w="$want" \
        '$1==j && $2==nm {print $1"\t"$2"\t"w"\t"$4; next}{print}' "$STATEDIR/jobs" > "$STATEDIR/jobs.n"
      mv "$STATEDIR/jobs.n" "$STATEDIR/jobs"; echo ok; exit 0;;
    *"IS DISTINCT FROM m.want"*)
      # real FULL OUTER JOIN semantics over the VALUES list in the query text
      grep -o "([0-9]*,'[^']*',[a-z]*)" <<<"$q" | tr -d "()'" | tr ',' '\t' > "$STATEDIR/want.tsv"
      awk -F'\t' 'NR==FNR{w[$1"|"$2]=$3; seen[$1"|"$2]=1; next}
                  { k=$1"|"$2; if (!(k in w)) { n++ } else { if ($3 != w[k]) n++; delete seen[k] } }
                  END{ for (k in seen) n++; print n+0 }' "$STATEDIR/want.tsv" "$STATEDIR/jobs"; exit 0;;
    *"FROM cron.job WHERE active"*)  awk -F'\t' '$3=="true"' "$STATEDIR/jobs" | grep -c . || true; exit 0;;
    *"status = 'running'"*)          sfile RUNNING 0; exit 0;;
    *"net.http_request_queue"*)      sfile NETQUEUE 0; exit 0;;
  esac
  echo ""; exit 0
fi
exit 0
EOF
chmod +x "$BIN/psql"

PRODJOBS=$'1\trelease-expired-rebook-holds\ttrue\tno\n9\tnotification-email-worker\ttrue\tyes\n10\tnotification-whatsapp-worker\ttrue\tyes'
seed(){ rm -f "$STATEDIR"/*; printf '%s\n' "$PRODJOBS" > "$STATEDIR/jobs"; }
run(){ ( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" "$@" ) >"$ROOT/out.txt" 2>&1; }
actives(){ awk -F'\t' '$3=="true"' "$STATEDIR/jobs" | grep -c . || true; }
nonce_file="$EVID/clone-source-nonce.txt"

echo "== read-only inventory: safe metadata only, fail closed on the unknown =="
seed; run bash "$RR" clone-source-inventory "$PROD_URL"; rc=$?
[[ "$rc" -eq 0 ]] && pass "inventory of a reviewed job set succeeds" || fail "inventory rejected a reviewed set (exit $rc): $(tail -2 "$ROOT/out.txt")"
grep -qE 'md5|command|http|Bearer|apikey|token' "$EVID/clone-source-inventory.txt" && fail "the inventory artifact contains command/secret-shaped text" \
  || pass "the inventory artifact carries no command, URL, header or secret text"
grep -q 'notification-email-worker' "$ROOT/out.txt" && pass "job names and outbound flags are reported" || fail "no job names reported"
[[ "$(actives)" == 3 ]] && pass "inventory is READ-ONLY: nothing was paused" || fail "inventory mutated state"

seed; printf '77\ta-brand-new-runtime-job\ttrue\tyes\n' >> "$STATEDIR/jobs"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "an UNREVIEWED job (e.g. added at runtime by schedule_*_job) stops the procedure" || fail "unknown job accepted"
seed; awk -F'\t' '$2=="release-expired-rebook-holds"{print $1"\t"$2"\t"$3"\tyes"; next}{print}' "$STATEDIR/jobs" > "$STATEDIR/j2"; mv "$STATEDIR/j2" "$STATEDIR/jobs"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "OUTBOUND CLASSIFICATION DRIFT on a reviewed job stops the procedure" || fail "classification drift accepted"
seed; printf 'public.blast_everyone\n' > "$STATEDIR/outfns"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "an UNREVIEWED outbound-capable function (incl. nested paths) stops the procedure" || fail "unknown OUTFN accepted"
seed; printf 'net.http_post_wrapper\n' > "$STATEDIR/outfns"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "an unreviewed function name is refused even when it looks benign" || fail "unknown OUTFN accepted (2)"
seed; printf 'pg_net\nhttp\n' > "$STATEDIR/exts"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -ne 0 ]] && pass "an UNREVIEWED extension with external capability (http) stops the procedure" || fail "unknown EXT accepted"
seed; printf 'pg_net\npg_cron\n' > "$STATEDIR/exts"
run bash "$RR" clone-source-inventory "$PROD_URL"
[[ $? -eq 0 ]] && pass "the reviewed extension set is accepted" || fail "reviewed EXT set rejected: $(tail -2 "$ROOT/out.txt")"
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

echo "== quiesce: reversible pause, then a SEALED snapshot boundary =="
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
[[ -s "$nonce_file" ]] && pass "a snapshot NONCE was recorded (database-resident provenance, not a caller timestamp)" || fail "no nonce recorded"
grep -qE '^[0-9a-f]{32,}$' "$nonce_file" && pass "the nonce is high-entropy hex" || fail "nonce is not hex"
[[ "$(cat "$nonce_file")" == "$(cat "$STATEDIR/MARKER")" ]] && pass "the marker COMMITTED IN THE DATABASE carries exactly the recorded nonce" || fail "marker/nonce mismatch"
grep -q 'SEALED_AT' "$EVID/clone-source-seal.txt" && pass "the boundary instant is reported for the restore UI" || fail "no SEALED_AT"

echo "-- the seal is the linearization point --"
seed; echo 1 > "$STATEDIR/RUNTIME_ADD"
run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "a job ARRIVING AFTER THE PAUSE but before the marker is caught at the seal" || fail "runtime arrival accepted"
[[ ! -f "$STATEDIR/MARKER" ]] && pass "…and NO marker was committed (no snapshot may be taken)" || fail "marker committed despite a runtime arrival"
grep -q 'ACCESS EXCLUSIVE' "$SQLD/clone_source_seal.sql" && pass "the seal takes ACCESS EXCLUSIVE on cron.job (serialises cron.schedule/alter_job)" || fail "seal is not linearized"
awk '/^BEGIN;/{b=1} /LOCK TABLE cron.job/{ if(b) l=1 } /expect_fp/{ if(l) fp=1 } /^COMMIT;/{ if(fp) ok=1 } END{exit !ok}' "$SQLD/clone_source_seal.sql" \
  && pass "lock, the exact-set assertion and the marker share ONE transaction" || fail "the boundary is not one transaction"

for cond in "RUNNING 2 running cron executions" "NETQUEUE 5 queued pg_net requests"; do
  set -- $cond; key="$1"; val="$2"; shift 2; desc="$*"
  seed; echo "$val" > "$STATEDIR/$key"
  run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
  [[ $? -ne 0 ]] && pass "quiesce refuses with ${desc}" || fail "${desc} accepted"
  [[ "$(actives)" == 3 ]] && pass "…and production was RESTORED, never left paused (${desc})" || fail "production left paused after ${desc}"
  [[ ! -f "$STATEDIR/MARKER" ]] && pass "…and no marker was committed (${desc})" || fail "marker committed despite ${desc}"
done
seed; echo 1 > "$STATEDIR/PARTIAL_PAUSE"
run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "a PARTIAL pause is detected and refused" || fail "partial pause accepted"
[[ "$(actives)" == 3 ]] && pass "…and production was restored after the partial pause" || fail "production left partially paused"
seed; echo 1 > "$STATEDIR/MANIFEST_FAIL"
run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "a failed prior-state capture stops BEFORE anything is paused" || fail "paused without a way back"
[[ "$(actives)" == 3 ]] && pass "…and nothing was paused" || fail "state changed despite a failed manifest"

echo "== resume: EXACT set equality, then unseal =="
seed; printf '1\trelease-expired-rebook-holds\tfalse\tno\n9\tnotification-email-worker\ttrue\tyes\n10\tnotification-whatsapp-worker\ttrue\tyes\n' > "$STATEDIR/jobs"
run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
run bash "$RR" clone-source-resume --yes "$PROD_URL"; rc=$?
[[ "$rc" -eq 0 ]] && pass "resume succeeds" || fail "resume failed (exit $rc): $(tail -3 "$ROOT/out.txt")"
[[ "$(awk -F'\t' '$1==1{print $3}' "$STATEDIR/jobs")" == false ]] \
  && pass "a job that was ALREADY inactive is restored to inactive (not blanket-enabled)" || fail "prior-inactive job was wrongly enabled"
[[ "$(actives)" == 2 ]] && pass "the two previously-active jobs are active again" || fail "actives=$(actives)"
[[ ! -f "$STATEDIR/MARKER" ]] && pass "resume UNSEALS: the marker no longer exists in production" || fail "marker left in production"
[[ -s "$nonce_file" ]] && pass "the nonce file is RETAINED (clones are verified after production resumes)" || fail "nonce discarded at resume"

echo "-- restoration is exact: extras, missing, renamed, drifted, malformed --"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
printf '99\tadded-after-capture\tfalse\tyes\n' >> "$STATEDIR/jobs"
run bash "$RR" clone-source-resume --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "a job ADDED AFTER CAPTURE makes resume fail loudly (extras are never ignored)" || fail "extra job silently ignored"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
sed -i.bak '$d' "$STATEDIR/jobs"; rm -f "$STATEDIR/jobs.bak"
run bash "$RR" clone-source-resume --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "a job MISSING at resume makes resume fail loudly" || fail "missing job ignored"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
awk -F'\t' '$1==9{print $1"\tnotification-email-worker-v2\t"$3"\t"$4; next}{print}' "$STATEDIR/jobs" > "$STATEDIR/j2"; mv "$STATEDIR/j2" "$STATEDIR/jobs"
run bash "$RR" clone-source-resume --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "a job RECREATED/RENAMED under the same id makes resume fail (id+name binding)" || fail "rename accepted"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
awk -F'\t' '$1==9{print "42\t"$2"\t"$3"\t"$4; next}{print}' "$STATEDIR/jobs" > "$STATEDIR/j2"; mv "$STATEDIR/j2" "$STATEDIR/jobs"
run bash "$RR" clone-source-resume --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "a job whose ID CHANGED makes resume fail" || fail "changed id accepted"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; echo 1 > "$STATEDIR/RESTORE_FAIL"
run bash "$RR" clone-source-resume --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "a FAILED restore is loud and non-zero (production may still be paused)" || fail "failed restore reported success"
for bad in $'JOB\t9\tname\tmaybe' $'JOB\tnine\tname\ttrue' $'JOB\t9\tna;me--\ttrue' $'NOPE\t9\tname\ttrue' $'JOB\t9\ta\ttrue\nJOB\t9\tb\tfalse' $'JOB\t9\ta\ttrue\nJOB\t8\ta\tfalse'; do
  seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
  printf '%s\n' "$bad" > "$EVID/clone-source-manifest.txt"
  run bash "$RR" clone-source-resume --yes "$PROD_URL"
  [[ $? -ne 0 ]] && pass "a malformed/duplicated manifest record is refused BEFORE any SQL interpolation ($(head -c 26 <<<"${bad//$'\n'/ }")…)" \
    || fail "manifest accepted: ${bad//$'\n'/ }"
done
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
printf "JOB\t9\tx'; DROP SCHEMA public CASCADE; --\ttrue\n" > "$EVID/clone-source-manifest.txt"
run bash "$RR" clone-source-resume --yes "$PROD_URL"
[[ $? -ne 0 ]] && pass "a quote-bearing job name never reaches psql (grammar validated first)" || fail "injection-shaped name accepted"

echo "== clone-side: provenance PROVEN by the clone's own marker =="
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
NONCE="$(cat "$nonce_file")"
clone_as(){ # $1 = the marker the CLONE carries ('' = none), $2.. = subcommand
  if [[ -n "$1" ]]; then printf '%s\n' "$1" > "$STATEDIR/CLONE_MARKER"; cp "$STATEDIR/MARKER_FP" "$STATEDIR/CLONE_MARKER_FP" 2>/dev/null; cp "$STATEDIR/MARKER_FP" "$STATEDIR/CLONE_FP" 2>/dev/null
  else rm -f "$STATEDIR/CLONE_MARKER" "$STATEDIR/CLONE_MARKER_FP" "$STATEDIR/CLONE_FP"; fi
  ( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$CLONE" \
    CAP_STMT=30000 SUPABASE_DB_PASSWORD=x bash "$RR" "${@:2}" ) >"$ROOT/c.txt" 2>&1; }
clone_as "$NONCE" preflight "$CLONE_URL" --clone
[[ $? -eq 0 ]] && pass "a clone carrying THIS run's marker and no active cron passes the gate" || fail "sealed clone rejected: $(tail -2 "$ROOT/c.txt")"
clone_as "" preflight "$CLONE_URL" --clone
[[ $? -ne 0 ]] && pass "a clone with NO marker is refused (restore point before the seal, or after the unseal)" || fail "unsealed clone accepted"
clone_as "deadbeefdeadbeefdeadbeefdeadbeef" preflight "$CLONE_URL" --clone
[[ $? -ne 0 ]] && pass "a clone carrying a DIFFERENT run's marker is refused (exact nonce)" || fail "foreign marker accepted"
clone_as "$NONCE" preflight "$CLONE_URL" --clone   # re-establish the good clone
echo "a-different-cron-set" > "$STATEDIR/CLONE_FP"   # set AFTER clone_as seeds it
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$CLONE" \
  CAP_STMT=30000 SUPABASE_DB_PASSWORD=x bash "$RR" preflight "$CLONE_URL" --clone ) >"$ROOT/c.txt" 2>&1
[[ $? -ne 0 ]] && pass "a clone whose cron set differs from the one sealed at the boundary is refused" || fail "clone cron-set drift accepted"
for k in C_ACTIVE C_RUNNING C_NETQ C_HOOK C_OUTTRIG C_FDW; do
  echo 1 > "$STATEDIR/$k"
  clone_as "$NONCE" preflight "$CLONE_URL" --clone
  [[ $? -ne 0 ]] && pass "clone with non-zero ${k} is refused" || fail "${k} accepted on the clone"
  rm -f "$STATEDIR/$k"
done
mv "$nonce_file" "$ROOT/n.bak"
clone_as "$NONCE" preflight "$CLONE_URL" --clone
[[ $? -ne 0 ]] && pass "with NO sealed snapshot on file, no clone command may run" || fail "ran without a sealed snapshot"
mv "$ROOT/n.bak" "$nonce_file"
printf 'not-hex!!\n' > "$ROOT/n2"; cp "$nonce_file" "$ROOT/n.bak"; cp "$ROOT/n2" "$nonce_file"
clone_as "$NONCE" preflight "$CLONE_URL" --clone
[[ $? -ne 0 ]] && pass "a malformed recorded nonce is refused" || fail "malformed nonce accepted"
cp "$ROOT/n.bak" "$nonce_file"
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
# SQL mutants: the stub enforces exactly the assertions the artifact contains,
# so deleting one from the artifact really does weaken the check.
sqlmut(){ local f="$SQLD/$1"; cp "$f" "$ROOT/sqlbak/$1"
  python3 - "$f" "$2" <<'PYX'
import sys,re
f,pat=sys.argv[1],sys.argv[2]
s=open(f).read(); n=len(re.findall(pat,s)); assert n==1, (pat,n)
open(f,"w").write(re.sub(pat,"-- MUTANT: assertion deleted",s))
PYX
}
unsqlmut(){ cp "$ROOT/sqlbak/$1" "$SQLD/$1"; }

M="$(mut nogate 'assert_clone_isolated "$url"          # no rehearsal touches a clone that is not provably inert||=||:' cmd_clone_push)"
grep -q '^  :$' "$M" && pass "mutant built: clone-push isolation gate removed" || fail "nogate mutant not applied"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; echo 1 > "$STATEDIR/C_ACTIVE"; rm -f "$STATEDIR/CLONE_MARKER"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF="$CLONE" \
  CAP_STMT=30000 SUPABASE_DB_PASSWORD=x bash "$M" clone-push --yes "$CLONE_URL" ) >"$ROOT/m.txt" 2>&1
grep -q 'clone isolation' "$ROOT/m.txt" && fail "mutant still asserted isolation" \
  || pass "MUTANT (no gate) proceeds against an UNSEALED clone with LIVE cron — the gate is load-bearing"
rm -f "$STATEDIR/C_ACTIVE" "$M"

M="$(mut noreview 'assert_inventory_is_reviewed "$inv"||=||:' cmd_clone_source_quiesce)"
grep -q 'cmd_clone_source_quiesce' "$M" && pass "mutant built: reviewed-inventory check removed from quiesce" || fail "noreview mutant not applied"
seed; printf '77\ta-brand-new-runtime-job\ttrue\tyes\n' >> "$STATEDIR/jobs"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" bash "$M" clone-source-quiesce --yes "$PROD_URL" ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (no completeness check) quiesces with an UNKNOWN job — the check is load-bearing" || fail "noreview mutant not distinguishable"
rm -f "$M"

M="$(mut nodrift '    want="$(reviewed_field "$REVIEWED_JOBS" "$name" 2)"
    [[ "$flag" == "$want" ]] \
      || { warn "CLASSIFICATION DRIFT for ${name}: live outbound='"'"'${flag}'"'"' but reviewed='"'"'${want}'"'"'"; unknown=$((unknown+1)); }||=||    :' assert_inventory_is_reviewed)"
seed; awk -F'\t' '$1==1{print $1"\t"$2"\t"$3"\tyes"; next}{print}' "$STATEDIR/jobs" > "$STATEDIR/j2"; mv "$STATEDIR/j2" "$STATEDIR/jobs"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" bash "$M" clone-source-inventory "$PROD_URL" ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (no drift compare) accepts a job whose outbound class CHANGED — the compare is load-bearing" || fail "nodrift mutant not distinguishable"
rm -f "$M"

M="$(mut nooutfn '    in_reviewed "$REVIEWED_FNS" "$name" \
      || { warn "UNREVIEWED outbound-capable function: ${name}"; unknown=$((unknown+1)); }||=||    :' assert_inventory_is_reviewed)"
seed; printf 'public.blast_everyone\n' > "$STATEDIR/outfns"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" bash "$M" clone-source-inventory "$PROD_URL" ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (no OUTFN review) accepts an unknown outbound function — the OUTFN check is load-bearing" || fail "nooutfn mutant not distinguishable"
rm -f "$M"

M="$(mut noext '    in_reviewed "$REVIEWED_EXTS" "$name" \
      || { warn "UNREVIEWED extension with external capability: ${name}"; unknown=$((unknown+1)); }||=||    :' assert_inventory_is_reviewed)"
seed; printf 'http\n' > "$STATEDIR/exts"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" bash "$M" clone-source-inventory "$PROD_URL" ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (no EXT review) accepts an unknown external-capability extension — the EXT check is load-bearing" || fail "noext mutant not distinguishable"
rm -f "$M"

M="$(mut livefp 'fp="$(manifest_fingerprint "$SRC_MANIFEST")"||=||psql "$url" -v ON_ERROR_STOP=1 -Atqc "SELECT format('"'"'JOB live'"'"')" > "$EVID/live.tsv"; fp="$(manifest_fingerprint "$EVID/live.tsv")"' cmd_clone_source_quiesce)"
seed; echo 1 > "$STATEDIR/RUNTIME_ADD"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" bash "$M" clone-source-quiesce --yes "$PROD_URL" ) >/dev/null 2>&1
[[ $? -eq 0 && -f "$STATEDIR/MARKER" ]] \
  && pass "MUTANT (fingerprint read LIVE instead of from the capture) SEALS a snapshot containing a job that arrived after the pause — binding the seal to the pre-pause manifest is load-bearing" \
  || fail "livefp mutant not distinguishable"
rm -f "$M" "$EVID/live.tsv"

M="$(mut noeq '  mism="$(psql "$url" -v ON_ERROR_STOP=1 -Atqc \
    "SELECT count(*) FROM cron.job j FULL OUTER JOIN (VALUES ${values}) AS m(jobid, jobname, want) ON m.jobid = j.jobid AND m.jobname = j.jobname
      WHERE j.jobid IS NULL OR m.jobid IS NULL OR j.active IS DISTINCT FROM m.want")" \
    || { warn "could not VERIFY the restored state"; return 1; }||=||  mism=0' clone_source_restore)"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; printf '99\tadded-after-capture\tfalse\tyes\n' >> "$STATEDIR/jobs"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" bash "$M" clone-source-resume --yes "$PROD_URL" ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (no set-equality verify) resumes with an EXTRA job unnoticed — exact set equality is load-bearing" || fail "noeq mutant not distinguishable"
rm -f "$M"

M="$(mut noval 'validate_source_manifest "$SRC_MANIFEST" || return 1||=||:' clone_source_restore)"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
printf 'JOB\t9\tmaybe-a-name\tperhaps\n' > "$EVID/clone-source-manifest.txt"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" bash "$M" clone-source-resume --yes "$PROD_URL" ) >"$ROOT/m.txt" 2>&1
grep -q 'manifest line' "$ROOT/m.txt" && fail "noval mutant still validated" \
  || pass "MUTANT (no grammar validation) interpolates an unvalidated state into SQL — validation-before-interpolation is load-bearing"
rm -f "$M"

sqlmut clone_source_seal.sql "SELECT pg_temp\.assert_eq\(\(SELECT count\(\*\) FROM net\.http_request_queue\)::bigint, 0::bigint,\n  'pg_net request queue is EMPTY at the boundary'\);"
seed; echo 5 > "$STATEDIR/NETQUEUE"
run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
[[ $? -eq 0 && -f "$STATEDIR/MARKER" ]] && pass "MUTANT (queue assertion deleted from the seal) SEALS with 5 QUEUED outbound requests — the assertion is load-bearing" || fail "seal-queue mutant not distinguishable"
unsqlmut clone_source_seal.sql

sqlmut clone_source_seal.sql "SELECT pg_temp\.assert_eq\(\n  \(SELECT md5\(string_agg\(jobid::text \|\| ':' \|\| jobname, E'\\\\n' ORDER BY jobid\)\) FROM cron\.job\),\n  :'expect_fp',\n  'cron job set at the boundary is EXACTLY the reviewed/captured set \(no job created since capture\)'\);"
seed; echo 1 > "$STATEDIR/RUNTIME_ADD"
run bash "$RR" clone-source-quiesce --yes "$PROD_URL"
[[ $? -eq 0 && -f "$STATEDIR/MARKER" ]] && pass "MUTANT (exact-set assertion deleted from the seal) SEALS around a job that arrived after the pause — the assertion is load-bearing" || fail "seal-fp mutant not distinguishable"
unsqlmut clone_source_seal.sql

sqlmut clone_isolation.sql "SELECT pg_temp\.assert_eq\(\n  \(SELECT count\(\*\) FROM rollout_clone\.snapshot_marker WHERE nonce = :'nonce'\)::bigint, 1::bigint,\n  'clone carries THIS run''s exact snapshot nonce \(provenance proven by the clone itself\)'\);"
seed; run bash "$RR" clone-source-quiesce --yes "$PROD_URL"; NONCE="$(cat "$nonce_file")"
clone_as "deadbeefdeadbeefdeadbeefdeadbeef" preflight "$CLONE_URL" --clone
[[ $? -eq 0 ]] && pass "MUTANT (exact-nonce assertion deleted) accepts a clone carrying a FOREIGN marker — exact nonce matching is load-bearing" || fail "nonce mutant not distinguishable"
unsqlmut clone_isolation.sql

# The presence check and the exact-nonce check are ONE proof: in real Postgres a
# missing marker table makes the nonce query raise, so deleting presence alone
# proves nothing (a different guard would catch it). They are mutated TOGETHER,
# and the claim is scoped to that: the marker proof as a whole is load-bearing.
sqlmut clone_isolation.sql "SELECT pg_temp\.assert\(\n  \(SELECT count\(\*\) FROM information_schema\.tables\n    WHERE table_schema = 'rollout_clone' AND table_name = 'snapshot_marker'\) = 1,\n  'clone carries the rollout snapshot-marker table \(restored from a SEALED snapshot\)'\);\n\nSELECT pg_temp\.assert_eq\(\n  \(SELECT count\(\*\) FROM rollout_clone\.snapshot_marker WHERE nonce = :'nonce'\)::bigint, 1::bigint,\n  'clone carries THIS run''s exact snapshot nonce \(provenance proven by the clone itself\)'\);"
clone_as "" preflight "$CLONE_URL" --clone
[[ $? -eq 0 ]] && pass "MUTANT (the whole marker proof deleted) accepts a clone with NO marker at all — database-resident provenance is load-bearing" || fail "marker mutant not distinguishable"
unsqlmut clone_isolation.sql

M="$(mut norestore 'clone_source_restore "$url" || warn "AUTOMATIC RESTORE ALSO FAILED — run '"'"'clone-source-resume --yes <url>'"'"' IMMEDIATELY"
    die "clone-source quiesce aborted at the seal (production state restored, or restore attempted and reported above)"||=||die "aborted"' cmd_clone_source_quiesce)"
grep -q 'die "aborted"' "$M" && pass "mutant built: automatic restore removed from the seal-failure path" || fail "norestore mutant not applied"
seed; echo 5 > "$STATEDIR/NETQUEUE"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" bash "$M" clone-source-quiesce --yes "$PROD_URL" ) >/dev/null 2>&1
[[ "$(actives)" == 0 ]] && pass "MUTANT (no auto-restore) LEAVES PRODUCTION PAUSED when the seal fails — the restore path is load-bearing" || fail "norestore mutant not distinguishable"
rm -f "$M"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
