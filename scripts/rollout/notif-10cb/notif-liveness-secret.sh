#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════════════════════
# N7 step 3c — the liveness monitor credential, handled so that it never becomes visible.
#
# WHY THIS IS A SCRIPT AND NOT A DOC SNIPPET. The prose blocks this replaces were not fail-closed,
# and the reasons are not obvious enough to survive being copied:
#
#   * they had no strict mode, so a failing `security` or `secrets set` was followed by the deploy
#     and the block exited 0 — verified;
#   * `trap 'rm …' INT` does NOT terminate bash. Cleanup ran and execution CONTINUED to the end,
#     exit 0 — verified. Ctrl-C during provisioning would have deleted the env file and deployed
#     anyway;
#   * scoping the cleanup correctly (a subshell, so the trap fires at the closing paren) put the
#     curl config out of scope for the step that needed it — so the fix broke the next step;
#   * and it printed the token to the terminal so the operator could paste it.
#
# Each of those is a one-line mistake that reads fine in a diff. They belong in a file with tests.
#
# PRODUCTION MUTATIONS STAY OUT. This never runs `supabase secrets set`, never deploys, never calls
# run-enablement.sh. It provisions and proves a credential and checks an endpoint; the operator's
# runbook wraps the mutation with `with-env`, which is the only way the token reaches the command
# that needs it without touching argv, history or a file that outlives the process.
#
# Targets bash 3.2.57 (/bin/bash on macOS): no inherit_errexit, no BASHPID, and `${arr[@]}` on an
# empty array is fatal under `set -u`.
# ══════════════════════════════════════════════════════════════════════════════════════════════
set -Eeuo pipefail
umask 077

# Refuse to run traced: `set -x` would echo the token into the operator's terminal, which is the one
# thing this script exists to prevent.
case $- in *x*) printf 'notif-liveness-secret: refusing to run with xtrace enabled\n' >&2; exit 1 ;; esac

# Test seams. Defaults are the real tools; the self-test points these at stubs. `openssl` is pinned
# absolutely on purpose — a Homebrew openssl and /usr/bin/openssl are different implementations and
# the token's alphabet must not depend on which one is first in PATH.
OPENSSL_BIN="${NOTIF_LIVENESS_OPENSSL:-/usr/bin/openssl}"
SECURITY_BIN="${NOTIF_LIVENESS_SECURITY:-/usr/bin/security}"
CURL_BIN="${NOTIF_LIVENESS_CURL:-curl}"

readonly EXIT_USAGE=1
readonly EXIT_KC_WRITE=10
readonly EXIT_KC_READ=11
readonly EXIT_SHAPE=12
readonly EXIT_DIFFER=13
readonly EXIT_CMP_ERROR=14
readonly EXIT_EXISTS=15
readonly EXIT_ENV_STAGE=20
readonly EXIT_CURL_STAGE=21
readonly EXIT_PLACEHOLDER=22
readonly EXIT_TRANSPORT=30
readonly EXIT_HTTP=31
readonly EXIT_STATE=32
readonly EXIT_CLEANUP_FAILED=90

# 39 random bytes -> exactly 52 base64 chars, no padding, no wrapping. Plus one trailing newline the
# keychain readback also produces: 53 bytes is the whole shape contract.
readonly TOKEN_BYTES=53

SERVICE="padeltrainer-notif-liveness"
ACCOUNT="${USER:-unknown}"
WORKDIR=""
CLEANUP_RC=0
CLEANED=0

log()  { printf '%s\n' "$*" >&2; }                 # stderr only, and NEVER the secret
die()  { local c="$1"; shift; log "ERROR: $*"; exit "$c"; }

