#!/usr/bin/env bash
# 10c-b H — the clone-source inventory reader must not be forgeable.
#
# `assert_inventory_is_reviewed` is the LIVE authority the cron register defers to: it compares the
# jobs actually present against clone-safety/reviewed-cron-jobs.tsv and refuses on anything
# unreviewed or drifted. Its records are SPACE-DELIMITED and it reads fixed fields, and pg_cron
# allows whitespace in a job name — so a job called
#
#   notification-email-worker filler yes
#
# produced a record that parsed as the REVIEWED job `notification-email-worker` classified `yes`,
# with the real active and outbound values never read at all. Fail-open, in the one place the
# static scan trusts to be authoritative.
#
# The SQL no longer emits such a name as a CRONJOB record (it reports CRONJOB_UNSAFE_NAME with an
# md5 instead), and the reader refuses on that key and on any malformed record. This drives the
# REAL function with crafted inventory files, because the property is about the parser.
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# The function lives inside run-rollout.sh, which refuses to run without EXPECTED_REF and exits on
# load. Extract just what this needs: the library, the reviewed-list helpers, and the function.
EXPECTED_REF=abcdefghijklmnopqrst
export EXPECTED_REF
# shellcheck source=../lib/common.sh
source "$HERE/../lib/common.sh"
HERE_RR="$HERE/.."
REVIEWED_JOBS="$HERE_RR/clone-safety/reviewed-cron-jobs.tsv"
REVIEWED_FNS="$HERE_RR/clone-safety/reviewed-outbound-functions.tsv"
REVIEWED_EXTS="$HERE_RR/clone-safety/reviewed-extensions.tsv"
eval "$(awk '/^in_reviewed\(\)/,/^}/' "$HERE_RR/run-rollout.sh")"
eval "$(awk '/^reviewed_field\(\)/,/^}/' "$HERE_RR/run-rollout.sh")"
eval "$(awk '/^assert_inventory_is_reviewed\(\)/,/^}$/' "$HERE_RR/run-rollout.sh")"

# DEFINED AFTER the source, and NOT called ok/bad: common.sh defines its own ok(), which silently
# replaced this suite's counter and left it reporting "0 passed, 0 failed" while every check ran.
PASS=0; FAIL=0
t_ok()  { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
t_bad() { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }

# a minimally complete inventory: the reader requires these counters to be present and zero
tail_records() { printf 'HOOKTRIG 0\nOUTTRIG 0\nFDWSRV 0\n'; }

check() {   # check <name> <expect_rc> <inventory body>
  local name="$1" expect="$2" body="$3" rc=0
  # `$( )` strips trailing newlines, so re-add one: without it the last CRONJOB record ran into
  # the first counter line and the suite's own baseline failed as "malformed".
  { [[ -n "$body" ]] && printf '%s\n' "$body"; tail_records; } > "$TMP/inv"
  set +e; ( assert_inventory_is_reviewed "$TMP/inv" ) >"$TMP/out" 2>&1; rc=$?; set -e
  if [[ "$rc" == "$expect" ]]; then t_ok "$name (rc=$rc)"; else t_bad "$name (rc=$rc, expected $expect)"; cat "$TMP/out"; fi
}

echo "clone-source inventory parsing:"

# A well-formed inventory of reviewed jobs passes — otherwise every refusal below proves nothing.
check "a well-formed inventory of reviewed jobs passes" 0 \
  "$(printf 'CRONJOB notification-email-worker true yes\nCRONJOB release-expired-rebook-holds true no\n')"

# THE FORGERY. Field 2 reads as a reviewed job and field 4 as its classification, while the job's
# real active/outbound values sit further along the line and are never looked at.
check "a job NAME containing whitespace cannot forge a reviewed record" 1 \
  "$(printf 'CRONJOB notification-email-worker filler yes false no\n')"

# ...which is why the SQL reports such a name under its own key instead.
check "CRONJOB_UNSAFE_NAME is fatal" 1 \
  "$(printf 'CRONJOB notification-email-worker true yes\nCRONJOB_UNSAFE_NAME 5d41402abc4b2a76b9719d911017c592\n')"

# A short record must not be read as something else either.
check "a malformed (short) CRONJOB record is fatal" 1 \
  "$(printf 'CRONJOB notification-email-worker true\n')"

# The pre-existing rules must still hold.
check "an UNREVIEWED job is still refused" 1 \
  "$(printf 'CRONJOB notification-email-worker true yes\nCRONJOB some-new-job true yes\n')"
check "CLASSIFICATION DRIFT is still refused" 1 \
  "$(printf 'CRONJOB release-expired-rebook-holds true yes\n')"
check "an inventory with no CRONJOB records at all is refused" 1 "$(printf '')"

printf '\n================  %d passed, %d failed  ================\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]]
