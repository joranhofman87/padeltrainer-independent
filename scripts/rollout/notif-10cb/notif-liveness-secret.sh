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
JQ_BIN="${NOTIF_LIVENESS_JQ:-jq}"

readonly EXIT_USAGE=1
readonly EXIT_KC_WRITE=10
readonly EXIT_KC_READ=11
readonly EXIT_SHAPE=12
readonly EXIT_DIFFER=13
readonly EXIT_CMP_ERROR=14
readonly EXIT_EXISTS=15
readonly EXIT_KC_LOOKUP=16
readonly EXIT_BAD_NAME=17
readonly EXIT_ENV_STAGE=20
readonly EXIT_CURL_STAGE=21
readonly EXIT_PLACEHOLDER=22
readonly EXIT_TRANSPORT=30
readonly EXIT_HTTP=31
readonly EXIT_STATE=32
readonly EXIT_NO_PARSER=33
readonly EXIT_BODY_SHAPE=34
readonly EXIT_CLEANUP_FAILED=90

# `security` exit status is OSStatus & 0xFF, so it is LOSSY and codes collide (-25812, -25556,
# -25300 and -25044 all surface as 44). Only these two are relied on, and only to choose between
# "refuse" and "refuse with a better message" — never to decide that a write is safe:
readonly SEC_NOT_FOUND=44        # errSecItemNotFound      (-25300)
readonly SEC_DUPLICATE=45        # errSecDuplicateItem     (-25299)

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
  # `mktemp -d` creates 0700 and `umask 077` reinforces it — so this asserts a property that should
  # already hold rather than establishing one. It is here because everything the token touches lives
  # in this directory, and "should already hold" is exactly the kind of assumption that turns out to
  # be false on a platform nobody tested. Fails closed: an unrecognised mode reads as `unknown`.
  [ "$(file_mode "$WORKDIR")" = "700" ] \
    || die "$EXIT_USAGE" "workdir is not mode 0700 (got $(file_mode "$WORKDIR"))"
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

# ── the service/account names are part of a COMMAND STREAM, so they are validated, not escaped ──
# `security -i` reads whitespace-separated subcommands from stdin, so SERVICE and ACCOUNT are not
# argv here — they are program text. Unvalidated, `--service 'svc -U'` produced:
#
#     add-generic-password -s svc -U -a acct -w <token>
#
# which is UPDATE semantics with no --force: measured, it overwrote a pre-existing value and exited
# 0 reporting success, defeating the entire non-destructive provisioning contract. A newline is
# worse still — it appends a SECOND subcommand, and `security -i` returns only the LAST one's
# status, so the injected command's failure would be invisible.
#
# ESCAPING IS THE WRONG TOOL. `security -i`'s tokenizer is undocumented and there is no quoting form
# to target, so any escaping scheme would be a guess that fails open. An allow-list cannot.
#
# THE SAFE SET: A-Z a-z 0-9 and . _ @ - , never leading '-', never empty, at most 128 bytes. That
# covers every name this rollout uses (`padeltrainer-notif-liveness`, a unix username) and excludes
# every byte that can change the meaning of the stream — space, tab, CR, LF, quotes, backslash.
# Leading '-' is refused separately because it would read as an OPTION in the argv paths too.
readonly SAFE_NAME_DESC="A-Za-z0-9 and . _ @ - (no leading '-', 1..128 chars)"
# THE SET IS ENUMERATED, NOT A RANGE. `[A-Za-z]` is a COLLATION range and its membership depends on
# the caller's locale: under en_US.UTF-8, bash 3.2 accepts `é`, `ß` and full-width `Ｕ` as members,
# while C and C.UTF-8 reject them — measured. An explicit character list has no collation to depend
# on and gives the same answer in every locale, which is the only way the documented safe set above
# is actually the set being enforced.
readonly SAFE_NAME_CLASS='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._@-'
validate_identifier() {   # $1 = value, $2 = what it is
  local v="$1" what="$2"
  [ -n "$v" ] || die "$EXIT_BAD_NAME" "$what is empty; must be ${SAFE_NAME_DESC}"
  case "$v" in
    -*) die "$EXIT_BAD_NAME" "$what begins with '-', which would be read as an option; must be ${SAFE_NAME_DESC}" ;;
  esac
  # A `[!…]` bracket match catches an embedded newline and carriage return as well as spaces and
  # option text — verified, because "the glob probably handles newlines" is exactly the kind of
  # assumption this guard exists to not depend on.
  case "$v" in
    *[!$SAFE_NAME_CLASS]*) die "$EXIT_BAD_NAME" "$what contains a character outside the safe set; must be ${SAFE_NAME_DESC}" ;;
  esac
  # LENGTH IS CHECKED LAST so that its meaning is provable rather than incidental: `${#v}` counts
  # CHARACTERS under a UTF-8 locale and BYTES under C, so a bound applied to arbitrary input means
  # two different things. By here every character has been proven single-byte ASCII and the two
  # agree. Honest note: this ordering is NOT observable — anything the charset check rejects is
  # rejected under either order, so the two orders accept exactly the same set. A mutant that swaps
  # them is equivalent and cannot be killed; that is recorded rather than papered over with a test
  # that would only be exercising the harness.
  [ "${#v}" -le 128 ] || die "$EXIT_BAD_NAME" "$what is ${#v} characters; must be ${SAFE_NAME_DESC}"
}