# `set +e` for the WHOLE body. With `set -e` live, a failing early step aborts the rest of cleanup —
# so the later removals never run — AND replaces the original exit status. Verified: exit 3 with a
# failing cleanup step reported the cleanup's status instead.
do_cleanup() {
  [ "$CLEANED" -eq 1 ] && return 0
  set +e
  if [ -n "$WORKDIR" ] && [ -e "$WORKDIR" ]; then
    rm -rf -- "$WORKDIR" 2>/dev/null
    # ABSENCE IS VERIFIED, not assumed. `rm -rf` returns 0 on an immutable or busy directory.
    if [ -e "$WORKDIR" ]; then
      log "WARN: secret material remains at $WORKDIR"
      CLEANUP_RC=1
    fi
  fi
  set -e
  CLEANED=1        # set AFTER the work: a partial cleanup must never read as complete
  return 0
}

on_exit() {
  local rc=$?      # MUST be the literal first statement — `local rc; rc=$?` captures local's status
  trap - EXIT
  do_cleanup
  if [ "$CLEANUP_RC" -ne 0 ]; then
    log "CLEANUP FAILED - secret material may remain"
    # Escalate from success only. A cleanup failure must never overwrite a real failure's status.
    [ "$rc" -eq 0 ] && rc="$EXIT_CLEANUP_FAILED"
  fi
  exit "$rc"
}

# ORDER IS LOAD-BEARING, and the obvious version is wrong twice over.
#   * An EXIT trap alone does not stop execution when a child absorbs the signal and exits 0 — which
#     is exactly what Go CLIs do. Measured: rc=0 and the NEXT command ran.
#   * `trap - INT TERM HUP` (disarm) lets a second Ctrl-C kill cleanup half-way. `trap ''` (ignore)
#     does not, and unlike a handler it is inherited by the subshells cleanup spawns.
on_signal() {
  local sig="$1"
  trap - EXIT
  trap '' INT TERM HUP
  log "SIG${sig} received - aborting"
  do_cleanup
  [ "$CLEANUP_RC" -ne 0 ] && log "CLEANUP FAILED during signal abort"
  trap - "$sig"
  kill -s "$sig" "$$"     # die BY the signal: 130/143/129, and execution cannot continue
  exit 128                # unreachable
}

trap on_exit EXIT
trap 'on_signal INT'  INT
trap 'on_signal TERM' TERM
trap 'on_signal HUP'  HUP

# Portable file mode. The two `stat` dialects are not merely different flags — they are
# INCOMPATIBLE in a way that fails open: on GNU, `stat -f FILE` means "report the FILE SYSTEM" and
# exits 0 with unrelated output, so a `stat -f … || stat -c …` fallback never reaches the fallback
# and the comparison silently fails. Try GNU first, then validate the result is octal digits before
# believing it. (Found by CI: this passed on macOS and failed on ubuntu-latest.)
file_mode() {
  local f="$1" m=""
  m="$(stat -c '%a' "$f" 2>/dev/null)" || m=""
  case "$m" in
    ''|*[!0-7]*) m="$(stat -f '%Lp' "$f" 2>/dev/null)" || m="" ;;
  esac
  case "$m" in
    ''|*[!0-7]*) printf 'unknown' ;;
    *) printf '%s' "$m" ;;
  esac
}

make_workdir() {
  # An explicit template honours TMPDIR; the bare and -t forms escape a test sandbox.
  WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/notif-liveness.XXXXXX")" || die "$EXIT_USAGE" "mktemp failed"
}

