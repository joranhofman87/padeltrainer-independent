#!/usr/bin/env bash
# ===========================================================================
# exit-status-test.sh — the operator script MUST report failure with a non-zero
# exit status. A masked failure is the worst possible defect in a rollout tool:
# an operator (or a wrapper) reads exit 0 and proceeds to the next production
# step believing the previous one succeeded.
#
# TWO INDEPENDENT DEFECTS, both pinned here. They are NOT the same bug:
#
#  (1) THE CAUSE of the reported `phase616` false-success:
#      `: "${VAR:?msg}"` guards. In bash 3.2 a parameter-expansion failure
#      resets $? to 0 BEFORE the EXIT trap runs, so the script prints its fatal
#      message and exits 0. The status is destroyed before ANY trap code can see
#      it — `local rc=$?` cannot recover it, and fixing the trap alone does NOT
#      fix this (isolated experimentally). Only guards that call `die`
#      (explicit `exit 1`) survive. Hence require_env/require_arg.
#      NOTE: this only bites AFTER `trap ... EXIT` is installed; the same guard
#      above the trap line exits 1 correctly, which is why `check-identity`
#      appeared healthy while `phase616` did not.
#
#  (2) A SEPARATE latent defect in cleanup(): returning a FIXED status from the
#      EXIT trap. A bare non-zero last command corrupts SUCCESS into failure
#      (exit 1 on a clean run); the previous `return 0` was an over-correction
#      for that. `local rc=$?` + `exit "$rc"` is correct in both directions and
#      keeps worktree removal best-effort.
#
# Every case runs the REAL run-rollout.sh. Cases that would touch production are
# unreachable: each aborts at an argument/env/identity guard first.
# Run: bash scripts/rollout/notif-10ca3/verify/exit-status-test.sh
# ===========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RR="$HERE/../run-rollout.sh"
REF=abcdefghijklmnopqrst
URL="postgresql://postgres@db.${REF}.supabase.co:5432/postgres?sslmode=require"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

P=0; F=0
pass(){ P=$((P+1)); echo "  PASS  $*"; }
fail(){ F=$((F+1)); echo "  FAIL  $*"; }
expect_nonzero(){ local d="$1"; shift; "$@" >/dev/null 2>&1; local rc=$?
  [[ "$rc" -ne 0 ]] && pass "$d (exit=$rc)" || fail "$d — exit=0, FAILURE WAS MASKED"; }
expect_zero(){ local d="$1"; shift; "$@" >/dev/null 2>&1; local rc=$?
  [[ "$rc" -eq 0 ]] && pass "$d (exit=0)" || fail "$d — exit=$rc, success was corrupted"; }

# stub psql up-front (no system psql on dev machines); used by read-only paths
mkdir -p "$TMP/bin"
cat > "$TMP/bin/psql" <<'EOF'
#!/usr/bin/env bash
printf '%s ' "$@" | grep -q -- '-Atqc' && { echo ""; exit 0; }
exit 0
EOF
chmod +x "$TMP/bin/psql"

echo "== 1. missing required env returns nonzero (the reported blocker) =="
expect_nonzero "phase616 --yes with MANAGER_TOKEN unset" \
  env -u MANAGER_TOKEN EXPECTED_REF="$REF" bash "$RR" phase616 --yes
expect_nonzero "apply615 --yes with MANAGER_TOKEN unset" \
  env -u MANAGER_TOKEN EXPECTED_REF="$REF" bash "$RR" apply615 --yes
expect_nonzero "resume615 --yes with MANAGER_TOKEN unset" \
  env -u MANAGER_TOKEN EXPECTED_REF="$REF" bash "$RR" resume615 --yes
expect_nonzero "clean-evidence --yes with MANAGER_TOKEN unset" \
  env -u MANAGER_TOKEN EXPECTED_REF="$REF" bash "$RR" clean-evidence --yes "$URL"
expect_nonzero "EXPECTED_REF entirely unset" \
  env -u EXPECTED_REF bash "$RR" check-identity

echo "== 2. a failing prerequisite/command under set -e returns nonzero =="
expect_nonzero "malformed EXPECTED_REF (assert_ref_format)" \
  env EXPECTED_REF=NOTAVALIDREF bash "$RR" check-identity
