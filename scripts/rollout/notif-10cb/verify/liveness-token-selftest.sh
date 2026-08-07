#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════════════════════
# Executable proof for notif-liveness-secret.sh.
#
# Every case here exists because the prose it replaced got that exact thing wrong, or because a
# plausible implementation would. The signal rows in particular are not decoration: `trap … INT`
# WITHOUT a re-raise cleans up and then lets execution continue to the deploy, exit 0 — measured on
# this machine before the helper was written.
#
# THE STUBS ARE THE POINT. `security`, `supabase`, `curl` and `openssl` are replaced by recording
# fakes, so the failure arms are reachable without a keychain, a network or a project. TMPDIR is
# redirected into a scanned sandbox — which works only because the helper uses an explicit mktemp
# template; the bare and -t forms escape it.
# ══════════════════════════════════════════════════════════════════════════════════════════════
set -Eeuo pipefail
# JOB CONTROL IS REQUIRED FOR THE SIGNAL ROWS. A non-interactive shell sets SIGINT/SIGQUIT to
# SIG_IGN for its BACKGROUND jobs, and bash refuses to install a trap on a signal it inherited as
# ignored — so an INT row would report rc=0 and look like a broken helper when the harness is what
# is broken. `set -m` gives each background job its own process group with default dispositions.
# (This must run under bash; zsh rejects `set -m` outright.)
set -m
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../notif-liveness-secret.sh"
[ -f "$SCRIPT" ] || { printf 'cannot find %s\n' "$SCRIPT" >&2; exit 1; }

PASS=0; FAIL=0
ok()  { printf 'PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/liveness-selftest.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
BIN="$ROOT/bin"; CTL="$ROOT/ctl"; SB="$ROOT/sandbox"
mkdir -p "$BIN" "$CTL" "$SB"

# A fixed, known token so the leak scan can grep for an exact string.
FAKE_TOKEN="ZmFrZXRva2VuZm9ydGVzdGluZ29ubHkxMjM0NTY3ODkwYWJjZGVm"
[ "${#FAKE_TOKEN}" -eq 52 ] || { echo "fixture token must be 52 chars"; exit 1; }

# ── stubs ─────────────────────────────────────────────────────────────────────────────────────
cat > "$BIN/openssl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "ARGV openssl $*" >> "$STUB_LOG"
printf '%s\n' "$FAKE_TOKEN"
STUB

# A stateful fake keychain. STUB_KC_CORRUPT bends the READBACK only, so the write can succeed while
# the value that comes back is wrong — which is the whole point of the byte-for-byte proof.
cat > "$BIN/security" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "ARGV security $*" >> "$STUB_LOG"
STORE="$CTL/kcstore"
if [ "${1:-}" = "-i" ]; then
  [ "${STUB_RC_SECURITY_ADD:-0}" = "0" ] || exit "${STUB_RC_SECURITY_ADD}"
  line="$(cat)"                                  # value arrives on STDIN, never argv
  printf '%s\n' "$line" >> "$CTL/stdin.log"
  printf '%s' "${line##*-w }" > "$STORE"
  exit 0
fi
case "${1:-}" in
  find-generic-password)
    [ "${STUB_RC_SECURITY_FIND:-0}" = "0" ] || exit "${STUB_RC_SECURITY_FIND}"
    case " $* " in *" -w "*) ;; *) [ -s "$STORE" ] && exit 0 || exit 44 ;; esac
    [ -s "$STORE" ] || exit 44
    # Signal rows: announce that we are running, then hold, so the harness can signal a helper that
    # is genuinely mid-flight rather than racing its startup.
    if [ -n "${STUB_HOLD:-}" ]; then printf 'holding\n' > "$CTL/holding.marker"; sleep "${STUB_HOLD}"; fi
    case "${STUB_KC_CORRUPT:-none}" in
      empty)             printf '' ;;
      truncated)         printf '%s\n' "shortvalue" ;;
      multiline)         printf 'aaa\nbbb' ;;
      trailing_newlines) printf '%s\n\n\n' "$(cat "$STORE")" ;;
      hex)               printf '%s\n' "41420943440a4142c3a943" ;;
      mismatch)          printf '%s\n' "ZGlmZmVyZW50VG9rZW5WYWx1ZUJ1dFdlbGxGb3JtZWRfMzliISEA" ;;   # 52 chars: well-formed, so it reaches cmp not the shape check
      *)                 printf '%s\n' "$(cat "$STORE")" ;;
    esac
    exit 0 ;;