# ── shape validation ──────────────────────────────────────────────────────────────────────────
# Never prints the value. Checks bytes, newline structure and charset — in that order, because a
# hex-encoded readback (what `security` silently returns for non-printable bytes) is the wrong
# length before it is the wrong charset.
validate_token_file() {
  local f="$1" what="$2" bytes newlines last
  [ -f "$f" ] || die "$EXIT_SHAPE" "$what: no token file"
  bytes=$(wc -c < "$f" | tr -d ' ')
  [ "$bytes" -eq "$TOKEN_BYTES" ] || die "$EXIT_SHAPE" "$what: expected ${TOKEN_BYTES} bytes, got ${bytes} (empty, truncated or padded)"
  # `wc -l` counts NEWLINES, not lines, and happily accepts 'aaa\nbbb'. Require exactly one, at the
  # very end — that rejects embedded newlines and trailing blank lines alike.
  newlines=$(tr -dc '\n' < "$f" | wc -c | tr -d ' ')
  [ "$newlines" -eq 1 ] || die "$EXIT_SHAPE" "$what: expected a single trailing newline, found ${newlines}"
  last=$(tail -c 1 "$f" | od -An -c | tr -d ' ')
  [ "$last" = '\n' ] || die "$EXIT_SHAPE" "$what: value is not newline-terminated"
  # `grep -q` returns 1 on NO match, which under set -e aborts the GOOD path — so it is wrapped.
  # grep reads the line WITHOUT its terminating newline, so the trailing \n does not itself trip
  # the charset check — proven in the self-test's happy path rather than assumed.
  if grep -q '[^A-Za-z0-9+/]' "$f" 2>/dev/null; then
    die "$EXIT_SHAPE" "$what: value is outside the base64 alphabet (a hex readback looks like this)"
  fi
}

# ── byte-for-byte proof, without displaying or hashing either side ────────────────────────────
# `cmp -s` alone fails OPEN in two ways: two EMPTY files compare identical, and process
# substitution of a failing command yields two empty streams that also compare identical. So both
# sides are real files, both are shape-validated first, and cmp's THREE statuses are distinguished.
prove_identical() {
  local a="$1" b="$2" what="$3" rc=0
  [ -s "$a" ] || die "$EXIT_CMP_ERROR" "$what: left side is empty or missing"
  [ -s "$b" ] || die "$EXIT_CMP_ERROR" "$what: right side is empty or missing"
  cmp -s "$a" "$b" || rc=$?
  case "$rc" in
    0) : ;;
    1) die "$EXIT_DIFFER" "$what: values DIFFER" ;;
    *) die "$EXIT_CMP_ERROR" "$what: cmp could not compare (rc=${rc})" ;;
  esac
}

keychain_read() {   # $1 = destination file
  local dest="$1" rc=0
  "$SECURITY_BIN" find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w > "$dest" 2>/dev/null || rc=$?
  [ "$rc" -eq 0 ] || die "$EXIT_KC_READ" "keychain read failed (rc=${rc}) — item absent, locked, or access denied"
}

# ── subcommands ───────────────────────────────────────────────────────────────────────────────

cmd_provision() {
  local force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --service) SERVICE="$2"; shift 2 ;;
      --account) ACCOUNT="$2"; shift 2 ;;
      --force)   force=1; shift ;;
      *) die "$EXIT_USAGE" "provision: unknown argument '$1'" ;;
    esac
  done
  make_workdir

  if [ "$force" -eq 0 ]; then
    if "$SECURITY_BIN" find-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1; then
      die "$EXIT_EXISTS" "a keychain item '$SERVICE' already exists for '$ACCOUNT' — pass --force to replace it"
    fi
  fi

  local gen="$WORKDIR/gen.token" rc=0
  "$OPENSSL_BIN" rand -base64 39 > "$gen" 2>/dev/null || rc=$?
  [ "$rc" -eq 0 ] || die "$EXIT_USAGE" "token generation failed (rc=${rc})"
  validate_token_file "$gen" "generated token"

  # THE VALUE GOES IN ON STDIN, NEVER IN ARGV. `security -i` reads commands from stdin, so the only
  # process argv is `security -i`; `-w <value>` on the command line is visible in `ps` to every user
  # on the machine, and `security -h` says so itself.
  rc=0
  printf 'add-generic-password -s %s -a %s -U -w %s\n' "$SERVICE" "$ACCOUNT" "$(cat "$gen")" \
    | "$SECURITY_BIN" -i >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || die "$EXIT_KC_WRITE" "keychain write failed (rc=${rc}) — nothing was deployed"

  local back="$WORKDIR/readback.token"
  keychain_read "$back"
  validate_token_file "$back" "keychain readback"
  prove_identical "$gen" "$back" "generated vs keychain"

  log "provisioned: '$SERVICE' now holds the generated value (proven byte-for-byte; never displayed)"
}

