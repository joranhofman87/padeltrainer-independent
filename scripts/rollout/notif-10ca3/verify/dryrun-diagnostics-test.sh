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

echo "== NO credential may reach a diagnostic (clone target argv) =="
# The failure fallback used to interpolate "$*", which for the clone helper is
# `--db-url postgresql://user:PASSWORD@host/db`. Reproduced at the reviewed SHA:
# the password appeared verbatim. The label and the argv are now strictly separate.
LEAKY_PLAIN='postgresql://postgres:FAKE_CLONE_PW_123@db.zzzzzzzzzzzzzzzzzzzz.supabase.co:5432/postgres'
LEAKY_PCT='postgresql://postgres:p%40ss%2AWORD9@db.zzzzzzzzzzzzzzzzzzzz.supabase.co:5432/postgres'
clone_with_url(){ # $1 url ; env STUB_RC/STUB_OUT ; runs the REAL clone helper
  ( PATH="$BIN:$PATH" TMPDIR="$ROOT/tmp" bash -c "
      source '$SHIM'
      set +e; out=\"\$(clone_dry_run_pending '$1')\"; rc=\$?; set -e
      printf 'RC=%s\nSTDOUT<<%s>>\n' \"\$rc\" \"\$out\"" ) 2>&1; }
OUT="$(STUB_RC=3 STUB_OUT="" clone_with_url "$LEAKY_PLAIN")"
grep -q 'FAKE_CLONE_PW_123' <<<"$OUT" && fail "no-output fallback leaked the plain clone password" \
  || pass "no-output fallback: plain clone password ABSENT from the diagnostic"
grep -q 'RC=3' <<<"$OUT" && pass "no-output fallback still returns the CLI's code" || fail "code lost"
grep -q 'explicit clone target' <<<"$OUT" && pass "the fallback names the target CLASS, not the connection string" || fail "no target class in the fallback"
OUT="$(STUB_RC=3 STUB_OUT="" clone_with_url "$LEAKY_PCT")"
grep -qE 'p%40ss%2AWORD9' <<<"$OUT" && fail "no-output fallback leaked the percent-encoded clone password" \
  || pass "no-output fallback: percent-encoded clone password ABSENT"
# and with output present, the URL in the CLI's own text is still redacted
OUT="$(STUB_RC=4 STUB_OUT="could not connect to $LEAKY_PLAIN" clone_with_url "$LEAKY_PLAIN")"
grep -q 'FAKE_CLONE_PW_123' <<<"$OUT" && fail "the credential leaked through the CLI's own output" \
  || pass "a credential inside the CLI's own output is redacted too"
# the argv pass-through `supabase db push "$@"` is legitimate; what must never
# happen is argv reaching a DIAGNOSTIC line.
sed -n '/^dry_run_pending()/,/^}/p' "$RR" | grep -E '^\s*(warn|log|ok|die|printf|echo)\b' | grep -qE '\$\*|\$@' \
  && fail "a diagnostic line in dry_run_pending interpolates \$* or \$@" \
  || pass "no diagnostic line interpolates the argv (only the CLI invocation uses \"\$@\")"

echo "== diagnostic prerequisites exist BEFORE the CLI runs =="
# jq missing -> stop before invoking supabase, so no sensitive capture is created
MIN="$ROOT/minbin"; mkdir -p "$MIN"
for t in mktemp chmod rm sed sort dd wc tr head grep date basename cat od uname stat ls id umask sleep; do
  src="$(command -v "$t" 2>/dev/null)"; [[ -n "$src" ]] && ln -sf "$src" "$MIN/$t"
done
ln -sf "$BIN/supabase" "$MIN/supabase"
ARGV="$ROOT/supabase-was-invoked"; : > "$ARGV"; /bin/rm -f "$ARGV"
OUT="$( PATH="$MIN" TMPDIR="$ROOT/tmp" STUB_ARGV_FILE="$ARGV" STUB_RC=0 bash -c "
    source '$SHIM'; set +e; push_dry_run_pending; printf 'RC=%s\n' \$?" 2>&1 )"
[[ ! -f "$ARGV" ]] && pass "jq missing: the supabase CLI was NEVER invoked" || fail "the CLI ran without a sanitiser available"
[[ "$(caps)" == 0 ]] && pass "jq missing: no capture file was created" || fail "a capture was left behind"
# chmod failure -> stop before invoking supabase, leave no capture
CHFAIL="$ROOT/chfail"; mkdir -p "$CHFAIL"
printf '#!/usr/bin/env bash\nexit 1\n' > "$CHFAIL/chmod"; chmod +x "$CHFAIL/chmod"
/bin/rm -f "$ARGV"
OUT="$( PATH="$CHFAIL:$BIN:$PATH" TMPDIR="$ROOT/tmp" STUB_ARGV_FILE="$ARGV" STUB_RC=0 bash -c "
    source '$SHIM'; set +e; push_dry_run_pending; printf 'RC=%s\n' \$?" 2>&1 )"