expect_nonzero "look-alike conn URL (identity allow-list)" \
  env EXPECTED_REF="$REF" bash "$RR" check-identity "postgresql://postgres:pw@db.${REF}.supabase.co.evil.com/postgres"
expect_nonzero "preflight with psql absent (require_cmd)" \
  env PATH="/usr/bin:/bin" EXPECTED_REF="$REF" bash "$RR" preflight "$URL"

echo "== 3. explicit die remains nonzero =="
expect_nonzero "prod-mutating step without --yes (require_yes)" \
  env EXPECTED_REF="$REF" bash "$RR" phase616
expect_nonzero "missing required argument (require_arg)" \
  env EXPECTED_REF="$REF" bash "$RR" preflight
expect_nonzero "unknown subcommand (usage -> exit 2)" \
  env EXPECTED_REF="$REF" bash "$RR" not-a-real-subcommand

echo "== 4. successful no-worktree command still returns zero =="
expect_zero "check-identity against a valid direct conn URL" \
  env EXPECTED_REF="$REF" bash "$RR" check-identity "$URL"
expect_zero "rollback615 read-only guidance path (stubbed psql)" \
  env PATH="$TMP/bin:$PATH" EXPECTED_REF="$REF" bash "$RR" rollback615 "$URL"
expect_zero "ledger-status read-only path (stubbed psql)" \
  env PATH="$TMP/bin:$PATH" EXPECTED_REF="$REF" bash "$RR" ledger-status "$URL"

echo "== 5-6. the REAL cleanup(): invocation, success preservation, failure preservation =="
# These drive the PRODUCTION cleanup() text extracted verbatim from run-rollout.sh
# (not a copy that could drift), with:
#   * an EXISTING $WT, so the `-d "$WT"` branch actually executes — a nonexistent
#     path silently skips cleanup and proves nothing;
#   * a stubbed `git` that RECORDS its exact argv and can succeed or fail on demand,
#     so we assert the real `worktree remove --force <WT>` call and can drive a
#     genuine cleanup failure (rm -rf on an ordinary dir tests neither).
cat > "$TMP/bin/git" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GIT_CALL_LOG"
[[ "${GIT_STUB_MODE:-ok}" == "fail" ]] && exit 3
exit 0
EOF
chmod +x "$TMP/bin/git"

# extract the production cleanup() verbatim; harness_body is what runs before exit
run_with_real_cleanup() { # $1 wt  $2 git-mode  $3 body ; echoes exit status
  local wt="$1" mode="$2" body="$3" h="$TMP/harness.sh"
  { echo 'set -Eeuo pipefail'
    printf 'WT=%q\n' "$wt"
    sed -n '/^cleanup() {/,/^}/p' "$RR"      # the REAL function, verbatim
    echo 'trap cleanup EXIT'
    echo "$body"
  } > "$h"
  : > "$GIT_CALL_LOG"
  PATH="$TMP/bin:$PATH" GIT_STUB_MODE="$mode" GIT_CALL_LOG="$GIT_CALL_LOG" bash "$h" >/dev/null 2>&1
  echo $?
}
export GIT_CALL_LOG="$TMP/git_calls.log"
# sanity: the extraction really captured the production function
sed -n '/^cleanup() {/,/^}/p' "$RR" | grep -q 'git worktree remove --force' \
  && pass "extracted the REAL cleanup() from run-rollout.sh (contains git worktree remove --force)" \
  || fail "could not extract production cleanup() — test would be vacuous"

echo "-- 5a. cleanup is really invoked; successful cleanup preserves exit 0 --"
WT1="$(mktemp -d)"
rc="$(run_with_real_cleanup "$WT1" ok ':')"
[[ "$rc" -eq 0 ]] && pass "success + successful cleanup -> exit 0" || fail "successful cleanup corrupted success (exit=$rc)"
if grep -qxF "worktree remove --force $WT1" "$GIT_CALL_LOG"; then
  pass "cleanup invoked git with the exact argv: worktree remove --force <WT>"
else
  fail "cleanup did not invoke 'worktree remove --force $WT1' (log: $(tr '\n' '|' < "$GIT_CALL_LOG"))"
