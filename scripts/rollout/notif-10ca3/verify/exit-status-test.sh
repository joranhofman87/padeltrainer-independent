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

echo "== 5. successful worktree cleanup does not change success =="
cat > "$TMP/wt_ok.sh" <<EOS
set -Eeuo pipefail
WT=""
cleanup() { local rc=\$?; if [[ -n "\$WT" && -d "\$WT" ]]; then rm -rf "\$WT" >/dev/null 2>&1 || true; fi; exit "\$rc"; }
trap cleanup EXIT
WT="\$(mktemp -d)"; echo "\$WT" > "$TMP/wt_path"
:
EOS
bash "$TMP/wt_ok.sh" >/dev/null 2>&1; rc=$?
wt="$(cat "$TMP/wt_path" 2>/dev/null || echo)"
[[ "$rc" -eq 0 ]] && pass "success + real worktree cleanup stays exit=0" || fail "worktree cleanup corrupted success (exit=$rc)"
[[ -n "$wt" && ! -d "$wt" ]] && pass "the worktree was actually removed (cleanup really ran)" || fail "cleanup did not remove the worktree"

echo "== 6. cleanup failure does not hide the original failure =="
cat > "$TMP/wt_cleanfail.sh" <<'EOS'
set -Eeuo pipefail
WT="/definitely/not/a/real/path"
cleanup() { local rc=$?; if [[ -n "$WT" && -d "$WT" ]]; then rm -rf "$WT" >/dev/null 2>&1 || true; fi; exit "$rc"; }
trap cleanup EXIT
false
EOS
bash "$TMP/wt_cleanfail.sh" >/dev/null 2>&1
[[ $? -ne 0 ]] && pass "original failure survives a no-op/failing cleanup" || fail "cleanup masked the original failure"

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
