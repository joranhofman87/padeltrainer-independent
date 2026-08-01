#!/usr/bin/env bash
# ===========================================================================
# dryrun-diagnostics-test.sh — the dry-run helpers must PRESERVE the CLI's
# failure reason.
#
# The defect: `supabase ... 2>&1 1>/dev/null | sed …` piped stderr — which is
# where the CLI prints both its pending bullets AND its fatal errors — into a
# 14-digit-number parser. Every diagnostic was discarded, so a real failure
# surfaced as an aborted pipeline with no message (observed: dryrun615 exited 1
# after the identity gates, printing nothing). The same helper backs apply615 and
# resume615, where that silence would land mid-maintenance-window.
#
# No network, no production: `supabase` is stubbed via PATH.
# Run: bash scripts/rollout/notif-10ca3/verify/dryrun-diagnostics-test.sh
# ===========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RR="$HERE/../run-rollout.sh"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"; rm -f "$HERE/../logfetch/.mutant-"*.sh "$HERE/../.mutant-"*.sh' EXIT

P=0; F=0
pass(){ P=$((P+1)); echo "  PASS  $*"; }
fail(){ F=$((F+1)); echo "  FAIL  $*"; }

V1=20261006100000; V2=20261006110000; V3=20261006120000
CLONE_URL='postgresql://postgres@db.zzzzzzzzzzzzzzzzzzzz.supabase.co:5432/postgres'

# --- stubs -----------------------------------------------------------------
BIN="$ROOT/bin"; mkdir -p "$BIN"
cat > "$BIN/supabase" <<'EOF'
#!/usr/bin/env bash
printf '%s ' "$@" > "${STUB_ARGV_FILE:-/dev/null}"
[[ -n "${STUB_OUT:-}" ]] && printf '%s\n' "$STUB_OUT" >&2
exit "${STUB_RC:-0}"
EOF
chmod +x "$BIN/supabase"
# shred/gshred are stubbed to fail so both platforms take secure_delete's manual
# path; otherwise the cleanup-failure case only runs where coreutils is absent.
NOSHRED="$ROOT/noshred"; mkdir -p "$NOSHRED"
printf '#!/usr/bin/env bash\nexit 1\n' > "$NOSHRED/shred"
printf '#!/usr/bin/env bash\nexit 1\n' > "$NOSHRED/gshred"
RMFAIL="$ROOT/rmfail"; mkdir -p "$RMFAIL"
cat > "$RMFAIL/rm" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in *rollout-dryrun-*) echo "rm: Operation not permitted" >&2; exit 1;; esac; done
exec /bin/rm "$@"
EOF
chmod +x "$NOSHRED"/shred "$NOSHRED"/gshred "$RMFAIL"/rm

# --- shim: the REAL helper text, lifted verbatim from run-rollout.sh --------
SHIM="$ROOT/shim.sh"
{ echo 'set -Eeuo pipefail'
  echo "source \"$HERE/../lib/common.sh\""
  sed -n '/^ROLLOUT_DIAG_MAX_LINES=/,/^clone_dry_run_pending()/p' "$RR"
} > "$SHIM"
grep -q '^dry_run_pending()' "$SHIM" && grep -q '^clone_dry_run_pending()' "$SHIM" \
  && pass "shim carries the real dry_run_pending / clone_dry_run_pending text" || fail "shim extraction failed"