# Called by EVERY subcommand as its first act after argument parsing — before the work directory,
# before openssl, before any keychain call, before the network.
validate_names() {
  validate_identifier "$SERVICE" "--service"
  validate_identifier "$ACCOUNT" "--account"
}

# ── existence, with lookup FAILURE kept distinct from ABSENCE ─────────────────────────────────
# `find-generic-password` answers three different questions with the same status 44 — "no such
# item", "no such keychain", "not a valid keychain file" — and answers a *locked* keychain with 0
# and a full attribute dump, and a denied one with 36/51. A bare `if find …; then` therefore reads
# EVERY failure as absence, including the cases where an item is sitting there unreadable. Verified:
# a stubbed rc=36 made the helper generate a new token, overwrite the existing value with -U, and
# exit 0 reporting "proven byte-for-byte" — true of the new value, silent about the destroyed one.
#
# This function never concludes that a write is SAFE; that belongs to the write itself (below).
# Sets KC_PRESENCE rather than echoing: `die` inside a command substitution exits the SUBSHELL, so
# a refusal would be swallowed and read as an empty answer.
KC_PRESENCE=""
keychain_presence() {
  local rc=0
  "$SECURITY_BIN" find-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0)                KC_PRESENCE="present" ;;
    "$SEC_NOT_FOUND") KC_PRESENCE="absent"  ;;
    *) die "$EXIT_KC_LOOKUP" "keychain lookup failed (rc=${rc}) — this is NOT 'item not found'. An item may exist and be unreadable (locked keychain, denied access). Refusing before generating or writing anything; nothing was changed." ;;
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
  # FIRST, before the workdir, before openssl, before any keychain call: these names become command
  # text inside `security -i`, and an unvalidated one can restore -U without --force.
  validate_names
  make_workdir

  # Classify the lookup BEFORE generating a token or touching anything — under --force too, because
  # a keychain that cannot be read is not one to write blind.
  keychain_presence
  if [ "$KC_PRESENCE" = "present" ] && [ "$force" -eq 0 ]; then
    die "$EXIT_EXISTS" "a keychain item '$SERVICE' already exists for '$ACCOUNT' — it was NOT modified and no token was generated; pass --force to replace it"
  fi

  local gen="$WORKDIR/gen.token" rc=0
  "$OPENSSL_BIN" rand -base64 39 > "$gen" 2>/dev/null || rc=$?
  [ "$rc" -eq 0 ] || die "$EXIT_USAGE" "token generation failed (rc=${rc})"
  validate_token_file "$gen" "generated token"

  # WRITE SEMANTICS ARE CHOSEN EXPLICITLY, NOT LEFT TO A CONSTANT.
  #   without --force -> CREATE. `add-generic-password` WITHOUT -U fails with 45 on an existing item
  #                      and leaves the stored bytes byte-for-byte untouched (verified: value, sha1
  #                      and mdat all unchanged). That is the only atomic check-and-set the keychain
  #                      offers, and it is what closes the window between the lookup above and this
  #                      line: an item that appears in between is refused BY THE KEYCHAIN, not
  #                      overwritten by us. The lookup exists for the better message, not the safety.
  #   with --force    -> UPDATE. -U replaces in place (cdat preserved, mdat bumped).
  #
  # THE VALUE GOES IN ON STDIN, NEVER IN ARGV. `security -i` reads commands from stdin, so the only
  # process argv is `security -i`; `-w <value>` on the command line is visible in `ps` to every user
  # on the machine, and `security -h` says so itself.
  #
  # EXACTLY ONE SUBCOMMAND PER `security -i`. Verified: -i executes every line it is given and
  # returns only the LAST one's status, so a refused create followed by any successful line would
  # report 0. One line means the status is the answer.
  local upd=""
  if [ "$force" -eq 1 ]; then upd=" -U"; fi
  rc=0
  printf 'add-generic-password -s %s -a %s%s -w %s\n' "$SERVICE" "$ACCOUNT" "$upd" "$(cat "$gen")" \
    | "$SECURITY_BIN" -i >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0) : ;;
    "$SEC_DUPLICATE")
      die "$EXIT_EXISTS" "a keychain item '$SERVICE' appeared for '$ACCOUNT' between the check and the write — the keychain REFUSED the create, so the existing value is unchanged; pass --force to replace it" ;;
    *) die "$EXIT_KC_WRITE" "keychain write failed (rc=${rc}) — nothing was deployed" ;;
  esac

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
  validate_names
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
  validate_names

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
  validate_names

  # PREFLIGHT THE PARSER FIRST — before the keychain is read and before any credentialed request.
  # Two distinct reasons, both measured:
  #   * inside `if jq …; then`, a MISSING jq exits 127, which does NOT trip `set -e` in a condition;
  #     the else branch runs and the operator is told the state was wrong when the truth is that jq
  #     is not installed. The 2>/dev/null that keeps the body out of the terminal also swallows
  #     bash's "command not found", so the only honest place to catch this is up front.
  #   * failing here means no Keychain read and no network call happened at all.
  command -v "$JQ_BIN" >/dev/null 2>&1 \
    || die "$EXIT_NO_PARSER" "jq is required to validate the response structurally, and '${JQ_BIN}' was not found — no keychain read and no request were made"
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
  [ -f "$body" ] || die "$EXIT_BODY_SHAPE" "no response body"

  # STRUCTURAL VALIDATION, NOT TEXT MATCHING.
  #
  # The `grep '"state":"X"'` this replaces matched the target text ANYWHERE in the body, so an error
  # envelope that merely ECHOES the requested state read as success. Both of these are valid JSON,
  # both were measured passing, and in neither is the real top-level state the expected one:
  #     {"ok":false,"state":"query_failed","echo":{"state":"cron_disarmed"}}
  #     [{"state":"query_failed"},{"state":"cron_disarmed"}]
  # It was fail-OPEN on nested objects, arrays, malformed bodies and concatenated JSON streams —
  # and simultaneously fail-CLOSED on any serializer emitting `{"state": "cron_disarmed"}` with a
  # space, so a pretty-printed body would have failed a healthy check.
  #
  # --slurp is load-bearing. jq reads a STREAM by default, so a filter over `input` accepts
  # {"state":"cron_disarmed"}{"state":"anything"} and silently ignores the tail. Slurping makes the
  # whole stream one array, and `length == 1` is what rejects trailing values.
  #
  # --arg, never interpolation: the expected state reaches the filter as DATA, so a value carrying a
  # quote or backslash cannot rewrite the program.
  #
  # NEITHER THE BODY NOR jq's STDERR IS EVER SHOWN. The body is PII-free today and this must not
  # depend on that staying true; jq's parse errors quote the input they choked on, which is the same
  # leak by another route. The EXIT CODE carries the diagnosis instead — 34: not a single JSON
  # object; 32: .state absent, null, non-string, or simply different.
  # A NUL BYTE IS ITS OWN TRAILING-VALUE HOLE. jq stops reading at a NUL and silently ignores
  # everything after it, so `{"state":"cron_disarmed"}\0{"state":"query_failed"}` slurps to a single
  # clean object and passes — measured. That is the same defect --slurp closes for concatenated JSON
  # arriving by a different route, and `length == 1` cannot see it because jq never saw the tail.
  # A JSON response has no business containing a NUL; a truncated or proxy-mangled one might.
  # LC_ALL=C ON `tr` SPECIFICALLY. This is a BYTE operation, and under a UTF-8 locale BSD `tr`
  # rejects invalid UTF-8 input with "Illegal byte sequence" — so a body carrying a bad byte and no
  # NUL at all was reported as "contains a NUL byte" and refused. Measured: the self-test scored
  # 104/104 under LC_ALL=C and 102/104 under C.UTF-8, which is the locale an operator actually has.
  # The suite now runs under UTF-8 by default so this class cannot hide again.
  if ! LC_ALL=C tr -d '\000' < "$body" | cmp -s - "$body"; then
    die "$EXIT_BODY_SHAPE" "response body contains a NUL byte — jq would stop there and ignore the rest (body deliberately not shown)"
  fi
  if ! "$JQ_BIN" -e --slurp 'length == 1 and (.[0] | type) == "object"' "$body" >/dev/null 2>&1; then
    die "$EXIT_BODY_SHAPE" "response body is not a single valid JSON object (body deliberately not shown)"
  fi
  if ! "$JQ_BIN" -e --slurp --arg want "$expect_state" \
         '(.[0].state | type) == "string" and .[0].state == $want' "$body" >/dev/null 2>&1; then
    die "$EXIT_STATE" "response .state is absent, null, non-string, or not '${expect_state}' (body deliberately not shown)"
  fi
  log "check-endpoint: ${expect_status} with state=${expect_state} — as required"
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
