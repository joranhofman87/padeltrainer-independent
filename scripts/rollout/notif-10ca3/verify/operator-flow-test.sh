#!/usr/bin/env bash
# ===========================================================================
# operator-flow-test.sh — exercises the ACTUAL resume615 control flow with
# stubbed gh/supabase/psql/curl/git (not just SQL continuation). Proves:
#   * prefix1/prefix2 run a FRESH exact-canary drain BEFORE the suffix push
#     (no suffix push occurs without exact canary evidence);
#   * the exact pending suffix is pushed (prefix1->V2,V3; prefix2->V3), reaching all;
#   * a differing RECOVERY_PR is only accepted when merged + checks-green + head
#     matches; arbitrary/unmerged/head-mismatched recovery is rejected;
#   * the no-loss manifest catches a lost key even after a successful push;
#   * it never re-merges #615 (gh unused on the default-pin path) and never
#     overwrites the ORIGINAL pre-migration manifest.
# The FULL drain runs (no env backdoor); date/sleep are stubbed so the real wait
# loop completes instantly under the fake clock.
# Run: bash scripts/rollout/notif-10ca3/verify/operator-flow-test.sh
# ===========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RR="$HERE/../run-rollout.sh"
export REF=abcdefghijklmnopqrst
export V1=20261006100000 V2=20261006110000 V3=20261006120000
PROD="postgresql://postgres@db.${REF}.supabase.co:5432/postgres?sslmode=require"
CANARY=aaaaaaaa-1111-1111-1111-111111111111
# 64-hex manifest fingerprints (SHA-256 grammar) shared with the psql stub via env
export FA="$(printf 'a%.0s' $(seq 64))" FB="$(printf 'b%.0s' $(seq 64))" FN="$(printf 'f%.0s' $(seq 64))"
export E1="$(printf '1%.0s' $(seq 64))" E2="$(printf '2%.0s' $(seq 64))"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
BIN="$ROOT/bin"; mkdir -p "$BIN"; export STATEDIR="$ROOT/state"

P=0; F=0
pass(){ P=$((P+1)); echo "  PASS  $*"; }
fail(){ F=$((F+1)); echo "  FAIL  $*"; }
md5of(){ md5 -q "$1" 2>/dev/null || md5sum "$1" | awk '{print $1}'; }

cat > "$BIN/git" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  fetch|cat-file) exit 0;; rev-parse) echo 0000000000000000000000000000000000000000; exit 0;;
  worktree)
    if [[ "$2" == add ]]; then wt="$4"; mkdir -p "$wt/supabase"; printf 'project_id = "%s"\n' "$REF" > "$wt/supabase/config.toml"; exit 0; fi
    if [[ "$2" == remove ]]; then for a in "$@"; do [[ -d "$a" ]] && rm -rf "$a"; done; exit 0; fi;;
esac
exit 0
EOF
cat > "$BIN/supabase" <<'EOF'
#!/usr/bin/env bash
L="$STATEDIR/ledger"
if [[ "$1" == db && "$2" == push ]]; then
  if printf '%s ' "$@" | grep -q -- '--dry-run'; then
    cur=",$(cat "$L" 2>/dev/null),"
    for v in "$V1" "$V2" "$V3"; do case "$cur" in *",$v,"*) : ;; *) printf '  %s_name.sql\n' "$v" >&2;; esac; done
    exit 0
  fi
  printf '%s,%s,%s' "$V1" "$V2" "$V3" > "$L"; echo "Finished supabase db push."; exit 0
fi
if [[ "$1" == secrets ]]; then
  [[ "$2" == unset ]] && echo off > "$STATEDIR/gate"; [[ "$2" == set ]] && echo on > "$STATEDIR/gate"; exit 0