run_helper(){ # $1 which(push|clone) ; env: STUB_RC STUB_OUT + secrets
  local which="$1"; shift
  local call='push_dry_run_pending'
  [[ "$which" == clone ]] && call="clone_dry_run_pending \"$CLONE_URL\""
  # `set +e` around the call: the SHIM keeps run-rollout.sh's own `set -Eeuo
  # pipefail` so the helper behaves exactly as in production, but the harness must
  # survive a non-zero return in order to report it.
  ( PATH="$BIN:$PATH" TMPDIR="$ROOT/tmp" bash -c "
      source '$SHIM'
      set +e; out=\"\$($call)\"; rc=\$?; set -e
      printf 'RC=%s\n' \"\$rc\"
      printf 'STDOUT<<%s>>\n' \"\$out\"
    " ) 2>&1
}
mkdir -p "$ROOT/tmp"
caps(){ ls "$ROOT/tmp" 2>/dev/null | grep -c 'rollout-dryrun-' || true; }

for W in push clone; do
  echo "== ${W} helper =="
  # (1) success: bullets on stderr -> exact normalised versions
  OUT="$(STUB_RC=0 STUB_OUT=" • ${V1}_a.sql
 • ${V2}_b.sql
 • ${V3}_c.sql" run_helper "$W")"
  grep -q 'RC=0' <<<"$OUT" && pass "($W 1) success exits 0" || fail "($W 1) rc: $(grep -o 'RC=[0-9]*' <<<"$OUT")"
  [[ "$(sed -n 's/STDOUT<<\(.*\)/\1/p' <<<"$OUT" | tr -d '>')" == "$V1" ]] || true
  grep -qz "STDOUT<<${V1}" <<<"$OUT" && pass "($W 1) emits the exact normalised version list" || fail "($W 1) wrong stdout"

  # (2) success mixed with unrelated informational output -> versions ONLY
  OUT="$(STUB_RC=0 STUB_OUT="Connecting to remote database...
Applying migration bundle
 • ${V1}_a.sql
Linked project: abcdefghijklmnopqrst
 • ${V2}_b.sql
 • ${V3}_c.sql
Finished supabase db push." run_helper "$W")"
  body="$(sed -n '/STDOUT<</,$p' <<<"$OUT" | tr -d '\n')"
  [[ "$body" == "STDOUT<<${V1}${V2}${V3}>>" ]] && pass "($W 2) informational noise is discarded; only versions returned" || fail "($W 2) got $body"

  # (3) nonzero + a safe diagnostic -> true nonzero AND the diagnostic is visible
  OUT="$(STUB_RC=7 STUB_OUT="failed to connect to remote database: connection refused" run_helper "$W")"
  grep -q 'RC=7' <<<"$OUT" && pass "($W 3) the CLI's real exit code (7) is returned" || fail "($W 3) exit code lost"
  grep -q 'connection refused' <<<"$OUT" && pass "($W 3) the CLI diagnostic is visible" || fail "($W 3) diagnostic swallowed"

  # (4) nonzero with NO output -> explicit fallback naming the command + code
  OUT="$(STUB_RC=3 STUB_OUT="" run_helper "$W")"
  grep -q 'RC=3' <<<"$OUT" && pass "($W 4) silent CLI failure still returns its code" || fail "($W 4) code lost"
  grep -q 'produced NO output' <<<"$OUT" && grep -q 'supabase db push' <<<"$OUT" \
    && pass "($W 4) fallback names the command and the exit code" || fail "($W 4) no fallback diagnostic"

  # (5) each secret value present in the diagnostic must be redacted
  OUT="$(STUB_RC=9 SUPABASE_DB_PASSWORD='p@ss.w*rd[1]' SUPABASE_ACCESS_TOKEN='sbp_deadbeef' \
         MANAGER_TOKEN='eyJhbGciOi.MANAGERJWT' PGPASSWORD='pgp@ssZ' \
         STUB_OUT="db=p@ss.w*rd[1] pat=sbp_deadbeef jwt=eyJhbGciOi.MANAGERJWT pg=pgp@ssZ
Authorization: Bearer eyJhbGciOi.MANAGERJWT" run_helper "$W")"
  if grep -qE 'p@ss\.w\*rd\[1\]|sbp_deadbeef|eyJhbGciOi\.MANAGERJWT|pgp@ssZ' <<<"$OUT"; then
    fail "($W 5) a secret value leaked into the diagnostic"
  else pass "($W 5) all four secret values redacted (literal match, regex metachars intact)"; fi
  grep -q 'REDACTED' <<<"$OUT" && pass "($W 5) redaction markers present (the line is still shown)" || fail "($W 5) whole line dropped instead of redacted"

  # (6) plain and percent-encoded Postgres URL passwords
  OUT="$(STUB_RC=9 STUB_OUT="url1: postgres://postgres:sup3rSecret@db.x.supabase.co:5432/postgres
url2: postgresql://postgres:p%40ss%2Aword@db.x.supabase.co:5432/postgres" run_helper "$W")"
  if grep -qE 'sup3rSecret|p%40ss%2Aword' <<<"$OUT"; then
    fail "($W 6) a URI userinfo password leaked"
  else pass "($W 6) plain and percent-encoded URI passwords redacted"; fi
  grep -q 'db.x.supabase.co' <<<"$OUT" && pass "($W 6) the non-secret part of the URL is preserved (still diagnosable)" || fail "($W 6) whole URL dropped"

  # (7)+(8) a failing CLI can never become an empty successful pending set, and the
  # parser is never reached — even when the diagnostic itself contains version text
  OUT="$(STUB_RC=1 STUB_OUT="fatal: could not apply ${V1}_a.sql" run_helper "$W")"
  grep -q 'RC=1' <<<"$OUT" && pass "($W 7) failure stays nonzero (never an empty success)" || fail "($W 7) failure became success"
  grep -q "STDOUT<<>>" <<<"$OUT" && pass "($W 8) the parser was NOT run: stdout is empty despite version text in the error" || fail "($W 8) parsed output after failure"

  # (9) the capture file is removed on success AND on failure
  STUB_RC=0 STUB_OUT=" • ${V1}_a.sql" run_helper "$W" >/dev/null
  [[ "$(caps)" == 0 ]] && pass "($W 9) capture removed on success" || fail "($W 9) $(caps) capture(s) left after success"
  STUB_RC=5 STUB_OUT="boom" run_helper "$W" >/dev/null
  [[ "$(caps)" == 0 ]] && pass "($W 9) capture removed on failure" || fail "($W 9) $(caps) capture(s) left after failure"

  # (10) cleanup failure must not mask or replace the CLI failure
  OUT="$( PATH="$RMFAIL:$NOSHRED:$BIN:$PATH" TMPDIR="$ROOT/tmp" bash -c "
      source '$SHIM'
      set +e; out=\"\$($([[ "$W" == clone ]] && echo "clone_dry_run_pending '$CLONE_URL'" || echo push_dry_run_pending))\"; rc=\$?; set -e
      printf 'RC=%s\n' \"\$rc\"" 2>&1 )"
  # NB: env for the stub must survive the inner bash -c
  OUT="$( PATH="$RMFAIL:$NOSHRED:$BIN:$PATH" TMPDIR="$ROOT/tmp" STUB_RC=7 STUB_OUT="connection refused" bash -c "
      source '$SHIM'
      set +e; out=\"\$($([[ "$W" == clone ]] && echo "clone_dry_run_pending '$CLONE_URL'" || echo push_dry_run_pending))\"; rc=\$?; set -e
      printf 'RC=%s\n' \"\$rc\"" 2>&1 )"
  grep -q 'RC=7' <<<"$OUT" && pass "($W 10) cleanup failure does NOT replace the CLI's exit code" || fail "($W 10) code became $(grep -o 'RC=[0-9]*' <<<"$OUT")"
  grep -q 'connection refused' <<<"$OUT" && pass "($W 10) cleanup failure does NOT mask the CLI diagnostic" || fail "($W 10) diagnostic lost"
  grep -q 'remove it by hand' <<<"$OUT" && pass "($W 10) the cleanup failure is itself reported" || fail "($W 10) silent cleanup failure"
  /bin/rm -f "$ROOT"/tmp/rollout-dryrun-* 2>/dev/null || true
