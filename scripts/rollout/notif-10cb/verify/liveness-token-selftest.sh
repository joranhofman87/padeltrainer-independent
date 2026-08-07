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
# A DISTINCT well-formed value standing in for "what was already in the keychain". It must not equal
# FAKE_TOKEN, or "preserved" and "overwritten" would look identical.
PRIOR_TOKEN="cHJpb3JrZXljaGFpbnZhbHVlOTg3NjU0MzIxMHp5eHd2dXRzcnFw"
[ "${#PRIOR_TOKEN}" -eq 52 ] || { echo "prior fixture token must be 52 chars"; exit 1; }
[ "$PRIOR_TOKEN" != "$FAKE_TOKEN" ] || { echo "fixtures must differ"; exit 1; }

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
  # REAL KEYCHAIN SEMANTICS, measured on macOS 26.5 against a temp keychain:
  #   add-generic-password WITHOUT -U on an existing item -> exit 45 (errSecDuplicateItem) and the
  #                        stored bytes are UNTOUCHED (value, sha1 and mdat all verified unchanged);
  #   WITH -U            -> exit 0, replaces in place.
  # Modelling this is what makes the create-vs-update rows mean anything: a stub that always wrote
  # would pass an unconditional -U just as happily.
  case "$line" in
    *" -U "*) printf '%s' "${line##*-w }" > "$STORE"; printf 'UPDATE\n' >> "$CTL/write.log"; exit 0 ;;
  esac
  if [ -s "$STORE" ]; then
    printf 'security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain.\n' >&2
    printf 'REFUSED\n' >> "$CTL/write.log"
    exit 45
  fi
  printf '%s' "${line##*-w }" > "$STORE"; printf 'CREATE\n' >> "$CTL/write.log"
  exit 0
fi
case "${1:-}" in
  find-generic-password)
    [ "${STUB_RC_SECURITY_FIND:-0}" = "0" ] || exit "${STUB_RC_SECURITY_FIND}"
    # The PRESENCE probe (no -w) and the value READBACK (-w) are separate calls with separate
    # outcomes. STUB_RC_FIND_PRESENCE bends ONLY the probe — which is what lets the race row answer
    # "absent" to the lookup while the store is genuinely occupied by the time the write lands.
    case " $* " in
      *" -w "*) ;;
      *) [ -n "${STUB_RC_FIND_PRESENCE:-}" ] && exit "${STUB_RC_FIND_PRESENCE}"
         [ -s "$STORE" ] && exit 0 || exit 44 ;;
    esac
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
# The default is assigned in a STATEMENT, never inline in a `${VAR:-…}` whose word contains braces.
# It used to be `${STUB_CURL_BODY:-{\"state\":\"cron_disarmed\"}}`, and bash closes the expansion at
# the FIRST `}` — so a literal `}` was appended to every explicitly-set body and the rows were
# silently exercising malformed JSON. `grep` could not see it; a structural parser can.
body="${STUB_CURL_BODY:-}"
[ -z "$body" ] && body='{"state":"cron_disarmed"}'
# …which leaves no way to ask for a genuinely EMPTY body, hence the sentinel.
[ "$body" = "@EMPTY@" ] && body=''
if [ -n "$out" ]; then
  case "$body" in
    # An environment variable cannot carry a NUL byte, and neither can `$(…)` — it strips them. So
    # the marker is split and the NUL written straight to the file.
    *@NUL@*) printf '%s' "${body%%@NUL@*}" > "$out"
             printf '\000'                 >> "$out"
             printf '%s' "${body#*@NUL@}"  >> "$out" ;;
    *)       printf '%s' "$body"           > "$out" ;;
  esac