fi
rmdir "$WT1" 2>/dev/null || true

echo "-- 5b. cleanup failing (git exit 3) must NOT turn success into failure --"
WT2="$(mktemp -d)"
rc="$(run_with_real_cleanup "$WT2" fail ':')"
[[ "$rc" -eq 0 ]] && pass "success + FAILING cleanup (git exit 3) -> still exit 0" \
                  || fail "best-effort cleanup failure corrupted success (exit=$rc)"
grep -qxF "worktree remove --force $WT2" "$GIT_CALL_LOG" \
  && pass "the failing cleanup really ran (git invoked)" || fail "failing-cleanup case never invoked git"
rmdir "$WT2" 2>/dev/null || true

echo "-- 6. a DISTINCT original failure status survives a failing cleanup exactly --"
WT3="$(mktemp -d)"
rc="$(run_with_real_cleanup "$WT3" fail 'exit 7')"
[[ "$rc" -eq 7 ]] && pass "original exit 7 + failing cleanup (git exit 3) -> exit 7 exactly" \
                  || fail "expected exit 7, got $rc (cleanup status leaked or masked the original)"
grep -qxF "worktree remove --force $WT3" "$GIT_CALL_LOG" \
  && pass "cleanup ran on the failure path too (git invoked)" || fail "failure path never invoked cleanup"
rmdir "$WT3" 2>/dev/null || true

echo "-- 6b. implicit set -e failure + failing cleanup preserves non-zero --"
WT4="$(mktemp -d)"
rc="$(run_with_real_cleanup "$WT4" fail 'false')"
[[ "$rc" -ne 0 ]] && pass "set -e failure + failing cleanup -> exit $rc (non-zero preserved)" \
                  || fail "cleanup masked an implicit set -e failure"
rmdir "$WT4" 2>/dev/null || true

echo "== MUTATION (1): \${VAR:?} POST-TRAP reintroduces the reported bug =="
# Two constraints on this mutant:
#  * it must target a guard BELOW `trap cleanup EXIT` — above it, ${VAR:?} exits 1
#    correctly (no trap installed yet);
#  * it must live IN THE BUNDLE DIR, because run-rollout.sh derives HERE from its
#    own path and sources lib/common.sh + PINS.env relatively. A copy in /tmp
#    dies while sourcing, long before the trap — a false "no bug" result.
MUT="$HERE/../.mutant-exit-status.sh"
cleanup_mutant() { rm -f "$MUT"; }
trap 'rm -rf "$TMP"; cleanup_mutant' EXIT
sed 's|^  require_env MANAGER_TOKEN "set MANAGER_TOKEN (academy manager JWT)"$|  : "${MANAGER_TOKEN:?set MANAGER_TOKEN}"|' "$RR" > "$MUT"
# The quirk is SHELL-VERSION DEPENDENT: bash 3.2 (the macOS system bash, i.e. what
# the operator actually runs) destroys $? before the EXIT trap; bash 5.x (CI's
# ubuntu runner) preserves it. So we do not hard-code either outcome — we PROBE
# this shell's behaviour with the bare primitive, then require the mutant to match
# it. Either way require_env is correct: section 1 proves the real script exits
# non-zero on BOTH shells, which is the invariant that actually matters.
cat > "$TMP/probe.sh" <<'EOS'
set -Eeuo pipefail
cleanup() { local rc=$?; exit "$rc"; }
trap cleanup EXIT
guard() { : "${NOPE:?missing}"; }
guard
EOS
bash "$TMP/probe.sh" >/dev/null 2>&1; probe_rc=$?
if [[ "$probe_rc" -eq 0 ]]; then
  quirk="yes"; echo "  note  this bash ($BASH_VERSION) DESTROYS \$? before the EXIT trap (the hazard is live here)"
else
  quirk="no";  echo "  note  this bash ($BASH_VERSION) preserves \$? before the EXIT trap (hazard not reproducible here)"
fi
if ! grep -q ':?set MANAGER_TOKEN' "$MUT"; then
  fail "mutant not constructed (phase616 MANAGER_TOKEN guard not found)"