done

echo "== callers observe the helper's status (no discarded command substitution) =="
# In argument position a command substitution's exit status is DISCARDED, so
# `assert_pending_is_expected "$(helper)" …` would silently proceed with "".
grep -nE 'assert_pending_is_expected "\$\((push|clone)_dry_run_pending' "$RR" \
  && fail "a caller still passes the helper directly as an argument (status discarded)" \
  || pass "no caller passes the helper's output straight into an argument"
for fn in cmd_dryrun615 cmd_apply615 cmd_resume615 cmd_clone_push cmd_clone_make_prefix; do
  sed -n "/^${fn}()/,/^}/p" "$RR" | grep -qE '_dry_run_pending' || continue
  sed -n "/^${fn}()/,/^}/p" "$RR" | grep -qE '\$\((push|clone)_dry_run_pending[^)]*\)" \|\| die' \
    && pass "$fn fails closed on a dry-run failure" || fail "$fn does not check the dry-run status"
done
grep -q 'ROLLOUT_DIAG_MAX_LINES' "$RR" && grep -q 'ROLLOUT_DIAG_MAX_COLS' "$RR" \
  && pass "diagnostic output is bounded by line and column caps" || fail "no output bounds"
grep -qE '^[^#]*2>&1 1>/dev/null' "$RR" && fail "the old stderr-into-parser pipeline is back as a command" \
  || pass "the old 2>&1 1>/dev/null parser pipeline is gone (only referenced in the explanatory comment)"