cmd_verify_keychain() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --service) SERVICE="$2"; shift 2 ;;
      --account) ACCOUNT="$2"; shift 2 ;;
      *) die "$EXIT_USAGE" "verify-keychain: unknown argument '$1'" ;;
    esac
  done
  make_workdir
  local back="$WORKDIR/readback.token"
  keychain_read "$back"
  validate_token_file "$back" "keychain readback"
  log "verify-keychain: '$SERVICE' holds a well-formed value (not displayed)"
}

cmd_with_env() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --service) SERVICE="$2"; shift 2 ;;
      --account) ACCOUNT="$2"; shift 2 ;;
      --) shift; break ;;
      *) die "$EXIT_USAGE" "with-env: unknown argument '$1'" ;;
    esac
  done
  [ $# -gt 0 ] || die "$EXIT_USAGE" "with-env: no command given after --"

  # EXACTLY ONE {} — checked BEFORE any credential is read or staged.
  #
  # Without this, `with-env -- some-command` proves the credential, stages an env file, runs a
  # command that never receives it, and returns that command's 0. The operator is then told the
  # secret was delivered when nothing consumed it — the one failure this helper exists to prevent,
  # arriving as a success. More than one is refused too: it is far more likely a mistake than an
  # intent to hand the same path to two arguments, and guessing wrong here is not recoverable.
  #
  # Its own exit code, not EXIT_USAGE, because with-env returns the wrapped COMMAND's status
  # verbatim — a 1 here would be indistinguishable from the command itself failing.
  local placeholders=0 arg
  for arg in "$@"; do
    [ "$arg" = "{}" ] && placeholders=$((placeholders + 1))
  done
  case "$placeholders" in
    1) : ;;
    0) die "$EXIT_PLACEHOLDER" "with-env: the command contains no {} — it would run WITHOUT the credential and report success" ;;
    *) die "$EXIT_PLACEHOLDER" "with-env: the command contains ${placeholders} {} placeholders; exactly one is required" ;;
  esac

  make_workdir

  local back="$WORKDIR/readback.token"
  keychain_read "$back"
  validate_token_file "$back" "keychain readback"

  local envfile="$WORKDIR/liveness.env"
  printf 'NOTIF_LIVENESS_TOKEN=%s\n' "$(cat "$back")" > "$envfile" \
    || die "$EXIT_ENV_STAGE" "could not stage the env file"
  [ "$(file_mode "$envfile")" = "600" ] \
    || die "$EXIT_ENV_STAGE" "env file is not mode 0600 (got $(file_mode "$envfile"))"

  # RE-EXTRACT FROM THE FINISHED ARTEFACT and compare against the keychain readback. Proving that
  # both were "built from the same variable" proves nothing about the file that will actually be
  # deployed — a truncated write or a quoting accident lives in the file, not in the variable.
  local roundtrip="$WORKDIR/roundtrip.token"
  sed -n 's/^NOTIF_LIVENESS_TOKEN=//p' "$envfile" > "$roundtrip" \
    || die "$EXIT_ENV_STAGE" "could not re-extract the staged value"
  validate_token_file "$roundtrip" "env-file round trip"
  prove_identical "$back" "$roundtrip" "keychain vs staged env file"

  log "staged env file, running command"
  local -a argv=()
  local a
  for a in "$@"; do
    if [ "$a" = "{}" ]; then argv[${#argv[@]}]="$envfile"; else argv[${#argv[@]}]="$a"; fi
  done

  local rc=0
  "${argv[@]}" || rc=$?
  return "$rc"      # the command's status, verbatim
}

cmd_check_endpoint() {
  local url="" expect_status="" expect_state=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --url)           url="$2"; shift 2 ;;
      --expect-status) expect_status="$2"; shift 2 ;;
      --expect-state)  expect_state="$2"; shift 2 ;;
      --service)       SERVICE="$2"; shift 2 ;;
      --account)       ACCOUNT="$2"; shift 2 ;;
      *) die "$EXIT_USAGE" "check-endpoint: unknown argument '$1'" ;;
    esac
  done
  # `${VAR:?msg}` would be wrong here: it destroys the status before any trap runs, and with an EXIT
  # trap installed the script reports 0. This repo has been bitten by that before.
  [ -n "$url" ]           || die "$EXIT_USAGE" "check-endpoint: --url is required"
  [ -n "$expect_status" ] || die "$EXIT_USAGE" "check-endpoint: --expect-status is required"
  [ -n "$expect_state" ]  || die "$EXIT_USAGE" "check-endpoint: --expect-state is required"
  make_workdir

  local back="$WORKDIR/readback.token"
  keychain_read "$back"
  validate_token_file "$back" "keychain readback"

  # Built with a redirect, never a pipe: `security … | sed … > cfg` yields a 0-byte config at rc=0
  # when security fails, and curl then runs with no Authorization header at all.
  local cfg="$WORKDIR/curlrc"
  printf 'header = "Authorization: Bearer %s"\n' "$(cat "$back")" > "$cfg" \
    || die "$EXIT_CURL_STAGE" "could not stage the curl config"
  [ -s "$cfg" ] || die "$EXIT_CURL_STAGE" "staged curl config is empty"

  local body="$WORKDIR/body.json" code="" rc=0
  # Defence in depth, and deliberately NOT claimed as a live guard: WORKDIR is fresh per invocation
  # and curl runs once, so no stale body can exist today. It matters the moment anyone adds a retry
  # loop, because a body from the previous attempt survives a FAILED curl and would satisfy the
  # state check below. The self-test cannot kill a mutant that removes this line, and that is
  # recorded rather than papered over with a test that only exercises the helper's own scaffolding.
  rm -f "$body"
  # No -f (it suppresses the body, and the expected answer here IS an HTTP error). No -H (argv).
  code="$("$CURL_BIN" -s -o "$body" -w '%{http_code}' --config "$cfg" "$url")" || rc=$?
  [ "$rc" -eq 0 ] || die "$EXIT_TRANSPORT" "curl transport failure (rc=${rc}) — endpoint unreachable, TLS or config error"

  # String comparison: `[ "" -eq 503 ]` is an arithmetic error, not a false.
  [ "$code" = "$expect_status" ] || die "$EXIT_HTTP" "expected HTTP ${expect_status}, got '${code}'"
  [ -f "$body" ] || die "$EXIT_STATE" "no response body"
  if grep -q "\"state\":\"${expect_state}\"" "$body"; then
    log "check-endpoint: ${expect_status} with state=${expect_state} — as required"
  else
    die "$EXIT_STATE" "expected state='${expect_state}'; body did not contain it"
  fi
}

usage() {
  cat >&2 <<'USAGE'
notif-liveness-secret.sh — provision and prove the notif-liveness monitor credential.

  provision        [--service NAME] [--account NAME] [--force]
  verify-keychain  [--service NAME] [--account NAME]
  with-env         [--service NAME] [--account NAME] -- CMD [ARG...]   ({} := env-file path)
  check-endpoint   --url URL --expect-status N --expect-state S [--service NAME] [--account NAME]

The token is never printed, never placed in argv, never written anywhere that outlives the process.
This script performs NO production mutation: wrap the mutating command with `with-env`.
USAGE
}

[ $# -gt 0 ] || { usage; exit "$EXIT_USAGE"; }
SUB="$1"; shift
case "$SUB" in
  provision)       cmd_provision "$@" ;;
  verify-keychain) cmd_verify_keychain "$@" ;;
  with-env)        cmd_with_env "$@" ;;
  check-endpoint)  cmd_check_endpoint "$@" ;;
  -h|--help|help)  usage; exit 0 ;;
  *) usage; die "$EXIT_USAGE" "unknown subcommand '$SUB'" ;;
esac