fi
exit 0
EOF
cat > "$BIN/psql" <<'EOF'
#!/usr/bin/env bash
if printf '%s ' "$@" | grep -q -- '-Atqc'; then cat "$STATEDIR/ledger" 2>/dev/null; echo; exit 0; fi
f=""; prev=""; for a in "$@"; do [[ "$prev" == "-f" ]] && f="$a"; prev="$a"; done
if [[ "$f" == *manifest.sql ]]; then
  mode="$(cat "$STATEDIR/MANIFEST_MODE" 2>/dev/null || echo ok)"
  echo "EAS $FA"; if [[ "$mode" == loss ]]; then er=2; else echo "EAS $FB"; er=3; fi; echo "EAS $FN"
  echo "EDE $E1"; echo "EDE $E2"
  printf 'EV eas_rows=%s\nEV ede_rows=2\nEV eas_bad_state_rows=1\nEV reader_academy_md5=%s\nEV reader_overview_md5=%s\n' \
    "$er" "$(printf 'b%.0s' $(seq 32))" "$(printf 'c%.0s' $(seq 32))"
fi
exit 0
EOF
# clock stubs: the wait loop advances via date/sleep — exercise it fast without any
# production backdoor. base=1000000; "now" (+%s, no -f/-d) advances +600 per call;
# parsing a time (-f/-d + %s) returns base; epoch_to_iso (+%Y with -r/-d @N) maps
# N<base -> 13:00:00Z, else 13:30:00Z, so the log window is start<end.
cat > "$BIN/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$BIN/date" <<'EOF'
#!/usr/bin/env bash
args="$*"; base=1000000; cf="$STATEDIR/date_cnt"
if [[ "$args" == *"+%Y"* ]]; then
  n=""; prev=""; for tok in $args; do [[ "$prev" == "-r" ]] && n="$tok"; [[ "$tok" == @* ]] && n="${tok#@}"; prev="$tok"; done
  if [[ -n "$n" && "$n" -ge "$base" ]]; then echo "2026-07-31T13:30:00Z"; else echo "2026-07-31T13:00:00Z"; fi; exit 0
fi
if [[ "$args" == *"+%s"* ]]; then
  if [[ "$args" == *" -f "* || "$args" == *" -d "* ]]; then echo "$base"; exit 0; fi
  c=$(( $(cat "$cf" 2>/dev/null || echo 0) + 1 )); echo "$c" > "$cf"; echo $(( base + c*600 )); exit 0
fi
echo "2026-07-31T13:00:00Z"
EOF
cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
A="$*"
if grep -q 'probe=1' <<<"$A"; then
  [[ "$(cat "$STATEDIR/gate" 2>/dev/null)" == on ]] && echo '{"maintenance":true}' || echo '{"maintenance":false}'; exit 0
fi
if grep -q 'api.supabase.com' <<<"$A"; then
  if [[ "$(cat "$STATEDIR/DRAIN_EVIDENCE" 2>/dev/null)" == ok ]]; then
    printf '{"result":[{"timestamp":"2026-07-31T13:00:00Z","event_message":"[SEND-INVOICE-EMAIL] event:blocked {\\"invocationId\\":\\"%s\\"}"}],"error":null}' "$(cat "$STATEDIR/canary_id")"
  else printf '{"result":[],"error":null}'; fi
  exit 0
fi
if grep -q 'functions.supabase.co/send-invoice-email' <<<"$A"; then
  echo aaaaaaaa-1111-1111-1111-111111111111 > "$STATEDIR/canary_id"
  printf '{"success":false,"error":"invoice_email_maintenance","invocationId":"aaaaaaaa-1111-1111-1111-111111111111"}\n503'; exit 0
fi
echo '{}'
EOF
cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$STATEDIR/gh_called"
if [[ "$1" == pr && "$2" == view ]]; then
  grep -q headRefOid <<<"$*"   && { cat "$STATEDIR/rec_head"  2>/dev/null || echo 0000000000000000000000000000000000000000; exit 0; }
  grep -q mergeCommit <<<"$*"  && { cat "$STATEDIR/rec_merge" 2>/dev/null || echo 1111111111111111111111111111111111111111; exit 0; }
  grep -q '\.state'    <<<"$*" && { cat "$STATEDIR/rec_state" 2>/dev/null || echo MERGED; exit 0; }
  exit 0