grep -q 'set -x' "$RR" && fail "set -x present" || pass "no set -x"
# the exact-set guard itself is untouched (its own mutation pins live in guard-mutation-test.sh)
grep -q 'assert_pending_is_expected() {' "$HERE/../lib/common.sh" && pass "the exact-pending-set assertion is unchanged and still shared" || fail "pending-set guard missing"

echo "== end to end: dryrun615 surfaces the reason and fails closed =="
cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == pr && "$2" == view ]]; then echo "2b247f43afe8ff73d32f44f4f58c3d9918471c77"; exit 0; fi
exit 0
EOF
cat > "$BIN/git" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  fetch|cat-file) exit 0;;
  worktree)
    if [[ "$2" == add ]]; then wt="$4"; mkdir -p "$wt/supabase"
      printf 'project_id = "%s"\n' "ficwbdrzefmblkbkomzw" > "$wt/supabase/config.toml"; exit 0; fi
    if [[ "$2" == remove ]]; then for a in "$@"; do [[ -d "$a" && "$a" == *rollout-wt-* ]] && /bin/rm -rf "$a"; done; exit 0; fi;;
esac
exit 0
EOF
chmod +x "$BIN/gh" "$BIN/git"
E2E="$( PATH="$BIN:$PATH" EXPECTED_REF=ficwbdrzefmblkbkomzw SUPABASE_DB_PASSWORD='e2e-not-a-real-password' \
        STUB_RC=6 STUB_OUT='failed to connect to postgres: e2e-not-a-real-password rejected' \
        bash "$RR" dryrun615 2>&1 )"; e2erc=$?
[[ "$e2erc" -ne 0 ]] && pass "dryrun615 fails closed when the CLI fails (exit $e2erc)" || fail "dryrun615 reported success"
grep -q 'failed to connect to postgres' <<<"$E2E" && pass "dryrun615 SURFACES the CLI reason (the original defect)" || fail "dryrun615 still swallows the reason"
grep -q 'e2e-not-a-real-password' <<<"$E2E" && fail "the password leaked into dryrun615 output" || pass "dryrun615 output is redacted"
grep -q 'dry run verified' <<<"$E2E" && fail "dryrun615 claimed verification after a failure" || pass "dryrun615 makes no verification claim after a failure"

echo "== MUTANTS =="
mut(){ local name="$1"; local pyexpr="$2"; local m="$HERE/../.mutant-$name.sh"
  python3 - "$RR" "$m" "$pyexpr" <<'PYX'
import sys
src, dst, expr = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(src).read()
old, new = expr.split("||=||")
assert s.count(old) == 1, "anchor %r not unique (%d)" % (old[:40], s.count(old))
open(dst, "w").write(s.replace(old, new, 1))
PYX
  printf '%s' "$m"; }
run_mut(){ # $1 mutant, $2 which(push|clone) ; runs the mutant's helper text
  local m="$1" w="$2"; local sh="$ROOT/mshim.sh"
  { echo 'set -Eeuo pipefail'; echo "source \"$HERE/../lib/common.sh\""
    sed -n '/^ROLLOUT_DIAG_MAX_LINES=/,/^clone_dry_run_pending()/p' "$m"
    sed -n '/^push_dry_run_pending()/p;/^clone_dry_run_pending()/p' "$m"; } > "$sh"
  local call='push_dry_run_pending'; [[ "$w" == clone ]] && call="clone_dry_run_pending \"$CLONE_URL\""
  ( PATH="$BIN:$PATH" TMPDIR="$ROOT/tmp" bash -c "source '$sh'; set +e; out=\"\$($call)\"; rc=\$?; set -e; printf 'RC=%s\nSTDOUT<<%s>>\n' \"\$rc\" \"\$out\"" ) 2>&1; }