[[ ! -f "$ARGV" ]] && pass "0600 hardening failure: the supabase CLI was NEVER invoked" || fail "the CLI ran with an unsecured capture"
grep -q '0600' <<<"$OUT" && pass "0600 hardening failure is reported explicitly" || fail "silent permission failure"
[[ "$(caps)" == 0 ]] && pass "0600 hardening failure: the empty capture was cleaned up" || fail "$(caps) capture(s) left behind"

echo "== a runtime sanitiser failure is safe, bounded and non-masking =="
# jq PRESENT but broken, and the CLI has already written a secret-bearing diagnostic
JQFAIL="$ROOT/jqfail"; mkdir -p "$JQFAIL"
printf '#!/usr/bin/env bash\nexit 1\n' > "$JQFAIL/jq"; chmod +x "$JQFAIL/jq"
OUT="$( PATH="$JQFAIL:$BIN:$PATH" TMPDIR="$ROOT/tmp" STUB_RC=8 \
        STUB_OUT="fatal: password authentication failed for FAKE_CLONE_PW_123" bash -c "
    source '$SHIM'; set +e; out=\"\$(push_dry_run_pending)\"; rc=\$?; set -e; printf 'RC=%s\n' \"\$rc\"" 2>&1 )"
grep -q 'FAKE_CLONE_PW_123' <<<"$OUT" && fail "raw output was printed when sanitisation failed" \
  || pass "sanitiser failure: the raw diagnostic is WITHHELD, not printed"