esac
exit 0
STUB

cat > "$BIN/supabase" <<'STUB'
#!/usr/bin/env bash
# A child that CATCHES INT and exits 0 — exactly what Go CLIs like the real supabase do. With only
# an EXIT trap the helper saw rc=0 and ran the NEXT statement; this stub is what proves otherwise.
[ -n "${STUB_CMD_TRAPS_INT:-}" ] && trap 'exit 0' INT
printf '%s\n' "ARGV supabase $*" >> "$STUB_LOG"
printf 'supabase-reached\n' >> "$CTL/deploy.marker"
for a in "$@"; do
  case "$a" in
    *liveness.env) [ -r "$a" ] && cp "$a" "$CTL/seen.env" ;;
  esac
done
exit "${STUB_RC_SUPABASE:-0}"
STUB

cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "ARGV curl $*" >> "$STUB_LOG"
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
if [ "${STUB_RC_CURL:-0}" != "0" ]; then printf '000'; exit "${STUB_RC_CURL}"; fi
[ -n "$out" ] && printf '%s' "${STUB_CURL_BODY:-{\"state\":\"cron_disarmed\"}}" > "$out"
printf '%s' "${STUB_CURL_CODE:-503}"
exit 0
STUB

# Never expected to run; its presence proves absence rather than assuming it.
cat > "$BIN/pbcopy" <<'STUB'
#!/usr/bin/env bash
printf 'pbcopy-INVOKED\n' >> "$CTL/pbcopy.marker"
cat > /dev/null
STUB
chmod +x "$BIN"/*

# ── harness ───────────────────────────────────────────────────────────────────────────────────
reset_state() {
  rm -rf "$SB"; mkdir -p "$SB"
  rm -f "$CTL/deploy.marker" "$CTL/pbcopy.marker" "$CTL/kcstore" "$CTL/seen.env" "$CTL/stdin.log"
  : > "$CTL/stub.log"
  # `with-env` and `check-endpoint` READ an item that provisioning already created; seed it for
  # those rows. `provision` must NOT see one, or it refuses with 15 (already exists) — which is
  # itself correct behaviour and separately asserted.
  [ "${SEED_KC:-0}" = "1" ] && printf '%s' "$FAKE_TOKEN" > "$CTL/kcstore"
  return 0
}

# Run the helper with stubs on PATH and TMPDIR inside the scanned sandbox.
run_helper() {   # run_helper <outfile> -- args...
  local outfile="$1"; shift 2
  env PATH="$BIN:$PATH" TMPDIR="$SB" STUB_LOG="$CTL/stub.log" CTL="$CTL" FAKE_TOKEN="$FAKE_TOKEN" \
      NOTIF_LIVENESS_OPENSSL="$BIN/openssl" NOTIF_LIVENESS_SECURITY="$BIN/security" \
      NOTIF_LIVENESS_CURL="$BIN/curl" \
      STUB_RC_SECURITY_ADD="${STUB_RC_SECURITY_ADD:-0}" STUB_RC_SECURITY_FIND="${STUB_RC_SECURITY_FIND:-0}" \
      STUB_RC_SUPABASE="${STUB_RC_SUPABASE:-0}" STUB_RC_CURL="${STUB_RC_CURL:-0}" \
      STUB_KC_CORRUPT="${STUB_KC_CORRUPT:-none}" STUB_CURL_CODE="${STUB_CURL_CODE:-503}" \
      STUB_CURL_BODY="${STUB_CURL_BODY:-}" \
      bash "$SCRIPT" "$@" > "$outfile" 2>&1
}

expect_rc() {   # expect_rc <name> <want> -- args...
  local name="$1" want="$2"; shift 3
  reset_state
  local out="$ROOT/out.txt" rc=0
  run_helper "$out" -- "$@" || rc=$?
  [ "$rc" = "$want" ] && ok "$name (rc=$rc)" || { bad "$name (rc=$rc, want $want)"; sed 's/^/      /' "$out"; }
  LAST_OUT="$out"
}

no_deploy()  { [ ! -f "$CTL/deploy.marker" ] && ok "...the mutating command was NEVER reached" || bad "...the mutating command was NEVER reached"; }
did_deploy() { [ -f "$CTL/deploy.marker" ]  && ok "...the mutating command WAS reached" || bad "...the mutating command WAS reached"; }
no_pbcopy()  { [ ! -f "$CTL/pbcopy.marker" ] && ok "...the clipboard was never touched" || bad "...the clipboard was never touched"; }
no_residue() {
  local n; n=$(find "$SB" -mindepth 1 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" = "0" ] && ok "...no temp material left behind" || { bad "...no temp material left behind ($n entries)"; find "$SB" -mindepth 1 | sed 's/^/      /'; }
}
no_token_leak() {
  local hits=0
  grep -qF -- "$FAKE_TOKEN" "$LAST_OUT" && hits=$((hits+1))
  if [ -d "$SB" ]; then
    local n; n=$(find "$SB" -type f -exec grep -lF -- "$FAKE_TOKEN" {} + 2>/dev/null | wc -l | tr -d ' ')
    hits=$((hits+n))
  fi
  # the stub argv log is the argv-exposure check
  grep -qF -- "$FAKE_TOKEN" "$CTL/stub.log" && hits=$((hits+1))
  [ "$hits" = "0" ] && ok "...the token appears in no output, no file and no argv" \
    || { bad "...the token appears in no output, no file and no argv ($hits)"; }
}

case "$-" in *m*) : ;; *) printf 'FATAL: job control (set -m) is not active; signal rows would be vacuous\n' >&2; exit 1 ;; esac

printf '\n===== notif-liveness-secret.sh — executable proof =====\n\n'

# ── happy paths ───────────────────────────────────────────────────────────────────────────────
expect_rc "provision: succeeds and proves the round trip" 0 -- provision --service svc --account acct
no_pbcopy; no_residue; no_token_leak
grep -q 'ARGV security -i' "$CTL/stub.log" && ok "...the value went in on STDIN, not argv" || bad "...the value went in on STDIN, not argv"
grep -q 'add-generic-password' "$CTL/stdin.log" && ok "...and security received it as a stdin command" || bad "...and security received it as a stdin command"

SEED_KC=1 expect_rc "with-env: stages the env file and runs the command" 0 -- with-env --service svc --account acct -- supabase secrets set --env-file '{}' --project-ref demo
did_deploy; no_residue; no_token_leak; no_pbcopy
[ -f "$CTL/seen.env" ] && grep -q "NOTIF_LIVENESS_TOKEN=$FAKE_TOKEN" "$CTL/seen.env" \
  && ok "...the command saw a readable env file with the exact token" || bad "...the command saw a readable env file with the exact token"

SEED_KC=1 expect_rc "check-endpoint: 503 + cron_disarmed is the required answer" 0 -- check-endpoint --url http://x --expect-status 503 --expect-state cron_disarmed --service svc --account acct
no_residue; no_token_leak
grep -q -- '--config' "$CTL/stub.log" && ok "...curl used a config file" || bad "...curl used a config file"
grep -qE 'ARGV curl .*(-f|--fail)( |$)' "$CTL/stub.log" && bad "...curl did NOT use -f" || ok "...curl did NOT use -f"
grep -q -- '-H ' "$CTL/stub.log" && bad "...the token was not passed with -H" || ok "...the token was not passed with -H"

# ── credential failures must stop everything downstream ───────────────────────────────────────
STUB_RC_SECURITY_ADD=1 expect_rc "keychain WRITE failure stops before anything else" 10 -- provision --service svc --account acct
no_deploy; no_residue
STUB_RC_SECURITY_FIND=44 SEED_KC=1 expect_rc "keychain READ failure (item absent)" 11 -- with-env --service svc --account acct -- supabase secrets set --env-file '{}'
no_deploy; no_residue

# ── the shape checks, each pinned to a specific fail-open ──────────────────────────────────────
STUB_KC_CORRUPT=empty expect_rc "an EMPTY readback is rejected (two empty files compare identical)" 12 -- provision --service svc --account acct
no_deploy
STUB_KC_CORRUPT=truncated expect_rc "a TRUNCATED readback is rejected" 12 -- provision --service svc --account acct
STUB_KC_CORRUPT=multiline expect_rc "a MULTILINE readback is rejected (wc -l would accept it)" 12 -- provision --service svc --account acct
STUB_KC_CORRUPT=trailing_newlines expect_rc "TRAILING NEWLINES are rejected (normalising would hide this)" 12 -- provision --service svc --account acct
STUB_KC_CORRUPT=hex expect_rc "a HEX readback is rejected (what security returns for non-printables)" 12 -- provision --service svc --account acct
STUB_KC_CORRUPT=mismatch expect_rc "a WELL-FORMED but DIFFERENT value is rejected as a mismatch" 13 -- provision --service svc --account acct
no_deploy; no_residue

# ── the command's own status is preserved, and the env file still disappears ───────────────────
STUB_RC_SUPABASE=1 SEED_KC=1 expect_rc "with-env preserves the COMMAND's failing status" 1 -- with-env --service svc --account acct -- supabase secrets set --env-file '{}'
did_deploy; no_residue; no_token_leak

# ── endpoint verification cannot end in 0 on failure ───────────────────────────────────────────
STUB_RC_CURL=7 SEED_KC=1 expect_rc "a curl TRANSPORT failure is not 0" 30 -- check-endpoint --url http://x --expect-status 503 --expect-state cron_disarmed --service svc --account acct
STUB_CURL_CODE=200 SEED_KC=1 expect_rc "the WRONG http status fails" 31 -- check-endpoint --url http://x --expect-status 503 --expect-state cron_disarmed --service svc --account acct
STUB_CURL_BODY='{"state":"stale"}' SEED_KC=1 expect_rc "the RIGHT status with the WRONG state fails" 32 -- check-endpoint --url http://x --expect-status 503 --expect-state cron_disarmed --service svc --account acct
STUB_CURL_CODE=401 STUB_CURL_BODY='{"ok":false,"state":"unauthorized"}' SEED_KC=1 expect_rc "a 401 never reads as success" 31 -- check-endpoint --url http://x --expect-status 503 --expect-state cron_disarmed --service svc --account acct
no_residue

# ── SIGNALS: cleanup must run, the status must be non-zero, and nothing after may execute ─────
# This is the case the prose got wrong: `trap 'rm …' INT` cleaned up and then let execution CONTINUE
# to the deploy, exit 0. Each row asserts all four facts, because on some delivery paths "no traps
# at all" is indistinguishable from correct on exit status alone.
signal_row() {   # signal_row <name> <sig> <want_rc>
  local name="$1" sig="$2" want="$3"
  SEED_KC=1 reset_state
  rm -f "$CTL/holding.marker"
  local out="$ROOT/sig.out" rc=0
  ( STUB_HOLD=3 run_helper "$out" -- with-env --service svc --account acct -- supabase secrets set --env-file '{}' ) &
  local hp=$!
  local waited=0
  while [ ! -f "$CTL/holding.marker" ] && [ "$waited" -lt 50 ]; do sleep 0.1; waited=$((waited+1)); done
  if [ ! -f "$CTL/holding.marker" ]; then bad "$name (helper never reached the hold)"; return; fi
  # signal the helper's own process group member — the subshell running it
  pkill -"$sig" -P "$hp" 2>/dev/null || kill -"$sig" "$hp" 2>/dev/null || true
  wait "$hp" 2>/dev/null || rc=$?
  [ "$rc" = "$want" ] && ok "$name -> rc=$rc" || { bad "$name (rc=$rc, want $want)"; sed 's/^/      /' "$out" 2>/dev/null | head -5; }
  [ ! -f "$CTL/deploy.marker" ] && ok "...and the command after the signal NEVER ran" || bad "...and the command after the signal NEVER ran"
  local n; n=$(find "$SB" -mindepth 1 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" = "0" ] && ok "...and cleanup removed the secret material" || bad "...and cleanup removed the secret material ($n left)"
}

signal_row "SIGINT aborts"  INT  130
signal_row "SIGTERM aborts" TERM 143
signal_row "SIGHUP aborts"  HUP  129

printf '\n================  %s passed, %s failed  ================\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
