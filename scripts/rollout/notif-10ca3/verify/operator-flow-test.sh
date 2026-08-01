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

# `git worktree add` materialises what the PINNED commit actually contains: the
# three 20261006* migration files. That makes "which tree did the push read from"
# a RUNTIME property of the stubs rather than a grep over the script.
cat > "$BIN/git" <<'EOF'
#!/usr/bin/env bash
# the link validator calls `git -C "$WT" status ...`; skip a leading -C <path>
if [[ "${1:-}" == "-C" ]]; then shift 2; fi
case "$1" in
  status) exit 0;;
  fetch|cat-file) exit 0;; rev-parse) echo 0000000000000000000000000000000000000000; exit 0;;
  worktree)
    if [[ "$2" == add ]]; then wt="$4"; mkdir -p "$wt/supabase/migrations"
      printf 'project_id = "%s"\n' "$REF" > "$wt/supabase/config.toml"
      for v in "$V1" "$V2" "$V3"; do printf -- '-- migration %s (pinned tree)\n' "$v" > "$wt/supabase/migrations/${v}_name.sql"; done
      exit 0; fi
    # real `git worktree remove` refuses a path that is not a worktree; the stub
    # must not be able to delete an arbitrary directory (e.g. a mutant's CWD).
    if [[ "$2" == remove ]]; then for a in "$@"; do [[ -d "$a" && "$a" == *rollout-wt-* ]] && rm -rf "$a"; done; exit 0; fi;;
esac
exit 0
EOF
# The CLI reads migrations from the CURRENT DIRECTORY's supabase/migrations, so the
# stub does too: pending = (files visible here) - (ledger). A command that pushes
# from the wrong tree therefore produces the WRONG pending set and dies on
# assert_pending_is_expected — exactly as the real CLI would.
cat > "$BIN/supabase" <<'EOF'
#!/usr/bin/env bash
L="$STATEDIR/ledger"
if [[ "$1" == link ]]; then
  # the rollout worktree links itself before any linked push; write the pooler
  # metadata the validator requires
  t="$PWD/supabase/.temp"; mkdir -p "$t"
  printf '%s' "$REF" > "$t/project-ref"
  printf 'postgresql://postgres.%s@aws-1-eu-central-1.pooler.supabase.com:5432/postgres' "$REF" > "$t/pooler-url"
  echo "$PWD" >> "$STATEDIR/link_cwd"
  exit 0
fi
if [[ "$1" == db && "$2" == push ]]; then
  src=""
  for f in supabase/migrations/*.sql; do
    [[ -e "$f" ]] || continue; b="${f##*/}"; src="$src ${b%%_*}"
  done
  cur=",$(cat "$L" 2>/dev/null),"; pend=""
  for v in $src; do case "$cur" in *",$v,"*) : ;; *) pend="$pend $v";; esac; done
  if printf '%s ' "$@" | grep -q -- '--dry-run'; then
    for v in $pend; do printf '  %s_name.sql\n' "$v" >&2; done
    exit 0
  fi
  echo "$PWD"           >> "$STATEDIR/push_cwd"
  echo "${src# }"       >> "$STATEDIR/push_src"
  echo "${pend# }"      >> "$STATEDIR/push_pending"
  [[ "$(cat "$STATEDIR/PUSH_FAILS" 2>/dev/null)" == 1 ]] && exit 1
  all=""
  for v in $(cat "$L" 2>/dev/null | tr ',' ' ') $pend; do all="$all$v\n"; done
  printf "$all" | sed '/^$/d' | sort -u | tr '\n' ',' | sed 's/,$//' > "$L"
  echo "Finished supabase db push."; exit 0
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
# clone commands are gated on assert_clone_isolated; seed the approved inert
# snapshot up-front so every gated invocation below exercises clone behaviour.
APPROVED_TS="2026-08-01T18:00:00Z"
mkdir -p "$EVID"; printf '%s\n' "$APPROVED_TS" > "$EVID/clone-source-timestamp.txt"
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