fi
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
  : > "$CTL/write.log"
  # `with-env` and `check-endpoint` READ an item that provisioning already created; seed it for
  # those rows. `provision` must NOT see one, or it refuses with 15 (already exists) — which is
  # itself correct behaviour and separately asserted.
  # SEED_KC_VALUE lets a row seed a value DIFFERENT from the one openssl will generate, which is the
  # only way "the pre-existing bytes survived a refusal" and "--force actually replaced them" are
  # distinguishable at all.
  [ "${SEED_KC:-0}" = "1" ] && printf '%s' "${SEED_KC_VALUE:-$FAKE_TOKEN}" > "$CTL/kcstore"
  return 0
}

# Run the helper with stubs on PATH and TMPDIR inside the scanned sandbox.
run_helper() {   # run_helper <outfile> -- args...
  local outfile="$1"; shift 2
  env PATH="$BIN:$PATH" TMPDIR="$SB" STUB_LOG="$CTL/stub.log" CTL="$CTL" FAKE_TOKEN="$FAKE_TOKEN" \
      NOTIF_LIVENESS_OPENSSL="$BIN/openssl" NOTIF_LIVENESS_SECURITY="$BIN/security" \
      NOTIF_LIVENESS_CURL="$BIN/curl" \
      STUB_RC_SECURITY_ADD="${STUB_RC_SECURITY_ADD:-0}" STUB_RC_SECURITY_FIND="${STUB_RC_SECURITY_FIND:-0}" \
      STUB_RC_FIND_PRESENCE="${STUB_RC_FIND_PRESENCE:-}" \
      STUB_RC_SUPABASE="${STUB_RC_SUPABASE:-0}" STUB_RC_CURL="${STUB_RC_CURL:-0}" \
      STUB_KC_CORRUPT="${STUB_KC_CORRUPT:-none}" STUB_CURL_CODE="${STUB_CURL_CODE:-503}" \
      STUB_CURL_BODY="${STUB_CURL_BODY:-}" \
      NOTIF_LIVENESS_JQ="${NOTIF_LIVENESS_JQ:-jq}" \
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


# ── assertions for the create/update contract ─────────────────────────────────────────────────
# `store_is` is the one that matters: every no-force refusal must leave the PRE-EXISTING bytes in
# place, and asserting the exit code alone would not notice a helper that refuses *after* writing.
store_is() {   # store_is <expected-value> <label>
  local want="$1" label="$2" got=""
  [ -f "$CTL/kcstore" ] && got="$(cat "$CTL/kcstore")"
  if [ "$got" = "$want" ]; then ok "$label"; else bad "$label (the stored value is not the expected one)"; fi
}
wrote_with() {  # wrote_with CREATE|UPDATE|REFUSED
  if grep -qx "$1" "$CTL/write.log" 2>/dev/null; then ok "...the write used $1 semantics"; else
    bad "...the write used $1 semantics (log: $(tr '\n' ',' < "$CTL/write.log" 2>/dev/null))"; fi
}
no_write()    { if [ ! -s "$CTL/write.log" ]; then ok "...no write was even attempted"; else bad "...no write was even attempted"; fi; }
no_openssl()  { if grep -q 'ARGV openssl' "$CTL/stub.log"; then bad "...and no token was generated"; else ok "...and no token was generated"; fi; }
no_curl()     { if grep -q 'ARGV curl' "$CTL/stub.log"; then bad "...and no request was made"; else ok "...and no request was made"; fi; }
no_kc_access(){ if grep -q 'ARGV security' "$CTL/stub.log"; then bad "...and the keychain was never touched"; else ok "...and the keychain was never touched"; fi; }

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

# ── with-env must refuse a command that would never receive the credential ─────────────────────
# Without this the helper proves and stages the secret, runs a command that never sees it, and
# returns that command's 0 — the operator is told the secret was delivered when nothing took it.
SEED_KC=1 expect_rc "with-env REFUSES a command with NO {} placeholder" 22 -- with-env --service svc --account acct -- supabase secrets set --project-ref demo
no_deploy; no_residue
SEED_KC=1 expect_rc "with-env REFUSES more than one {} placeholder" 22 -- with-env --service svc --account acct -- supabase secrets set --env-file '{}' --other '{}'
no_deploy; no_residue
grep -q 'ARGV security' "$CTL/stub.log" && bad "...and refuses BEFORE reading the keychain" || ok "...and refuses BEFORE reading the keychain"

# ── endpoint verification cannot end in 0 on failure ───────────────────────────────────────────
STUB_RC_CURL=7 SEED_KC=1 expect_rc "a curl TRANSPORT failure is not 0" 30 -- check-endpoint --url http://x --expect-status 503 --expect-state cron_disarmed --service svc --account acct
STUB_CURL_CODE=200 SEED_KC=1 expect_rc "the WRONG http status fails" 31 -- check-endpoint --url http://x --expect-status 503 --expect-state cron_disarmed --service svc --account acct
STUB_CURL_BODY='{"state":"stale"}' SEED_KC=1 expect_rc "the RIGHT status with the WRONG state fails" 32 -- check-endpoint --url http://x --expect-status 503 --expect-state cron_disarmed --service svc --account acct
STUB_CURL_CODE=401 STUB_CURL_BODY='{"ok":false,"state":"unauthorized"}' SEED_KC=1 expect_rc "a 401 never reads as success" 31 -- check-endpoint --url http://x --expect-status 503 --expect-state cron_disarmed --service svc --account acct
no_residue

# ── the state check is STRUCTURAL, not textual ────────────────────────────────────────────────
# The `grep '"state":"X"'` these replace matched the target text ANYWHERE in the body. Rows (b) and
# (c) are the fail-OPEN cases it let through — a real error envelope reading as success — and (k) is
# the one that survives a naive jq port, because jq reads a STREAM and a filter over `input` accepts
# a second concatenated value and ignores it. 34 = not a single JSON object; 32 = wrong .state.
ck() {   # ck <label> <want-rc> <body>
  STUB_CURL_BODY="$3" SEED_KC=1 expect_rc "$1" "$2" -- check-endpoint --url http://x \
    --expect-status 503 --expect-state cron_disarmed --service svc --account acct
}
ck "(a) the exact expected object passes"                        0  '{"state":"cron_disarmed"}'
ck "(j) extra sibling fields are fine"                           0  '{"ok":false,"state":"cron_disarmed","job_active":false}'
ck "(w) a SPACE after the colon passes (grep failed this)"       0  '{"state": "cron_disarmed"}'
ck "(b) a NESTED object echoing the state FAILS"                 32 '{"ok":false,"state":"query_failed","echo":{"state":"cron_disarmed"}}'
# The literal review case. Kept for the record, but it is NOT discriminating and never was: JSON
# escapes an embedded quote as \", so the bytes `"state":"cron_disarmed"` never appear and the old
# grep rejected it too. (b) and (c) above are the vectors that actually got through.
ck "(b') the review's escaped-detail case (passes either way)"    32 '{"state":"query_failed","detail":"expected \"state\":\"cron_disarmed\""}'
ck "(c) an ARRAY containing the state FAILS"                     34 '[{"state":"query_failed"},{"state":"cron_disarmed"}]'
ck "(d) malformed JSON FAILS"                                    34 '{"state":"cron_disarmed"'
ck "(k) a CONCATENATED second value FAILS (--slurp earns its keep)" 34 '{"state":"cron_disarmed"}{"state":"whatever"}'
ck "(h) a bare JSON string FAILS"                                34 '"cron_disarmed"'
# A NUL is a SECOND trailing-value hole that --slurp cannot close, because jq stops at the NUL and
# never sees the tail — so `length == 1` is satisfied by the prefix alone. Measured fail-open before
# the explicit NUL check was added; the independent reviewer asserted this case could not reach
# success, and it could.
ck "(n) a NUL byte hiding a trailing value FAILS"                34 '{"state":"cron_disarmed"}@NUL@{"state":"query_failed"}'
ck "(i) an EMPTY body FAILS"                                     34 '@EMPTY@'
ck "(e) a MISSING state FAILS"                                   32 '{"ok":false}'
ck "(f) a NULL state FAILS"                                      32 '{"state":null}'
ck "(g) a NUMERIC state FAILS"                                   32 '{"state":123}'
ck "(l) a PREFIX of the state FAILS"                             32 '{"state":"cron_disarmedX"}'
# --arg, not interpolation. Splicing the expected value into the filter as "\($want)" would leave a
# quote-bearing state unable to even COMPILE, so a body that genuinely matches would be reported as
# a mismatch — the failure mode that makes an operator distrust a correct alert.
STUB_CURL_BODY='{"state":"a\"b"}' SEED_KC=1 expect_rc "an expected state containing a QUOTE is compared as data" 0 -- check-endpoint --url http://x --expect-status 503 --expect-state 'a"b' --service svc --account acct
no_residue

# The parser is preflighted, so a missing jq is reported AS a missing jq (33) and neither the
# keychain nor the network is touched. Without the preflight this returns 32 — "wrong state" — and
# the 2>/dev/null that keeps the body off the terminal also hides bash's "command not found".
NOTIF_LIVENESS_JQ="$ROOT/definitely-not-jq" SEED_KC=1 expect_rc "a MISSING parser fails closed as 33, not as a wrong state" 33 -- check-endpoint --url http://x --expect-status 503 --expect-state cron_disarmed --service svc --account acct
no_curl; no_kc_access; no_residue

# ── provision: create vs update must be ATOMIC and TRUTHFUL ───────────────────────────────────
# Measured before the fix: a stubbed lookup rc=36 made the helper generate a token, write it with an
# unconditional -U, destroy a pre-existing value with no --force, and exit 0 announcing "proven
# byte-for-byte" — true of the new value, silent about the one it replaced.
SEED_KC=1 SEED_KC_VALUE="$PRIOR_TOKEN" expect_rc "an EXISTING item without --force is refused" 15 -- provision --service svc --account acct
store_is "$PRIOR_TOKEN" "...and the pre-existing bytes are untouched"
no_write; no_openssl

STUB_RC_FIND_PRESENCE=36 SEED_KC=1 SEED_KC_VALUE="$PRIOR_TOKEN" expect_rc "a lookup failure that is NOT 'not found' (36 denied) refuses" 16 -- provision --service svc --account acct
store_is "$PRIOR_TOKEN" "...and the pre-existing bytes are untouched"
no_write; no_openssl

STUB_RC_FIND_PRESENCE=51 SEED_KC=1 SEED_KC_VALUE="$PRIOR_TOKEN" expect_rc "a lookup failure of 51 (auth failed) refuses too" 16 -- provision --service svc --account acct
store_is "$PRIOR_TOKEN" "...and the pre-existing bytes are untouched"
no_write; no_openssl

# THE RACE. The lookup says 44/absent, but an item exists by the time the write lands. The create
# carries no -U, so the KEYCHAIN refuses it (45) and the existing value survives. This is the row a
# check-then-write can never pass, and it is why the lookup is for the message, not for the safety.
STUB_RC_FIND_PRESENCE=44 SEED_KC=1 SEED_KC_VALUE="$PRIOR_TOKEN" expect_rc "an item appearing BETWEEN the check and the write is refused, not overwritten" 15 -- provision --service svc --account acct
store_is "$PRIOR_TOKEN" "...and the pre-existing bytes survived the race"
wrote_with REFUSED

SEED_KC=1 SEED_KC_VALUE="$PRIOR_TOKEN" expect_rc "--force DOES replace, and re-proves the round trip" 0 -- provision --force --service svc --account acct
store_is "$FAKE_TOKEN" "...and the stored value is now the newly generated one"
wrote_with UPDATE; no_token_leak; no_residue

# A fresh provision must still use CREATE semantics — the -U must not creep back in as a constant.
expect_rc "a FIRST provision creates" 0 -- provision --service svc --account acct
wrote_with CREATE; store_is "$FAKE_TOKEN" "...and the generated value is what landed"

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