grep -q 'could NOT be sanitised' <<<"$OUT" && pass "sanitiser failure: a generic safe message is emitted" || fail "no generic message"
grep -q 'RC=8' <<<"$OUT" && pass "sanitiser failure: the CLI's original exit code (8) is preserved" || fail "the CLI code was replaced"
[[ "$(caps)" == 0 ]] && pass "sanitiser failure: the capture was still securely deleted" || fail "$(caps) capture(s) stranded"
grep -q 'secrets redacted' <<<"$OUT" && fail "claimed a redacted diagnostic was displayed when none was" \
  || pass "an empty sanitiser result is not described as a displayed diagnostic"

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
# $3 (optional) scopes the replacement to one function body, so an anchor that
# also appears in a SIBLING function (e.g. link_worktree_pooler reuses the same
# capture/redaction shape) cannot make the mutation ambiguous.
mut(){ local name="$1"; local pyexpr="$2"; local scope="${3:-}"; local m="$HERE/../.mutant-$name.sh"
  python3 - "$RR" "$m" "$pyexpr" "$scope" <<'PYX'
import sys, re
src, dst, expr, scope = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
s = open(src).read()
old, new = expr.split("||=||")
if scope:
    m = re.search(r"^%s\(\) \{.*?^\}$" % re.escape(scope), s, re.S | re.M)
    assert m, "scope function %s not found" % scope
    body = m.group(0)
    assert body.count(old) == 1, "anchor %r not unique in %s (%d)" % (old[:40], scope, body.count(old))
    s = s[:m.start()] + body.replace(old, new, 1) + s[m.end():]
else:
    assert s.count(old) == 1, "anchor %r not unique (%d)" % (old[:40], s.count(old))
    s = s.replace(old, new, 1)
open(dst, "w").write(s)
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
M="$(mut ignorerc 'if [[ "$rc" -ne 0 ]]; then||=||if false; then' dry_run_pending)"
OUT="$(STUB_RC=7 STUB_OUT=" • ${V1}_a.sql" run_mut "$M" push)"
grep -q 'RC=0' <<<"$OUT" && pass "MUTANT (ignores the CLI status) reports SUCCESS on a failed dry run — the status check is load-bearing" || fail "mutant (b) not distinguishable"
rm -f "$M"
# (c) parse after failure
M="$(mut parseafter 'warn "supabase db push --dry-run FAILED (exit ${rc}) — the pending set was NOT parsed"||=||sed -n "s/.*[[:space:]]\([0-9]\{14\}\)_[A-Za-z0-9_]*\.sql.*/\1/p" "$cap" | sort -u; warn "FAILED (exit ${rc})"')"
OUT="$(STUB_RC=1 STUB_OUT="fatal: could not apply ${V1}_a.sql" run_mut "$M" push)"
grep -q "STDOUT<<${V1}>>" <<<"$OUT" && pass "MUTANT (parses after failure) emits a pending set from an ERROR message — the ordering is load-bearing" || fail "mutant (c) not distinguishable"
rm -f "$M"
# (d) raw unredacted diagnostics
M="$(mut raw 'safe="$(redact_diag "$cap")" || safe=""||=||safe="$(cat "$cap")"' dry_run_pending)"
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
M="$(mut clonesilent 'clone_dry_run_pending() { dry_run_pending "explicit clone target"  --db-url "$1"; }||=||clone_dry_run_pending() { NO_COLOR=1 supabase db push --db-url "$1" --dry-run 2>&1 1>/dev/null | sed -n "s/.*\([0-9]\{14\}\)_.*/\1/p" | sort -u; }')"
OUT="$(STUB_RC=7 STUB_OUT="connection refused" run_mut "$M" clone)"
grep -q 'connection refused' <<<"$OUT" && fail "mutant (f) clone still shows the reason" || pass "MUTANT (clone left on the old pipeline) LOSES the reason — both helpers must share the contract"
OUT="$(STUB_RC=7 STUB_OUT="connection refused" run_mut "$M" push)"
grep -q 'connection refused' <<<"$OUT" && pass "...while the linked helper in the same mutant still reports it (the two are independently covered)" || fail "mutant (f) push path also broken"
rm -f "$M"

echo "== the PENDING PARSER's own failure must not be discarded =="
# The parser used to run bare — `sed … | sort -u` straight to stdout — after which
# secure_delete and `return 0` overwrote `$?`. Reproduced at the reviewed SHA:
# supabase rc=0 with a valid bullet + sort rc=42 gave helper rc=0 and EMPTY stdout,
# i.e. a crashed parser reading as "nothing pending".
SORTFAIL="$ROOT/sortfail"; mkdir -p "$SORTFAIL"; printf '#!/usr/bin/env bash\nexit 42\n' > "$SORTFAIL/sort"
SEDFAIL="$ROOT/sedfail";  mkdir -p "$SEDFAIL";  printf '#!/usr/bin/env bash\nexit 9\n'  > "$SEDFAIL/sed"
HEADFAIL="$ROOT/headfail"; mkdir -p "$HEADFAIL"; printf '#!/usr/bin/env bash\nexit 11\n' > "$HEADFAIL/head"
chmod +x "$SORTFAIL/sort" "$SEDFAIL/sed" "$HEADFAIL/head"
parser_run(){ # $1 extra PATH prefix
  ( PATH="$1:$BIN:$PATH" TMPDIR="$ROOT/tmp" STUB_RC=0 STUB_OUT=" • ${V1}_a.sql" bash -c "
      source '$SHIM'; set +e; out=\"\$(push_dry_run_pending)\"; rc=\$?; set -e
      printf 'RC=%s\nSTDOUT<<%s>>\n' \"\$rc\" \"\$out\"" ) 2>&1; }
OUT="$(parser_run "$SORTFAIL")"
grep -q 'RC=42' <<<"$OUT" && pass "(P1) sort rc=42: the helper returns the PARSER's code (42), not 0" || fail "(P1) parser failure discarded: $(grep -o 'RC=[0-9]*' <<<"$OUT")"
grep -q 'STDOUT<<>>' <<<"$OUT" && pass "(P1) sort rc=42: stdout stays EMPTY (never a phantom pending set)" || fail "(P1) stdout not empty"
grep -q 'PARSER failed' <<<"$OUT" && pass "(P1) sort rc=42: a bounded generic parser-failure diagnostic is emitted" || fail "(P1) no parser diagnostic"
[[ "$(caps)" == 0 ]] && pass "(P1) sort rc=42: the capture was securely deleted" || fail "(P1) $(caps) capture(s) stranded"
OUT="$(parser_run "$SEDFAIL")"
grep -q 'RC=9' <<<"$OUT" && pass "(P2) sed rc=9: the helper returns the parser's code (9)" || fail "(P2) sed failure discarded"
grep -q 'STDOUT<<>>' <<<"$OUT" && pass "(P2) sed rc=9: stdout stays EMPTY" || fail "(P2) stdout not empty"
[[ "$(caps)" == 0 ]] && pass "(P2) sed rc=9: the capture was securely deleted" || fail "(P2) capture stranded"
grep -q "${V1}" <<<"$(sed -n '/STDOUT<</,$p' <<<"$OUT")" && fail "(P2) raw captured output was parsed/printed after failure" \
  || pass "(P2) no raw captured output is parsed or printed on parser failure"

echo "== parser dependencies are preflighted BEFORE the CLI runs =="
for miss in sed sort; do
  MINP="$ROOT/min_no_$miss"; mkdir -p "$MINP"
  for t in mktemp chmod rm sed sort dd wc tr head grep date basename cat od jq; do
    [[ "$t" == "$miss" ]] && continue
    src="$(command -v "$t" 2>/dev/null)"; [[ -n "$src" ]] && ln -sf "$src" "$MINP/$t"
  done
  ln -sf "$BIN/supabase" "$MINP/supabase"
  /bin/rm -f "$ARGV"
  ( PATH="$MINP" TMPDIR="$ROOT/tmp" STUB_ARGV_FILE="$ARGV" STUB_RC=0 bash -c "
      source '$SHIM'; set +e; push_dry_run_pending" ) >/dev/null 2>&1
  [[ ! -f "$ARGV" ]] && pass "(P3) missing $miss: the supabase CLI was NEVER invoked" || fail "(P3) the CLI ran without $miss"
  [[ "$(caps)" == 0 ]] && pass "(P3) missing $miss: no capture was created" || fail "(P3) capture created without $miss"
done

echo "== parser failure + cleanup failure: both reported, parser code wins =="
OUT="$( PATH="$SORTFAIL:$RMFAIL:$NOSHRED:$BIN:$PATH" TMPDIR="$ROOT/tmp" STUB_RC=0 STUB_OUT=" • ${V1}_a.sql" bash -c "
    source '$SHIM'; set +e; out=\"\$(push_dry_run_pending)\"; rc=\$?; set -e; printf 'RC=%s\n' \"\$rc\"" 2>&1 )"
grep -q 'RC=42' <<<"$OUT" && pass "(P4) cleanup failure does NOT replace the parser's code (42)" || fail "(P4) code became $(grep -o 'RC=[0-9]*' <<<"$OUT")"
grep -q 'PARSER failed' <<<"$OUT" && grep -q 'remove it by hand' <<<"$OUT" \
  && pass "(P4) BOTH the parser failure and the cleanup failure are reported" || fail "(P4) one of the two failures is silent"
/bin/rm -f "$ROOT"/tmp/rollout-dryrun-* 2>/dev/null || true

echo "== a BOUNDING-stage failure in redact_diag withholds the diagnostic =="
OUT="$( PATH="$HEADFAIL:$BIN:$PATH" TMPDIR="$ROOT/tmp" STUB_RC=8 \
        STUB_OUT="fatal: password authentication failed for FAKE_CLONE_PW_123" bash -c "
    source '$SHIM'; set +e; out=\"\$(push_dry_run_pending)\"; rc=\$?; set -e; printf 'RC=%s\n' \"\$rc\"" 2>&1 )"