echo "== resume615 refuses an unbounded cap BEFORE touching the gate =="
run_caps(){ # $1 CAP_STMT  $2 CAP_LOCK — prefix1 clone, gate currently OFF
  rm -rf "$STATEDIR"; mkdir -p "$STATEDIR"
  printf '%s' "$V1" > "$STATEDIR/ledger"; printf 'off' > "$STATEDIR/gate"
  printf 'ok' > "$STATEDIR/DRAIN_EVIDENCE"; printf 'ok' > "$STATEDIR/MANIFEST_MODE"; place_pre
  PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" PROD_CONN_URL="$PROD" \
    MANAGER_TOKEN=x SUPABASE_ACCESS_TOKEN=x SUPABASE_DB_PASSWORD=x CAP_STMT="$1" CAP_LOCK="$2" \
    bash "$RR" resume615 --yes >/dev/null 2>&1; }
run_caps 0 3000; rc=$?
[[ "$rc" -ne 0 ]] && pass "resume615[CAP_STMT=0]: refuses (0 disables statement_timeout)" || fail "resumed with CAP_STMT=0"
[[ "$(cat "$STATEDIR/ledger")" == "$V1" ]] && pass "resume615[CAP_STMT=0]: no suffix push" || fail "ledger advanced to $(cat "$STATEDIR/ledger")"
[[ "$(cat "$STATEDIR/gate")" == off ]] && pass "resume615[CAP_STMT=0]: the maintenance gate was never touched" || fail "gate=$(cat "$STATEDIR/gate")"
run_caps 30000 0; rc=$?
[[ "$rc" -ne 0 ]] && pass "resume615[CAP_LOCK=0]: refuses (unbounded lock wait)" || fail "resumed with CAP_LOCK=0"
[[ "$(cat "$STATEDIR/gate")" == off ]] && pass "resume615[CAP_LOCK=0]: the gate was never touched" || fail "gate=$(cat "$STATEDIR/gate")"
run_caps 30000 3000; rc=$?
[[ "$rc" == 0 && "$(cat "$STATEDIR/ledger")" == "$V1,$V2,$V3" ]] && pass "resume615[valid caps]: still completes (the guard is not over-strict)" || fail "valid caps rejected (exit=$rc)"

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
  # --clone alone is NOT sufficient any more: CLONE_REF must be set, differ from
  # EXPECTED_REF, and match the URL exactly.
  ( PATH="$BIN:$PATH" EXPECTED_REF="$REF" bash "$RR" "$sub" "$OTHER" --clone ) >/dev/null 2>&1 \
    && fail "$sub accepted --clone without CLONE_REF" || pass "$sub rejects --clone without CLONE_REF"
  ( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" CLONE_REF=wrongwrongwrongwrong \
      CLONE_SOURCE_TS="2026-08-01T18:00:00Z" bash "$RR" "$sub" "$OTHER" --clone ) >/dev/null 2>&1 \
    && pass "$sub accepts a named clone (CLONE_REF matches the URL, != prod)" || fail "$sub rejected a properly named clone"
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

echo "== clone migration SOURCE: always the reviewed pin, never the current checkout =="
# DURABLE INVARIANT ONLY. "the migrations are absent on origin/main" is a
# TEMPORARY rollout fact — it stops being true the moment apply615 merges #615,
# and asserting it would make this suite fail forever afterwards. What must hold
# for all time is that the clone commands read the REVIEWED PIN and never
# whatever the working checkout happens to contain; that is asserted at RUNTIME
# further down, from a decoy checkout carrying a migration of its own.
source "$HERE/../PINS.env"
MIGS="20261006100000_email_delivery_concurrency_suppression.sql 20261006110000_reconcile_orphan_provider_events.sql 20261006120000_readers_canonical_is_suppressed.sql"
present_at_pin=0
for m in $MIGS; do
  git -C "$HERE/../../../.." cat-file -e "$PR615_SHA:supabase/migrations/$m" 2>/dev/null && present_at_pin=$((present_at_pin+1))
done
[[ "$present_at_pin" -eq 3 ]] && pass "all 3 migrations are PRESENT at the immutable pin ${PR615_SHA:0:12} (true before AND after #615 merges)" \
                              || fail "expected 3 migrations at the pin, got $present_at_pin"
sed -n '/^cmd_clone_push/,/^}/p' "$RR" | grep -q 'gh pr merge' \
  && fail "clone-push must NEVER merge #615" || pass "clone-push never merges #615"
sed -n '/^cmd_clone_make_prefix/,/^}/p' "$RR" | grep -q 'gh pr merge' \
  && fail "clone-make-prefix must NEVER merge #615" || pass "clone-make-prefix never merges #615"

echo "== clone identity (CLONE_REF) on clone-only commands =="
CLONE_REF_OK=zzzzzzzzzzzzzzzzzzzz
CLONE_URL="postgresql://postgres@db.${CLONE_REF_OK}.supabase.co/postgres"
PROD_URL="postgresql://postgres@db.${REF}.supabase.co/postgres"
( PATH="$BIN:$PATH" EXPECTED_REF="$REF" bash "$RR" verify-clone "$CLONE_URL" ) >/dev/null 2>&1 \
  && fail "verify-clone ran WITHOUT --clone" || pass "verify-clone requires explicit --clone"
( PATH="$BIN:$PATH" EXPECTED_REF="$REF" bash "$RR" verify-clone "$CLONE_URL" --clone ) >/dev/null 2>&1 \
  && fail "verify-clone ran without CLONE_REF" || pass "verify-clone requires CLONE_REF"
( PATH="$BIN:$PATH" EXPECTED_REF="$REF" CLONE_REF="$REF" bash "$RR" verify-clone "$PROD_URL" --clone ) >/dev/null 2>&1 \
  && fail "verify-clone accepted CLONE_REF == EXPECTED_REF (production!)" \
  || pass "verify-clone rejects CLONE_REF == EXPECTED_REF (refuses production)"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" CLONE_SOURCE_TS="2026-08-01T18:00:00Z" EXPECTED_REF="$REF" CLONE_REF="$CLONE_REF_OK" bash "$RR" verify-clone "$PROD_URL" --clone ) >/dev/null 2>&1 \
  && fail "verify-clone accepted the PRODUCTION url under --clone" \
  || pass "verify-clone rejects the production URL even with --clone"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" CLONE_SOURCE_TS="2026-08-01T18:00:00Z" EXPECTED_REF="$REF" CLONE_REF="$CLONE_REF_OK" bash "$RR" clone-push --yes "$PROD_URL" ) >/dev/null 2>&1 \
  && fail "clone-push accepted the production URL" || pass "clone-push rejects the production URL"
( PATH="$BIN:$PATH" EXPECTED_REF="$REF" CLONE_REF="$REF" bash "$RR" clone-push --yes "$PROD_URL" ) >/dev/null 2>&1 \
  && fail "clone-push accepted CLONE_REF == EXPECTED_REF" || pass "clone-push rejects CLONE_REF == EXPECTED_REF"
for sub in preflight postflight ledger-status rollback615; do
  ( PATH="$BIN:$PATH" EXPECTED_REF="$REF" bash "$RR" "$sub" "$OTHER" ) >/dev/null 2>&1 \
    && fail "$sub ACCEPTED a wrong-ref URL" || pass "$sub rejects a wrong-ref URL (identity-guarded)"
done
# MUTANT: --clone degraded back to a plain skip
sed 's|    assert_clone_url "\$1"          # NOT a skip.*|    true|' "$RR" > "$HERE/../.mutant-clone.sh"
( PATH="$BIN:$PATH" EXPECTED_REF="$REF" bash "$HERE/../.mutant-clone.sh" ledger-status "$OTHER" --clone ) >/dev/null 2>&1 \
  && pass "MUTANT (--clone skips identity) accepts a wrong-ref URL — assert_clone_url is load-bearing" \
  || fail "MUTANT still rejected — clone guard may not be load-bearing"
rm -f "$HERE/../.mutant-clone.sh"

echo "== clone command matrix (RUNTIME: real subcommands, stubbed gh/git/supabase/psql) =="
# Every case below RUNS run-rollout.sh. The supabase stub derives the pending set
# from the migration files visible in ITS CWD, exactly like the real CLI, so
# "which tree was pushed" and "which suffix was applied" are OBSERVED, not
# grepped — the class of bug a static grep missed.
DECOY="$ROOT/decoy"; mkdir -p "$DECOY/supabase/migrations"
printf -- '-- decoy: must never be applied to a clone\n' > "$DECOY/supabase/migrations/29991231235959_decoy_from_checkout.sql"
seed_clone(){ # $1 ledger  $2 #615 head sha  $3 checks(green|red)
  rm -rf "$STATEDIR"; mkdir -p "$STATEDIR"
  printf '%s' "$1" > "$STATEDIR/ledger"
  printf '%s' "$2" > "$STATEDIR/rec_head"; printf '%s' "$3" > "$STATEDIR/rec_checks"; }
# clone commands are gated on assert_clone_isolated: it needs the approved inert
# snapshot on file plus a matching CLONE_SOURCE_TS. Seed both so these tests
# exercise the clone behaviour; the gate itself is proven in clone-safety-test.sh.
clone_run(){ # run a clone subcommand FROM THE DECOY CHECKOUT
  ( cd "$DECOY" && PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" \
      CLONE_REF="$CLONE_REF_OK" CLONE_SOURCE_TS="$APPROVED_TS" CAP_STMT=30000 \
      bash "$RR" "$@" ) >/dev/null 2>&1; }
ledger_now(){ cat "$STATEDIR/ledger" 2>/dev/null; }
pushed_from(){ cat "$STATEDIR/push_cwd" 2>/dev/null; }
pushed_pending(){ cat "$STATEDIR/push_pending" 2>/dev/null; }
no_push(){ [[ ! -f "$STATEDIR/push_cwd" ]]; }

seed_clone "" "$PR615_SHA" green; clone_run clone-push --yes "$CLONE_URL"; rc=$?
[[ "$rc" == 0 ]] && pass "clone-push[none]: pristine clone migrates (exit 0)" || fail "clone-push[none] exit=$rc"
[[ "$(ledger_now)" == "$V1,$V2,$V3" ]] && pass "clone-push[none]: ledger -> all" || fail "ledger=$(ledger_now)"
[[ "$(pushed_pending)" == "$V1 $V2 $V3" ]] && pass "clone-push[none]: applied exactly V1,V2,V3" || fail "pending=$(pushed_pending)"
[[ "$(pushed_from)" == *rollout-wt-* ]] && pass "clone-push sources the PINNED WORKTREE, not the checkout it was launched from" || fail "pushed from $(pushed_from)"
[[ "$(cat "$STATEDIR/push_src" 2>/dev/null)" == "$V1 $V2 $V3" ]] \
  && pass "clone-push saw only the 3 pinned files (the decoy migration in the checkout was ignored)" \
  || fail "source set = $(cat "$STATEDIR/push_src" 2>/dev/null)"

seed_clone "$V1" "$PR615_SHA" green; clone_run clone-push --yes "$CLONE_URL"; rc=$?
[[ "$rc" == 0 ]] && pass "clone-push[prefix1]: RESUMES a legitimately partial clone (the rehearsal-C blocker)" || fail "clone-push[prefix1] exit=$rc"
[[ "$(pushed_pending)" == "$V2 $V3" ]] && pass "clone-push[prefix1]: applied exactly the V2,V3 suffix" || fail "pending=$(pushed_pending)"
[[ "$(ledger_now)" == "$V1,$V2,$V3" ]] && pass "clone-push[prefix1]: ledger -> all" || fail "ledger=$(ledger_now)"

seed_clone "$V1,$V2" "$PR615_SHA" green; clone_run clone-push --yes "$CLONE_URL"; rc=$?
[[ "$rc" == 0 ]] && pass "clone-push[prefix2]: resumes (exit 0)" || fail "clone-push[prefix2] exit=$rc"
[[ "$(pushed_pending)" == "$V3" ]] && pass "clone-push[prefix2]: applied exactly the V3 suffix" || fail "pending=$(pushed_pending)"

seed_clone "$V1,$V2,$V3" "$PR615_SHA" green; clone_run clone-push --yes "$CLONE_URL"; rc=$?
[[ "$rc" == 0 ]] && pass "clone-push[all]: no-op exits 0" || fail "clone-push[all] exit=$rc"
no_push && pass "clone-push[all]: pushed nothing" || fail "clone-push[all] pushed anyway"

seed_clone "$V2" "$PR615_SHA" green; clone_run clone-push --yes "$CLONE_URL"; rc=$?
[[ "$rc" -ne 0 ]] && pass "clone-push[invalid {V2}]: REFUSES a corrupt ledger" || fail "clone-push accepted an invalid ledger"
no_push && pass "clone-push[invalid]: pushed nothing" || fail "clone-push pushed onto a corrupt ledger"

seed_clone "" cccccccccccccccccccccccccccccccccccccccc green; clone_run clone-push --yes "$CLONE_URL"; rc=$?
[[ "$rc" -ne 0 ]] && pass "clone-push[pin drift]: refuses when the #615 head != PR615_SHA" || fail "pin drift accepted"
no_push && pass "clone-push[pin drift]: pushed nothing" || fail "pushed despite pin drift"

seed_clone "" "$PR615_SHA" red; clone_run clone-push --yes "$CLONE_URL"; rc=$?
[[ "$rc" -ne 0 ]] && pass "clone-push[checks red]: refuses an unreviewed migration set" || fail "failing checks accepted"
no_push && pass "clone-push[checks red]: pushed nothing" || fail "pushed with failing checks"

seed_clone "" "$PR615_SHA" green
( cd "$DECOY" && PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" CLONE_SOURCE_TS="$APPROVED_TS" EXPECTED_REF="$REF" CLONE_REF="$CLONE_REF_OK" bash "$RR" clone-push --yes "$CLONE_URL" ) >/dev/null 2>&1
[[ $? -ne 0 ]] && pass "clone-push[no CAP_STMT]: refuses an unbounded push" || fail "pushed without CAP_STMT"
no_push && pass "clone-push[no CAP_STMT]: pushed nothing" || fail "pushed without a statement cap"

# PostgreSQL reads 0 as "no limit", so a present-but-zero cap is an UNBOUNDED push
# wearing a bounded label. Exercised end to end, not just at the validator.
caps_run(){ # $1 CAP_STMT  $2 CAP_LOCK  ; runs clone-push from the decoy checkout
  ( cd "$DECOY" && PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" CLONE_SOURCE_TS="$APPROVED_TS" \
      EXPECTED_REF="$REF" CLONE_REF="$CLONE_REF_OK" \
      CAP_STMT="$1" CAP_LOCK="$2" bash "$RR" clone-push --yes "$CLONE_URL" ) >/dev/null 2>&1; }
seed_clone "" "$PR615_SHA" green; caps_run 0 3000
[[ $? -ne 0 ]] && pass "clone-push[CAP_STMT=0]: refuses (0 disables the timeout in PG)" || fail "pushed with CAP_STMT=0"
no_push && pass "clone-push[CAP_STMT=0]: pushed nothing" || fail "an unbounded push happened"
seed_clone "" "$PR615_SHA" green; caps_run 30000 0
[[ $? -ne 0 ]] && pass "clone-push[CAP_LOCK=0]: refuses (unbounded lock wait)" || fail "pushed with CAP_LOCK=0"
no_push && pass "clone-push[CAP_LOCK=0]: pushed nothing" || fail "an unbounded lock wait was allowed"
seed_clone "" "$PR615_SHA" green; caps_run "3000 -c statement_timeout=0" 3000
[[ $? -ne 0 ]] && pass "clone-push[smuggled -c option]: refuses" || fail "accepted an injected PGOPTIONS option"
no_push && pass "clone-push[smuggled -c option]: pushed nothing" || fail "pushed with an injected option"
seed_clone "" "$PR615_SHA" green; caps_run 30000 3000
[[ $? -eq 0 && "$(ledger_now)" == "$V1,$V2,$V3" ]] && pass "clone-push[valid caps]: still succeeds (the guard is not over-strict)" || fail "valid caps were rejected"

echo "== clone-make-prefix: rehearsal C's prefix is created by the REAL CLI =="
seed_clone "" "$PR615_SHA" green; clone_run clone-make-prefix --yes 1 "$CLONE_URL"; rc=$?
[[ "$rc" == 0 ]] && pass "clone-make-prefix 1: exits 0 on a pristine clone" || fail "exit=$rc"
[[ "$(pushed_pending)" == "$V1" ]] && pass "clone-make-prefix 1: the CLI applied exactly V1 (later files pruned in the worktree)" || fail "pending=$(pushed_pending)"
[[ "$(ledger_now)" == "$V1" ]] && pass "clone-make-prefix 1: ledger == prefix1 (a real ledger row, not a hand-written INSERT)" || fail "ledger=$(ledger_now)"
[[ "$(pushed_from)" == *rollout-wt-* ]] && pass "clone-make-prefix sources the pinned worktree" || fail "pushed from $(pushed_from)"

seed_clone "" "$PR615_SHA" green; clone_run clone-make-prefix --yes 2 "$CLONE_URL"; rc=$?
[[ "$rc" == 0 && "$(ledger_now)" == "$V1,$V2" ]] && pass "clone-make-prefix 2: ledger == prefix2" || fail "exit=$rc ledger=$(ledger_now)"

seed_clone "$V1" "$PR615_SHA" green; clone_run clone-make-prefix --yes 1 "$CLONE_URL"; rc=$?
[[ "$rc" -ne 0 ]] && pass "clone-make-prefix: REFUSES a clone that is not pristine" || fail "manufactured a prefix over existing state"
[[ "$(ledger_now)" == "$V1" ]] && pass "clone-make-prefix: the refusal left the ledger untouched" || fail "ledger=$(ledger_now)"

seed_clone "" "$PR615_SHA" green; clone_run clone-make-prefix --yes 3 "$CLONE_URL"; rc=$?
[[ "$rc" -ne 0 ]] && pass "clone-make-prefix: rejects a depth that is not a legitimate prefix (3)" || fail "depth 3 accepted"
seed_clone "" "$PR615_SHA" green; clone_run clone-make-prefix --yes 1 "$PROD_URL"; rc=$?
[[ "$rc" -ne 0 ]] && pass "clone-make-prefix: rejects the PRODUCTION url" || fail "clone-make-prefix accepted production"

echo "== REHEARSAL C end to end (pristine -> prefix1 -> resumed suffix -> all) =="
seed_clone "" "$PR615_SHA" green
clone_run clone-make-prefix --yes 1 "$CLONE_URL"; rcA=$?; stA="$(ledger_now)"
clone_run clone-push --yes "$CLONE_URL"; rcB=$?; stB="$(ledger_now)"
[[ "$rcA" == 0 && "$stA" == "$V1" ]] && pass "rehearsal C step 1: the clone parks at prefix1" || fail "step1 exit=$rcA ledger=$stA"
[[ "$rcB" == 0 && "$stB" == "$V1,$V2,$V3" ]] && pass "rehearsal C step 2: the suffix applies and the clone reaches all" || fail "step2 exit=$rcB ledger=$stB"

echo "== MUTANTS: the clone source + suffix classification are load-bearing =="
# (i) the pre-fix behaviour — clone-push demanding all three — must FAIL on prefix1
MUTP="$HERE/../.mutant-clone-allthree.sh"
sed 's|assert_pending_is_expected "\$pending" "\$suffix"|assert_pending_is_expected "$pending" "$EXPECTED_VERSIONS"|' "$RR" > "$MUTP"
grep -q 'assert_pending_is_expected "$pending" "$EXPECTED_VERSIONS"' "$MUTP" \
  && pass "mutant (i) built: clone-push demands the full set again" || fail "mutant (i) sed did not apply"
seed_clone "$V1" "$PR615_SHA" green
( cd "$DECOY" && PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" CLONE_SOURCE_TS="$APPROVED_TS" EXPECTED_REF="$REF" CLONE_REF="$CLONE_REF_OK" CAP_STMT=30000 bash "$MUTP" clone-push --yes "$CLONE_URL" ) >/dev/null 2>&1 \
  && fail "MUTANT (demand all three) still accepted a prefix1 clone" \
  || pass "MUTANT (demand all three) CANNOT resume prefix1 — suffix classification is load-bearing"
rm -f "$MUTP"
# (ii) sourcing the CURRENT CHECKOUT instead of the pinned worktree must be caught
MUTS="$HERE/../.mutant-clone-source.sh"
sed 's|^  mk_worktree "\$PR615_SHA".*|  WT="$PWD"|' "$RR" > "$MUTS"
grep -q '^  WT="\$PWD"' "$MUTS" && pass "mutant (ii) built: pinned worktree replaced by the current checkout" || fail "mutant (ii) sed did not apply"
seed_clone "" "$PR615_SHA" green
( cd "$DECOY" && PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" CLONE_SOURCE_TS="$APPROVED_TS" EXPECTED_REF="$REF" CLONE_REF="$CLONE_REF_OK" CAP_STMT=30000 bash "$MUTS" clone-push --yes "$CLONE_URL" ) >/dev/null 2>&1 \
  && fail "MUTANT pushed the checkout's migrations to the clone undetected" \
  || pass "MUTANT (checkout instead of pin) is REJECTED — the decoy set != the pinned set"
no_push && pass "MUTANT never reached a push (nothing from the wrong tree was applied)" || fail "MUTANT applied $(pushed_pending)"
rm -f "$MUTS"

echo "== secure_delete FAILS CLOSED (production helper, not a stand-in) =="
SDIR="$ROOT/sd"; mkdir -p "$SDIR"
# (a) normal path: overwrite+unlink succeeds
F1="$SDIR/ok.txt"; printf 'SECRET-SALT-0123456789' > "$F1"
( secure_delete "$F1" ) >/dev/null 2>&1; rc1=$?
[[ "$rc1" -eq 0 && ! -f "$F1" ]] && pass "secure_delete: success path removes the file (exit 0)" \
                                 || fail "secure_delete success path: exit=$rc1 exists=$([[ -f $F1 ]] && echo yes || echo no)"
# (b) overwrite FAILURE must PRESERVE the file and return non-zero
F2="$SDIR/ro.txt"; printf 'SECRET-SALT-0123456789' > "$F2"; chmod 444 "$F2"
( secure_delete "$F2" ) >/dev/null 2>&1; rc2=$?
if [[ "$rc2" -ne 0 && -f "$F2" ]]; then
  grep -q "SECRET-SALT" "$F2" && pass "secure_delete: overwrite failure PRESERVES the file and returns $rc2" \
                              || fail "file preserved but content already destroyed"
else
  fail "secure_delete failed open: exit=$rc2 exists=$([[ -f $F2 ]] && echo yes || echo no)"
fi
chmod 644 "$F2"; rm -f "$F2"
# (c) MUTANT: restore `dd ... || true` + unconditional rm -> deletes despite overwrite failure
cat > "$ROOT/mutant-sd.sh" <<'MEOF'
secure_delete_mutant() {
  local f="$1" size
  [[ -f "$f" ]] || return 0
  size="$(wc -c < "$f" | tr -d ' ')"
  dd if=/dev/urandom of="$f" bs=65536 count=1 conv=notrunc 2>/dev/null || true
  rm -f "$f"
  return 0
}
MEOF
source "$ROOT/mutant-sd.sh"
F3="$SDIR/mut.txt"; printf 'SECRET-SALT-0123456789' > "$F3"; chmod 444 "$F3"
( secure_delete_mutant "$F3" ) >/dev/null 2>&1; rc3=$?
[[ "$rc3" -eq 0 && ! -f "$F3" ]] && pass "MUTANT (dd||true + unconditional rm) deletes despite overwrite failure — fail-closed is load-bearing" \
                                 || fail "MUTANT did not exhibit the fail-open behaviour (exit=$rc3)"

# (d) UNLINK failure. Forced deterministically with a failing `rm` on PATH so the
# result does not depend on the uid or the filesystem: the overwrite succeeds, the
# unlink does not, and the file therefore STILL EXISTS. That must be reported as a
# failure — an evidence file that is still on disk was not cleaned.
# shred/gshred are ALSO stubbed to fail, so BOTH platforms take the same branch:
# the unlink guard lives in the manual overwrite path (the darwin production
# path), and a working `shred -u` unlinks internally and never reaches it. Ubuntu
# CI ships GNU coreutils and macOS does not, so without these stubs this case
# silently covered only one of the two.
SHREDBIN="$ROOT/noshred"; mkdir -p "$SHREDBIN"
printf '#!/usr/bin/env bash\nexit 1\n' > "$SHREDBIN/shred"
printf '#!/usr/bin/env bash\nexit 1\n' > "$SHREDBIN/gshred"
RMBIN="$ROOT/rmfail"; mkdir -p "$RMBIN"
printf '#!/usr/bin/env bash\necho "rm: Operation not permitted" >&2\nexit 1\n' > "$RMBIN/rm"
chmod +x "$SHREDBIN"/shred "$SHREDBIN"/gshred "$RMBIN"/rm
# the manual overwrite+unlink path must SUCCEED on every platform, not only where
# shred happens to be missing
F0="$SDIR/fallback-ok.txt"; printf 'SECRET-SALT-0123456789' > "$F0"
( PATH="$SHREDBIN:$PATH"; secure_delete "$F0" ) >/dev/null 2>&1; rc0=$?
[[ "$rc0" -eq 0 && ! -f "$F0" ]] && pass "secure_delete: the manual overwrite+unlink path succeeds even where shred exists" \
                                 || fail "forced-fallback success path: exit=$rc0 exists=$([[ -f $F0 ]] && echo yes || echo no)"
F4="$SDIR/unlinkfail.txt"; printf 'SECRET-SALT-0123456789' > "$F4"
( PATH="$RMBIN:$SHREDBIN:$PATH"; secure_delete "$F4" ) >/dev/null 2>&1; rc4=$?
[[ "$rc4" -ne 0 ]] && pass "secure_delete: UNLINK failure returns non-zero ($rc4)" || fail "unlink failure reported success"
[[ -f "$F4" ]] && pass "secure_delete: the file that could not be unlinked still EXISTS (honest state)" || fail "file vanished under a failing rm"
grep -q "SECRET-SALT" "$F4" 2>/dev/null && fail "plaintext survived the overwrite" || pass "secure_delete: the plaintext was destroyed before the failed unlink"
rm -f "$F4"

# (e) the CALLER must not report a clean rollout when a file could not be deleted
rm -rf "$STATEDIR"; mkdir -p "$STATEDIR"
printf '%s,%s,%s' "$V1" "$V2" "$V3" > "$STATEDIR/ledger"; printf 'off' > "$STATEDIR/gate"
place_pre; place_post ok
CE_OUT="$( PATH="$RMBIN:$SHREDBIN:$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" PROD_CONN_URL="$PROD" \
  MANAGER_TOKEN=x SUPABASE_ACCESS_TOKEN=x SUPABASE_DB_PASSWORD=x CAP_STMT=30000 \
  bash "$RR" clean-evidence --yes "$PROD" 2>&1 )"; rc5=$?
[[ "$rc5" -ne 0 ]] && pass "clean-evidence: exits non-zero when the evidence could not be deleted" || fail "clean-evidence exited 0 with undeleted evidence"
grep -q "rollout complete + verified" <<<"$CE_OUT" && fail "clean-evidence printed a FALSE 'cleaned' success" \
  || pass "clean-evidence: no false 'cleaned' success line"
grep -q "could NOT be securely deleted" <<<"$CE_OUT" && pass "clean-evidence: names the failure explicitly" || fail "no diagnostic about the undeleted files"
files_intact && pass "clean-evidence: the undeleted evidence is still on disk (as reported)" || fail "files gone despite the reported failure"

# (f) SYMLINK: never shred a link target (and never report it as cleaned)
LTARGET="$SDIR/real-target.txt"; printf 'REAL-TARGET-CONTENT-KEEPME' > "$LTARGET"
LNK="$SDIR/link.txt"; ln -s "$LTARGET" "$LNK"
( secure_delete "$LNK" ) >/dev/null 2>&1; rc6=$?
[[ "$rc6" -ne 0 ]] && pass "secure_delete: REFUSES a symlink (non-zero)" || fail "secure_delete followed a symlink"
grep -q "REAL-TARGET-CONTENT-KEEPME" "$LTARGET" && pass "secure_delete: the link TARGET was not overwritten" || fail "the symlink target was shredded"
[[ -L "$LNK" ]] && pass "secure_delete: the symlink itself was left in place for the operator" || fail "the symlink was removed"
rm -f "$LNK" "$LTARGET"

# (g) MUTANT: remove the unlink guard -> a failed unlink is reported as success
MUTC="$ROOT/mutant-common-unlink.sh"
sed 's|^  if ! rm -f "$f"; then.*|  rm -f "$f"; if false; then|' "$HERE/../lib/common.sh" > "$MUTC"
grep -q 'rm -f "$f"; if false; then' "$MUTC" && pass "mutant (g) built: unlink guard removed from the real helper" || fail "mutant (g) sed did not apply"
F7="$SDIR/mut-unlink.txt"; printf 'SECRET-SALT-0123456789' > "$F7"
( PATH="$RMBIN:$SHREDBIN:$PATH"; source "$MUTC"; secure_delete "$F7" ) >/dev/null 2>&1; rc7=$?
[[ "$rc7" -eq 0 && -f "$F7" ]] && pass "MUTANT (no unlink guard) reports SUCCESS while the file still exists — the guard is load-bearing" \
                               || fail "MUTANT did not exhibit the fail-open behaviour (exit=$rc7)"
rm -f "$F7" "$MUTC"

echo "== README step-6 recipient override must stay ROW-EXACT =="
# The documented UPDATE runs against PRODUCTION by hand, so its shape is a safety
# control like any guard here. A broad `academy_profile_id AND (profile_id OR
# guest_player_id)` predicate can hit 0 rows (the send silently goes to the real
# player) or several (the restore writes one captured value across all of them).
RM="$HERE/../README.md"
S6="$ROOT/step6.md"; sed -n '/^### Step 6 —/,/^## /p' "$RM" > "$S6"
# the contract, as a predicate, so the SAME checks can be run against mutants
s6_row_exact(){ local f="$1"
  [[ -s "$f" ]] || return 1
  [[ "$(grep -c 'UPDATE public.academy_player_metadata' "$f")" == 2 ]] || return 1   # redirect + restore
  [[ "$(grep -c "^ WHERE id = '<meta id>'" "$f")" == 2 ]] || return 1               # both keyed by the PK
  [[ "$(grep -c '^RETURNING id, billing_email' "$f")" == 2 ]] || return 1           # affected rows visible
  grep -A 3 'UPDATE public.academy_player_metadata' "$f" | grep -q 'OR guest_player_id' && return 1
  grep -q '0 rows → ABORT'  "$f" || return 1                                        # no implicit INSERT
  grep -q '>1 rows → ABORT' "$f" || return 1
  grep -q 'get_invoice_recipient_email' "$f" || return 1                            # the no-edit path first
  return 0; }
[[ -s "$S6" ]] && pass "step-6 section found in the README" || fail "step-6 section not found"
s6_row_exact "$S6" && pass "step 6 is row-exact: 2 UPDATEs, both keyed by academy_player_metadata.id, both RETURNING, 0-row and >1-row aborts, no-edit path offered" \
                   || fail "step-6 override contract violated"
grep -qi 'gitignore' "$S6" && pass "edge-log-lines.txt described as gitignored, not a checked-in sample" || fail "stale evidence wording"
# MUTANTS: each mistake Codex called out must be REJECTED by the predicate
sed "s|^ WHERE id = '<meta id>'\$| WHERE academy_profile_id = 'a' AND (profile_id = 'p' OR guest_player_id = 'g')|" "$S6" > "$ROOT/s6-broador.md"
s6_row_exact "$ROOT/s6-broador.md" && fail "MUTANT broad-OR UPDATE accepted (0 or many rows)" \
                                   || pass "MUTANT (broad OR predicate instead of the PK) is REJECTED"
grep -v '^RETURNING id, billing_email' "$S6" > "$ROOT/s6-noret.md"
s6_row_exact "$ROOT/s6-noret.md" && fail "MUTANT without RETURNING accepted (affected-row count invisible)" \
                                 || pass "MUTANT (no RETURNING) is REJECTED"
grep -v '0 rows → ABORT' "$S6" > "$ROOT/s6-noabort.md"
s6_row_exact "$ROOT/s6-noabort.md" && fail "MUTANT without the zero-match abort accepted" \
                                   || pass "MUTANT (no zero-match ABORT) is REJECTED"

echo "== README step-6 false-green STOPs, screening booleans + exact correlation =="
# Three failure modes return HTTP 200 with NO provider_send_started, so "the UI
# said sent" is not evidence. The candidate query must screen for them up front,
# the STOP table must name them, and every log assertion must bind to THIS
# invocation / THIS invoice — a busy window contains other people's sends.
s6_hardened(){ local f="$1"
  # (a) the three HTTP-200 false greens are named as STOP conditions
  grep -q '"skipped":"recently_sent"'      "$f" || return 1
  grep -q '"error":"email_suppressed"'     "$f" || return 1
  grep -q 'status_update_failed'           "$f" || return 1
  # (b) the read-only candidate query returns all three screening booleans
  grep -q 'AS resolves_to_me'              "$f" || return 1
  grep -q 'AS recent_guard_clear'          "$f" || return 1
  grep -q 'AS recipient_not_suppressed'    "$f" || return 1
  # ...computed with the SAME canonical resolver + suppression function the edge fn uses
  grep -q 'public.is_email_suppressed'     "$f" || return 1
  grep -q 'public.get_invoice_recipient_email' "$f" || return 1
  # ...and never selecting the address itself
  grep -q 'SELECT public.get_invoice_recipient_email(' "$f" && return 1
  # (c) correlation is delegated to the EXECUTABLE verifier, not to prose counts.
  #     A block of `grep -c` calls with "must be exactly 1" written beside them
  #     enforces nothing, so its return is a regression.
  #     Fetch and verification must be ONE command: a separate verifier step can
  #     read a file some EARLIER fetch left behind.
  grep -q -- '--verify-step6-invoice' "$f" || return 1
  grep -q 'exits \*\*0\*\*'             "$f" || return 1
  grep -q 'NO verification happened'    "$f" || return 1
  grep -qE '^ *grep +-c' "$f" && return 1        # a COMMAND, not a prose mention of one
  grep -qE "^ *grep '<invoice uuid>'" "$f" && return 1                    # manual log grep
  grep -q "INVOCATION='<invocationId from that line>'" "$f" && return 1   # hand transcription
  grep -qE '^ *scripts/.*verify-step6-send\.sh --invoice' "$f" && return 1  # separate verifier step
  grep -q 'record_failed'        "$f" || return 1
  grep -q 'status_update_failed' "$f" || return 1
  # (d) delivery status read via the PII-free singular RPC
  grep -q 'get_invoice_delivery_status'    "$f" || return 1
  return 0; }
s6_hardened "$S6" && pass "step 6 names the 3 HTTP-200 false greens, screens all 3 booleans, and correlates by exact invocation+invoice" \
                  || fail "step-6 hardening contract violated"
s6_row_exact "$S6" && pass "the row-exact override + restoration procedure is still intact" \
                   || fail "the row-exact override procedure regressed"
# MUTANTS — each omission Codex asked to pin must be REJECTED
for pat in '"skipped":"recently_sent"' '"error":"email_suppressed"' 'AS recent_guard_clear' 'AS recipient_not_suppressed' 'AS resolves_to_me'; do
  grep -v -F "$pat" "$S6" > "$ROOT/s6-drop.md"
  s6_hardened "$ROOT/s6-drop.md" && fail "MUTANT dropping '$pat' accepted" \
                                 || pass "MUTANT (drops '$pat') is REJECTED"
done
# reverting to the unenforced grep/count prose must not pass
{ grep -v -- '--verify-step6-invoice' "$S6"
  printf '%s\n' "INVOCATION='<invocationId from that line>'" \
    'grep -c "event:provider_send_started.*$INVOCATION" "$LINES"   # must be exactly 1'; } > "$ROOT/s6-greps.md"
s6_hardened "$ROOT/s6-greps.md" && fail "MUTANT reverting to unenforced grep counts accepted" \
                                || pass "MUTANT (manual grep counts + hand-transcribed INVOCATION) is REJECTED"
# re-exposing the raw recipient address in the candidate query must not pass
{ cat "$S6"; echo "SELECT public.get_invoice_recipient_email('<invoice uuid>');"; } > "$ROOT/s6-pii.md"
s6_hardened "$ROOT/s6-pii.md" && fail "MUTANT selecting the raw recipient address accepted" \
                              || pass "MUTANT (bare address SELECT) is REJECTED"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