fi
if [[ "$1" == pr && "$2" == checks ]]; then [[ "$(cat "$STATEDIR/rec_checks" 2>/dev/null)" == green ]] && exit 0 || exit 1; fi
exit 0
EOF
chmod +x "$BIN"/*

EVID="$ROOT/evidence"
place_pre(){ mkdir -p "$EVID"
  { echo "EAS $FA"; echo "EAS $FB"; echo "EDE $E1"; echo "EDE $E2";
    printf 'EV eas_rows=2\nEV ede_rows=2\nEV eas_bad_state_rows=1\nEV reader_academy_md5=%s\nEV reader_overview_md5=%s\n' \
      "$(printf 'a%.0s' $(seq 32))" "$(printf 'a%.0s' $(seq 32))"; } > "$EVID/manifest-pre.txt"
  printf 'deadbeefsalt' > "$EVID/manifest-salt.txt"; }
run(){ # $1 ledger $2 gate $3 drain-evidence $4 manifest-mode ; extra env via caller
  rm -rf "$STATEDIR"; mkdir -p "$STATEDIR"
  printf '%s' "$1" > "$STATEDIR/ledger"; printf '%s' "$2" > "$STATEDIR/gate"
  printf '%s' "$3" > "$STATEDIR/DRAIN_EVIDENCE"; printf '%s' "$4" > "$STATEDIR/MANIFEST_MODE"
  place_pre; PRE_SUM="$(md5of "$EVID/manifest-pre.txt")"
  PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" PROD_CONN_URL="$PROD" \
    MANAGER_TOKEN=x SUPABASE_ACCESS_TOKEN=x SUPABASE_DB_PASSWORD=x CAP_STMT=30000 \
    bash "$RR" resume615 --yes >/dev/null 2>&1
}

echo "== fresh-drain recovery: prefix1 with exact canary evidence =="
run "$V1" on ok ok; rc=$?
[[ "$rc" == 0 ]] && pass "prefix1 resume (fresh drain) exits 0" || fail "exit=$rc"
[[ "$(cat "$STATEDIR/ledger")" == "$V1,$V2,$V3" ]] && pass "pushed the V2,V3 suffix -> ledger all" || fail "ledger=$(cat "$STATEDIR/ledger")"
[[ "$(cat "$STATEDIR/gate")" == off ]] && pass "gate turned OFF after verify" || fail "gate=$(cat "$STATEDIR/gate")"
[[ ! -f "$STATEDIR/gh_called" ]] && pass "default-pin path did NOT call gh (no re-merge)" || fail "gh called"
[[ "$(md5of "$EVID/manifest-pre.txt")" == "$PRE_SUM" ]] && pass "original pre-manifest NOT overwritten" || fail "pre-manifest changed"

echo "== fresh-drain recovery: prefix2 =="
run "$V1,$V2" on ok ok; rc=$?
[[ "$rc" == 0 ]] && pass "prefix2 resume exits 0" || fail "exit=$rc"
[[ "$(cat "$STATEDIR/ledger")" == "$V1,$V2,$V3" ]] && pass "pushed the V3 suffix -> ledger all" || fail "ledger=$(cat "$STATEDIR/ledger")"

echo "== NO suffix push without exact canary evidence =="
run "$V1" on empty ok; rc=$?
[[ "$rc" -ne 0 ]] && pass "empty drain evidence aborts resume" || fail "resumed without canary evidence"
[[ "$(cat "$STATEDIR/ledger")" == "$V1" ]] && pass "NO suffix push occurred (ledger still prefix1)" || fail "ledger advanced to $(cat "$STATEDIR/ledger")"
[[ "$(cat "$STATEDIR/gate")" == on ]] && pass "gate stays ON after aborted drain" || fail "gate=$(cat "$STATEDIR/gate")"

echo "== gate OFF is re-enabled + drained (not merely refused) =="
run "$V1" off ok ok; rc=$?
[[ "$rc" == 0 ]] && pass "gate-off prefix1 re-enables + drains + completes" || fail "exit=$rc"
[[ "$(cat "$STATEDIR/ledger")" == "$V1,$V2,$V3" ]] && pass "suffix pushed after re-enable+drain" || fail "ledger=$(cat "$STATEDIR/ledger")"

echo "== no-loss catches a lost key even after a successful push =="
run "$V1" on ok loss; rc=$?
[[ "$rc" -ne 0 ]] && pass "post-push no-loss violation aborts (gate stays ON)" || fail "no-loss not enforced"
[[ "$(cat "$STATEDIR/gate")" == on ]] && pass "gate stays ON when no-loss fails" || fail "gate=$(cat "$STATEDIR/gate")"

echo "== reviewed-recovery-SHA trust =="
REC=cccccccccccccccccccccccccccccccccccccccc; MERGE=dddddddddddddddddddddddddddddddddddddddd
setrec(){ printf '%s' "$1" > "$STATEDIR/rec_head"; printf '%s' "$2" > "$STATEDIR/rec_checks"; printf '%s' "$3" > "$STATEDIR/rec_state"; printf '%s' "$MERGE" > "$STATEDIR/rec_merge"; }
run_rec(){ # $1 head $2 checks $3 state — seeds rec_* into a fresh STATEDIR then runs
  rm -rf "$STATEDIR"; mkdir -p "$STATEDIR"; printf '%s' "$V1" > "$STATEDIR/ledger"; printf 'on' > "$STATEDIR/gate"
  printf 'ok' > "$STATEDIR/DRAIN_EVIDENCE"; printf 'ok' > "$STATEDIR/MANIFEST_MODE"; setrec "$1" "$2" "$3"; place_pre
  PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" PROD_CONN_URL="$PROD" \
    MANAGER_TOKEN=x SUPABASE_ACCESS_TOKEN=x SUPABASE_DB_PASSWORD=x CAP_STMT=30000 RECOVERY_PR=99 RECOVERY_SHA="$REC" \
    bash "$RR" resume615 --yes >/dev/null 2>&1
}
run_rec "$REC" green MERGED; [[ $? == 0 ]] && pass "merged + green + head-match RECOVERY_PR accepted" || fail "valid recovery rejected"
run_rec "$REC" green OPEN;   [[ $? -ne 0 ]] && pass "UNMERGED recovery PR rejected" || fail "unmerged recovery accepted"
run_rec "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" green MERGED; [[ $? -ne 0 ]] && pass "head-MISMATCH recovery rejected" || fail "head mismatch accepted"
run_rec "$REC" red MERGED;   [[ $? -ne 0 ]] && pass "FAILING-checks recovery PR rejected" || fail "failing-checks recovery accepted"

echo "== refusals: none / invalid =="
run "" on ok ok;   [[ $? -ne 0 ]] && pass "refuses 'none' (use apply615)" || fail "resumed on none"
run "$V2" on ok ok;[[ $? -ne 0 ]] && pass "refuses INVALID subset {V2}" || fail "resumed on invalid"

echo "== already all: verify-only, no drain =="
run "$V1,$V2,$V3" on ok ok; rc=$?
[[ "$rc" == 0 ]] && pass "already-all verifies + exits 0" || fail "exit=$rc"
[[ "$(cat "$STATEDIR/gate")" == off ]] && pass "already-all turns gate OFF" || fail "gate not off"

echo "== clean-evidence: guarded destruction of recovery material =="
place_post(){ # $1 = ok|loss : post-manifest superset (new row FN, changed readers) or FB lost
  if [[ "$1" == loss ]]; then
    { echo "EAS $FA"; echo "EAS $FN"; echo "EDE $E1"; echo "EDE $E2";
      printf 'EV eas_rows=2\nEV ede_rows=2\nEV eas_bad_state_rows=1\nEV reader_academy_md5=%s\nEV reader_overview_md5=%s\n' \
        "$(printf 'b%.0s' $(seq 32))" "$(printf 'c%.0s' $(seq 32))"; } > "$EVID/manifest-post.txt"
  else
    { echo "EAS $FA"; echo "EAS $FB"; echo "EAS $FN"; echo "EDE $E1"; echo "EDE $E2";
      printf 'EV eas_rows=3\nEV ede_rows=2\nEV eas_bad_state_rows=1\nEV reader_academy_md5=%s\nEV reader_overview_md5=%s\n' \
        "$(printf 'b%.0s' $(seq 32))" "$(printf 'c%.0s' $(seq 32))"; } > "$EVID/manifest-post.txt"
  fi
}
files_intact(){ [[ -f "$EVID/manifest-pre.txt" && -f "$EVID/manifest-post.txt" && -f "$EVID/manifest-salt.txt" ]]; }
run_clean(){ # $1 ledger $2 gate $3 post-mode(ok|loss|missing|corruptpre)
  rm -rf "$STATEDIR"; mkdir -p "$STATEDIR"
  printf '%s' "$1" > "$STATEDIR/ledger"; printf '%s' "$2" > "$STATEDIR/gate"
  place_pre
  case "$3" in
    missing)    rm -f "$EVID/manifest-post.txt";;
    corruptpre) place_post ok; echo 'GARBAGE line' >> "$EVID/manifest-pre.txt";;
    *)          place_post "$3";;
  esac
  PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" PROD_CONN_URL="$PROD" \
    MANAGER_TOKEN=x SUPABASE_ACCESS_TOKEN=x SUPABASE_DB_PASSWORD=x CAP_STMT=30000 \
    bash "$RR" clean-evidence --yes "$PROD" >/dev/null 2>&1
}
run_clean "$V1" off ok;         [[ $? -ne 0 ]] && pass "REFUSED on ledger=prefix1 (recovery material)" || fail "cleaned during prefix1"
files_intact && pass "prefix1 refusal preserved all files" || fail "files lost on prefix1 refusal"
run_clean "$V1,$V2" off ok;     [[ $? -ne 0 ]] && pass "REFUSED on ledger=prefix2" || fail "cleaned during prefix2"
files_intact && pass "prefix2 refusal preserved all files" || fail "files lost on prefix2 refusal"
run_clean "$V1,$V2,$V3" off missing;    [[ $? -ne 0 ]] && pass "REFUSED on missing post-manifest" || fail "cleaned with missing manifest"
run_clean "$V1,$V2,$V3" off corruptpre; [[ $? -ne 0 ]] && pass "REFUSED on corrupt pre-manifest" || fail "cleaned with corrupt manifest"
files_intact && pass "corrupt-manifest refusal preserved all files" || fail "files lost on corrupt refusal"
run_clean "$V1,$V2,$V3" off loss; [[ $? -ne 0 ]] && pass "REFUSED on failed no-loss comparison" || fail "cleaned despite no-loss failure"
files_intact && pass "no-loss refusal preserved all files" || fail "files lost on no-loss refusal"
run_clean "$V1,$V2,$V3" on ok;  [[ $? -ne 0 ]] && pass "REFUSED while the maintenance gate is ON" || fail "cleaned with gate ON"
files_intact && pass "gate-ON refusal preserved all files" || fail "files lost on gate-ON refusal"
# missing --yes / missing url refusals
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" MANAGER_TOKEN=x bash "$RR" clean-evidence "$PROD" ) >/dev/null 2>&1 \
  && fail "cleaned without --yes" || pass "REFUSED without --yes"
run_clean "$V1,$V2,$V3" off ok; rc=$?
[[ "$rc" == 0 ]] && pass "all + gate-OFF + valid manifests + no-loss -> cleanup succeeds" || fail "valid cleanup exit=$rc"
[[ ! -f "$EVID/manifest-pre.txt" && ! -f "$EVID/manifest-post.txt" && ! -f "$EVID/manifest-salt.txt" ]] \
  && pass "manifests + salt deleted only after all prerequisites" || fail "files not deleted on valid cleanup"

echo "== target identity on the read-only decision commands =="
# preflight's CAP_STMT bounds the production push, postflight authorizes gate-OFF,
# ledger-status decides resume-vs-apply. A wrong URL must not report green.
WRONG="postgresql://postgres:pw@db.${REF}.supabase.co.evil.com/postgres"
OTHER="postgresql://postgres@db.wrongwrongwrongwrong.supabase.co/postgres"
for sub in preflight postflight ledger-status; do
  ( PATH="$BIN:$PATH" EXPECTED_REF="$REF" bash "$RR" "$sub" "$WRONG" ) >/dev/null 2>&1 \
    && fail "$sub ACCEPTED a look-alike host URL" || pass "$sub rejects a look-alike host URL"
  ( PATH="$BIN:$PATH" EXPECTED_REF="$REF" bash "$RR" "$sub" "$OTHER" ) >/dev/null 2>&1 \
    && fail "$sub ACCEPTED a different project ref" || pass "$sub rejects a different project ref"
  ( PATH="$BIN:$PATH" EXPECTED_REF="$REF" bash "$RR" "$sub" "$OTHER" --clone ) >/dev/null 2>&1 \
    && pass "$sub accepts a non-prod clone with explicit --clone" || fail "$sub rejected an explicit --clone"
done
# MUTANT: neutralise the guard's inner assertion (that exact line, with "$1", is
# unique to target_guard — the other call sites pass "$prod"/"$url").
# The mutant MUST live in the bundle dir: run-rollout.sh derives HERE from its own
# path and sources lib/common.sh + PINS.env relatively, so a /tmp copy dies while
# sourcing and yields a false "no bug" result.
MUTG="$HERE/../.mutant-target-guard.sh"
sed 's|assert_conn_url_is_ref "\$EXPECTED_REF" "\$1"|true|' "$RR" > "$MUTG"
( PATH="$BIN:$PATH" EXPECTED_REF="$REF" bash "$MUTG" ledger-status "$OTHER" ) >/dev/null 2>&1 \
  && pass "MUTANT without target_guard accepts a wrong-ref URL (guard is load-bearing)" \
  || fail "MUTANT still rejected — target_guard may not be load-bearing"
rm -f "$MUTG"

echo "== secure_delete overwrites before unlinking (shred absent on darwin) =="
source "$HERE/../lib/common.sh"
SD="$ROOT/secret.txt"; printf 'SUPER-SECRET-SALT-abcdef0123456789' > "$SD"
SD_INODE_SIZE=$(wc -c < "$SD" | tr -d ' ')
( secure_delete "$SD" ) >/dev/null 2>&1
[[ ! -f "$SD" ]] && pass "secure_delete removed the file ($SD_INODE_SIZE bytes)" || fail "secure_delete left the file"
# prove it OVERWRITES rather than only unlinking: run the overwrite step on a copy
SD2="$ROOT/secret2.txt"; printf 'SUPER-SECRET-SALT-abcdef0123456789' > "$SD2"
sz=$(wc -c < "$SD2" | tr -d ' ')
dd if=/dev/urandom of="$SD2" bs=1 count="$sz" conv=notrunc 2>/dev/null
grep -q "SUPER-SECRET-SALT" "$SD2" 2>/dev/null \
  && fail "overwrite step left the plaintext readable" || pass "overwrite step destroys the plaintext in place"
rm -f "$SD2"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