else
  env -u MANAGER_TOKEN EXPECTED_REF="$REF" bash "$MUT" phase616 --yes >/dev/null 2>&1
  erc=$?
  if [[ "$quirk" == "yes" ]]; then
    [[ "$erc" -eq 0 ]] && pass "MUTANT post-trap \${VAR:?} exits 0 here — require_env is load-bearing on this shell" \
                       || fail "MUTANT \${VAR:?} exited $erc — expected the masking bug to reproduce on this shell"
  else
    [[ "$erc" -ne 0 ]] && pass "MUTANT \${VAR:?} exits $erc on this shell (no quirk); require_env retained for bash-3.2 operators" \
                       || fail "MUTANT exited 0 on a shell that preserves \$? — unexpected"
  fi
fi
cleanup_mutant
# the real script must contain NO ${VAR:?} guards at all
if grep -qE '\$\{[A-Za-z_0-9]+:\?' "$RR"; then
  fail "run-rollout.sh still contains a status-destroying \${VAR:?} guard"
else
  pass "run-rollout.sh contains no \${VAR:?} guards (all via require_env/require_arg)"
fi

echo "== MUTATION (3): broken cleanup variants must FAIL the 5b/6 assertions =="
# Proves 5b/6 are load-bearing rather than green decoration. Both mutants leak the
# cleanup's own status (git exit 3): they corrupt success AND overwrite a distinct
# original failure. The real cleanup yields 0 and 7 respectively.
run_variant() { # $1 cleanup-body  $2 git-mode  $3 body -> exit status
  local wt h="$TMP/mutvar.sh"; wt="$(mktemp -d)"
  { echo 'set -Eeuo pipefail'; printf 'WT=%q\n' "$wt"; echo "cleanup() { $1 }"; echo 'trap cleanup EXIT'; echo "$3"; } > "$h"
  : > "$GIT_CALL_LOG"
  PATH="$TMP/bin:$PATH" GIT_STUB_MODE="$2" GIT_CALL_LOG="$GIT_CALL_LOG" bash "$h" >/dev/null 2>&1; local r=$?
  rmdir "$wt" 2>/dev/null || true; return "$r"
}
M_NOTRUE='local rc=$?; if [[ -n "$WT" && -d "$WT" ]]; then git worktree remove --force "$WT" >/dev/null 2>&1; fi; exit "$rc";'
M_RET0='if [[ -n "$WT" && -d "$WT" ]]; then git worktree remove --force "$WT" >/dev/null 2>&1; fi; return 0;'
for mv in "no-||true:$M_NOTRUE" "return-0:$M_RET0"; do
  mname="${mv%%:*}"; mbody="${mv#*:}"
  run_variant "$mbody" fail ':'; a=$?
  run_variant "$mbody" fail 'exit 7'; b=$?
  [[ "$a" -ne 0 ]] && pass "MUTANT cleanup($mname) corrupts success (exit=$a) — assertion 5b is load-bearing" \
                   || fail "MUTANT cleanup($mname) did not corrupt success; 5b would not catch it"
  [[ "$b" -ne 7 ]] && pass "MUTANT cleanup($mname) loses the distinct status 7 (exit=$b) — assertion 6 is load-bearing" \
                   || fail "MUTANT cleanup($mname) preserved 7; assertion 6 would not catch it"
done

echo "== MUTATION (2): a fixed-status EXIT trap corrupts the result =="
# bare non-zero last command in the trap turns SUCCESS into failure
cat > "$TMP/mutant-bare.sh" <<'EOS'
set -Eeuo pipefail
WT=""
cleanup() { [[ -n "$WT" && -d "$WT" ]] && rm -rf "$WT" 2>/dev/null; }
trap cleanup EXIT
:
EOS
bash "$TMP/mutant-bare.sh" >/dev/null 2>&1
[[ $? -ne 0 ]] && pass "MUTANT bare-status trap corrupts SUCCESS -> exit\$rc is load-bearing" \
               || fail "MUTANT bare-status trap did not corrupt success"
# and the real cleanup must capture $? + exit with it
grep -q 'local rc=\$?' "$RR" && grep -q 'exit "\$rc"' "$RR" \
  && pass "run-rollout.sh cleanup captures \$? and exits with it" \
  || fail "run-rollout.sh cleanup does not preserve the original status"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