grep -q 'FAKE_CLONE_PW_123' <<<"$OUT" && fail "(P5) a failed bounding stage leaked the raw secret" \
  || pass "(P5) bounding-stage failure: the raw secret is ABSENT"
grep -q 'could NOT be sanitised' <<<"$OUT" && pass "(P5) bounding-stage failure uses the generic withholding message" || fail "(P5) no generic message"
grep -q 'RC=8' <<<"$OUT" && pass "(P5) bounding-stage failure preserves the CLI's original code (8)" || fail "(P5) CLI code replaced"
[[ "$(caps)" == 0 ]] && pass "(P5) bounding-stage failure: cleanup was still attempted" || fail "(P5) capture stranded"

echo "== end to end: the CLONE path leaks nothing and fails closed =="
# Not a static assertion: the real `clone-push` subcommand is driven with a
# credential-bearing clone URL and a CLI that fails silently.
cat > "$BIN/psql" <<'EOF'
#!/usr/bin/env bash
if printf '%s ' "$@" | grep -q -- '-Atqc'; then echo ""; exit 0; fi   # ledger: none
exit 0
EOF
chmod +x "$BIN/psql"
# clone commands are gated on assert_clone_isolated; seed the approved inert
# snapshot so this test reaches the CLI fallback it is actually about.
CS_EVID="$ROOT/cs-evid"; mkdir -p "$CS_EVID"; printf '%s\n' "a1b2c3d4e5f60718293a4b5c6d7e8f90" > "$CS_EVID/clone-source-nonce.txt"
E2EC="$( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$CS_EVID" \
         EXPECTED_REF=ficwbdrzefmblkbkomzw CLONE_REF=zzzzzzzzzzzzzzzzzzzz \
         CAP_STMT=30000 STUB_RC=4 STUB_OUT='' \
         bash "$RR" clone-push --yes "$LEAKY_PLAIN" 2>&1 )"; e2ecrc=$?