# (a) the old stderr-into-parser pipeline restored -> the reason disappears
M="$(mut oldpipe 'NO_COLOR=1 supabase db push "$@" --dry-run >"$cap" 2>&1 || rc=$?||=||NO_COLOR=1 supabase db push "$@" --dry-run 2>&1 1>/dev/null | sed -n "s/.*\([0-9]\{14\}\)_.*/\1/p" > "$cap" || rc=$?')"
OUT="$(STUB_RC=7 STUB_OUT="connection refused" run_mut "$M" push)"
grep -q 'connection refused' <<<"$OUT" && fail "mutant (a) still shows the reason" || pass "MUTANT (old 2>&1|sed pipeline) LOSES the CLI reason — capturing to a file is load-bearing"
rm -f "$M"
# (b) ignore the CLI status
M="$(mut ignorerc 'if [[ "$rc" -ne 0 ]]; then||=||if false; then')"
OUT="$(STUB_RC=7 STUB_OUT=" • ${V1}_a.sql" run_mut "$M" push)"
grep -q 'RC=0' <<<"$OUT" && pass "MUTANT (ignores the CLI status) reports SUCCESS on a failed dry run — the status check is load-bearing" || fail "mutant (b) not distinguishable"
rm -f "$M"
# (c) parse after failure
M="$(mut parseafter 'warn "supabase db push --dry-run FAILED (exit ${rc}) — the pending set was NOT parsed"||=||sed -n "s/.*[[:space:]]\([0-9]\{14\}\)_[A-Za-z0-9_]*\.sql.*/\1/p" "$cap" | sort -u; warn "FAILED (exit ${rc})"')"
OUT="$(STUB_RC=1 STUB_OUT="fatal: could not apply ${V1}_a.sql" run_mut "$M" push)"
grep -q "STDOUT<<${V1}>>" <<<"$OUT" && pass "MUTANT (parses after failure) emits a pending set from an ERROR message — the ordering is load-bearing" || fail "mutant (c) not distinguishable"
rm -f "$M"
# (d) raw unredacted diagnostics
M="$(mut raw 'redact_diag "$cap" >&2||=||cat "$cap" >&2')"
OUT="$(STUB_RC=9 SUPABASE_DB_PASSWORD='p@ss.w*rd[1]' STUB_OUT="db=p@ss.w*rd[1]" run_mut "$M" push)"
grep -q 'p@ss\.w\*rd\[1\]' <<<"$OUT" && pass "MUTANT (raw diagnostic) LEAKS the password — redaction is load-bearing" || fail "mutant (d) not distinguishable"
rm -f "$M"
# (e) success with an empty parsed set on failure
M="$(mut emptyok 'return "$rc"                       # the ORIGINAL CLI code, never a cleanup code||=||return 0')"
OUT="$(STUB_RC=7 STUB_OUT="connection refused" run_mut "$M" push)"
grep -q 'RC=0' <<<"$OUT" && grep -q 'STDOUT<<>>' <<<"$OUT" \
  && pass "MUTANT (returns 0 on failure) yields an EMPTY successful pending set — returning the CLI code is load-bearing" || fail "mutant (e) not distinguishable"
rm -f "$M"
# (f) fix the linked helper only, leave the clone path silent
M="$(mut clonesilent 'clone_dry_run_pending() { dry_run_pending --db-url "$1"; }||=||clone_dry_run_pending() { NO_COLOR=1 supabase db push --db-url "$1" --dry-run 2>&1 1>/dev/null | sed -n "s/.*\([0-9]\{14\}\)_.*/\1/p" | sort -u; }')"
OUT="$(STUB_RC=7 STUB_OUT="connection refused" run_mut "$M" clone)"
grep -q 'connection refused' <<<"$OUT" && fail "mutant (f) clone still shows the reason" || pass "MUTANT (clone left on the old pipeline) LOSES the reason — both helpers must share the contract"
OUT="$(STUB_RC=7 STUB_OUT="connection refused" run_mut "$M" push)"
grep -q 'connection refused' <<<"$OUT" && pass "...while the linked helper in the same mutant still reports it (the two are independently covered)" || fail "mutant (f) push path also broken"
rm -f "$M"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
