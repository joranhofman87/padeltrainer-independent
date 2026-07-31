#!/usr/bin/env bash
# ===========================================================================
# operator-flow-test.sh — exercises the ACTUAL resume615 operator control flow
# with stubbed gh/supabase/psql/curl/git (not just SQL continuation). Proves:
#   * resume615 pushes the exact pending SUFFIX (prefix1 -> V2,V3; prefix2 -> V3)
#     and reaches ledger=all;
#   * it does NOT re-merge #615 (gh is never invoked) and does NOT overwrite the
#     original pre-migration baseline;
#   * it refuses when the gate is OFF, when the ledger is 'none' or 'invalid';
#   * it turns the gate OFF only after verification.
# Run: bash scripts/rollout/notif-10ca3/verify/operator-flow-test.sh
# ===========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RR="$HERE/../run-rollout.sh"
export REF=abcdefghijklmnopqrst
export V1=20261006100000 V2=20261006110000 V3=20261006120000
PROD="postgresql://postgres@db.${REF}.supabase.co:5432/postgres?sslmode=require"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
BIN="$ROOT/bin"; mkdir -p "$BIN"
export STATEDIR="$ROOT/state"

P=0; F=0
pass(){ P=$((P+1)); echo "  PASS  $*"; }
fail(){ F=$((F+1)); echo "  FAIL  $*"; }
md5of(){ md5 -q "$1" 2>/dev/null || md5sum "$1" | awk '{print $1}'; }

# ---- stubs ----------------------------------------------------------------
cat > "$BIN/git" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  fetch|cat-file) exit 0;;
  rev-parse) echo 0000000000000000000000000000000000000000; exit 0;;
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
  [[ "$2" == unset ]] && echo off > "$STATEDIR/gate"
  [[ "$2" == set   ]] && echo on  > "$STATEDIR/gate"
  exit 0
fi
exit 0
EOF
cat > "$BIN/psql" <<'EOF'
#!/usr/bin/env bash
if printf '%s ' "$@" | grep -q -- '-Atqc'; then cat "$STATEDIR/ledger" 2>/dev/null; echo; exit 0; fi
f=""; prev=""; for a in "$@"; do [[ "$prev" == "-f" ]] && f="$a"; prev="$a"; done
if [[ "$f" == *baseline.sql ]]; then
  printf 'eas_rows=5\nede_rows=3\neas_bad_state_rows=7\nreader_academy_md5=%s\nreader_overview_md5=%s\n' \
    "$(printf 'b%.0s' $(seq 32))" "$(printf 'c%.0s' $(seq 32))"
fi
exit 0
EOF
cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
if printf '%s ' "$@" | grep -q 'probe=1'; then
  [[ "$(cat "$STATEDIR/gate" 2>/dev/null)" == on ]] && echo '{"maintenance":true}' || echo '{"maintenance":false}'
  exit 0
fi
echo '{}'; exit 0
EOF
cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$STATEDIR/gh_called"; exit 0
EOF
chmod +x "$BIN"/*

# ---- driver ---------------------------------------------------------------
EVID="$ROOT/evidence"
place_pre(){ mkdir -p "$EVID"; printf 'eas_rows=5\nede_rows=3\neas_bad_state_rows=1\nreader_academy_md5=%s\nreader_overview_md5=%s\n' \
  "$(printf 'a%.0s' $(seq 32))" "$(printf 'a%.0s' $(seq 32))" > "$EVID/baseline-pre.txt"; }
run_resume(){ # $1 ledger  $2 gate
  rm -rf "$STATEDIR"; mkdir -p "$STATEDIR"; printf '%s' "$1" > "$STATEDIR/ledger"; printf '%s' "$2" > "$STATEDIR/gate"
  place_pre; PRE_SUM="$(md5of "$EVID/baseline-pre.txt")"
  PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" PROD_CONN_URL="$PROD" \
    MANAGER_TOKEN=x SUPABASE_ACCESS_TOKEN=x SUPABASE_DB_PASSWORD=x CAP_STMT=30000 \
    bash "$RR" resume615 --yes >/dev/null 2>&1
}

echo "== resume615: prefix1 (only V1 applied) =="
run_resume "$V1" on; rc=$?
[[ "$rc" == 0 ]] && pass "prefix1 resume exits 0" || fail "prefix1 resume exit=$rc"
[[ "$(cat "$STATEDIR/ledger")" == "$V1,$V2,$V3" ]] && pass "prefix1 -> pushed suffix, ledger now all" || fail "ledger=$(cat "$STATEDIR/ledger")"
[[ "$(cat "$STATEDIR/gate")" == off ]] && pass "prefix1 gate turned OFF after verify" || fail "gate=$(cat "$STATEDIR/gate")"
[[ ! -f "$STATEDIR/gh_called" ]] && pass "prefix1 did NOT re-merge (gh never called)" || fail "gh called: $(cat "$STATEDIR/gh_called")"
[[ "$(md5of "$EVID/baseline-pre.txt")" == "$PRE_SUM" ]] && pass "prefix1 original pre-baseline NOT overwritten" || fail "pre-baseline changed"

echo "== resume615: prefix2 (V1,V2 applied) =="
run_resume "$V1,$V2" on; rc=$?
[[ "$rc" == 0 ]] && pass "prefix2 resume exits 0" || fail "prefix2 resume exit=$rc"
[[ "$(cat "$STATEDIR/ledger")" == "$V1,$V2,$V3" ]] && pass "prefix2 -> pushed V3 suffix, ledger now all" || fail "ledger=$(cat "$STATEDIR/ledger")"
[[ ! -f "$STATEDIR/gh_called" ]] && pass "prefix2 did NOT re-merge (gh never called)" || fail "gh called"

echo "== resume615: refusals =="
run_resume "$V1" off; [[ $? -ne 0 ]] && pass "refuses when the gate is OFF" || fail "resumed with gate OFF"
run_resume "$V2" on;  [[ $? -ne 0 ]] && pass "refuses an INVALID ledger subset ({V2})" || fail "resumed on invalid ledger"
run_resume "" on;     [[ $? -ne 0 ]] && pass "refuses 'none' (directs to apply615)" || fail "resumed on none"

echo "== resume615: already all =="
run_resume "$V1,$V2,$V3" on; rc=$?
[[ "$rc" == 0 ]] && pass "all-applied resume verifies + exits 0" || fail "all resume exit=$rc"
[[ "$(cat "$STATEDIR/gate")" == off ]] && pass "all-applied resume turns gate OFF after verify" || fail "gate not off"
[[ ! -f "$STATEDIR/gh_called" ]] && pass "all-applied resume did NOT re-merge" || fail "gh called"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