[[ "$e2ecrc" -ne 0 ]] && pass "clone-push fails closed when the CLI fails (exit $e2ecrc)" || fail "clone-push reported success"
grep -q 'FAKE_CLONE_PW_123' <<<"$E2EC" && fail "clone-push leaked the clone password end to end" \
  || pass "clone-push END TO END: the clone password never appears in its output"
grep -q 'explicit clone target' <<<"$E2EC" && pass "clone-push names the target class in the fallback" || fail "no target class"
grep -q 'pending migration set ==' <<<"$E2EC" && fail "clone-push claimed a verified pending set after a CLI failure" \
  || pass "clone-push makes no pending-set claim after a CLI failure"
# ...and with a credential inside the CLI's own output
E2EC="$( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$CS_EVID" \
         EXPECTED_REF=ficwbdrzefmblkbkomzw CLONE_REF=zzzzzzzzzzzzzzzzzzzz \
         CAP_STMT=30000 STUB_RC=4 STUB_OUT="connect failed: $LEAKY_PLAIN" \
         bash "$RR" clone-push --yes "$LEAKY_PLAIN" 2>&1 )"
grep -q 'FAKE_CLONE_PW_123' <<<"$E2EC" && fail "clone-push leaked a credential from the CLI's own output" \
  || pass "clone-push END TO END: a credential in the CLI's output is redacted"

echo "== MUTANT: restoring the bare parse/cleanup/return-0 flow =="
M="$(mut bareparse 'local parsed prc=0||=||local parsed prc=0; sed -n "s/.*[[:space:]]\([0-9]\{14\}\)_[A-Za-z0-9_]*\.sql.*/\1/p" "$cap" | sort -u; secure_delete "$cap" >/dev/null 2>&1; return 0
  UNREACHED() { :; }')"
grep -q 'UNREACHED' "$M" && pass "mutant (h) built: bare parse -> cleanup -> return 0 restored" || fail "mutant (h) not applied"
OUT="$( PATH="$SORTFAIL:$BIN:$PATH" TMPDIR="$ROOT/tmp" STUB_RC=0 STUB_OUT=" • ${V1}_a.sql" bash -c "
    sh=\"$ROOT/hshim.sh\"
    { echo 'set -Eeuo pipefail'; echo \"source '$HERE/../lib/common.sh'\"
      sed -n '/^ROLLOUT_DIAG_MAX_LINES=/,/^clone_dry_run_pending()/p' '$M'
      sed -n '/^push_dry_run_pending()/p;/^clone_dry_run_pending()/p' '$M'; } > \"\$sh\"
    source \"\$sh\"; set +e; out=\"\$(push_dry_run_pending)\"; rc=\$?; set -e; printf 'RC=%s\nSTDOUT<<%s>>\n' \"\$rc\" \"\$out\"" 2>&1 )"
grep -q 'RC=0' <<<"$OUT" && grep -q 'STDOUT<<>>' <<<"$OUT" \
  && pass "MUTANT (bare parse flow) reports SUCCESS with an EMPTY set on a crashed parser — capturing the parser status is load-bearing" \
  || fail "mutant (h) not distinguishable"
/bin/rm -f "$M"

echo "== MUTANT: restoring \$* in the fallback must be caught =="
M="$(mut argvleak 'warn "the CLI produced NO output; operation: db push --dry-run against the ${label} (exit ${rc})"||=||warn "the CLI produced NO output; command was: supabase db push $* --dry-run (exit ${rc})"')"
grep -q 'command was: supabase db push \$\*' "$M" && pass "mutant (g) built: \$* restored in the no-output fallback" || fail "mutant (g) not applied"
OUT="$( PATH="$BIN:$PATH" TMPDIR="$ROOT/tmp" STUB_RC=3 STUB_OUT="" bash -c "
    sh=\"$ROOT/gshim.sh\"
    { echo 'set -Eeuo pipefail'; echo \"source '$HERE/../lib/common.sh'\"
      sed -n '/^ROLLOUT_DIAG_MAX_LINES=/,/^clone_dry_run_pending()/p' '$M'
      sed -n '/^push_dry_run_pending()/p;/^clone_dry_run_pending()/p' '$M'; } > \"\$sh\"
    source \"\$sh\"; set +e; clone_dry_run_pending '$LEAKY_PLAIN'" 2>&1 )"
grep -q 'FAKE_CLONE_PW_123' <<<"$OUT" \
  && pass "MUTANT (\$* in the fallback) LEAKS the clone password — the label/argv separation is load-bearing" \
  || fail "mutant (g) not distinguishable"
rm -f "$M"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
