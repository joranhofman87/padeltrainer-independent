#!/usr/bin/env bash
# ===========================================================================
# run-rollout.sh — operator-driven rollout of #616 (maintenance gate) THEN
# #615 (email-delivery migrations). Dispatcher of explicit, individually-gated
# subcommands; NO single auto-run. Every prod-mutating step re-asserts identity
# and requires --yes. The digest worker/event stay DISABLED throughout.
#
# Safety properties (mutation-tested by verify/guard-mutation-test.sh):
#   * deploy/secret/push run from a DETACHED WORKTREE at the reviewed PINNED SHA
#     (PINS.env); merges use `gh pr merge --match-head-commit` so no drift ships.
#   * every deploy/secret command carries explicit `--project-ref EXPECTED_REF`;
#     db push targets EXPECTED_REF via SUPABASE_PROJECT_ID (never the ambient link).
#   * apply615 cannot reach `db push` without an AUTHORITATIVE drain proof:
#     a 503 canary + positive `event:blocked` ingestion evidence + zero sends
#     past the gate + no in-flight straggler over a window covering the 400s
#     hosted-function wall-clock, with fail-closed log validation.
#   * recovery accepts ONLY none / {V1} / {V1,V2} / all; anything else stops.
#
# Subcommands: check-identity [url] | phase616 --yes | dryrun615 |
#   preflight <url> | apply615 --yes | resume615 --yes | postflight <url> |
#   ledger-status <url> | rollback615 <url> | clean-evidence --yes <url> |
#   clone-push --yes <clone_url> | clone-make-prefix --yes <1|2> <clone_url> |
#   verify-clone <clone_url> --clone
#
# Env: EXPECTED_REF. Clone commands also need CLONE_REF (!= EXPECTED_REF).
#   Prod steps also need SUPABASE_ACCESS_TOKEN (PAT),
#   SUPABASE_DB_PASSWORD, MANAGER_TOKEN. DB password via PGPASSWORD/PGPASSFILE
#   (never in argv or a connection URL). MIN_DRAIN_SECONDS defaults to the floor.
# ===========================================================================
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_DIR="$HERE/sql"; EVID="${ROLLOUT_EVIDENCE_DIR:-$HERE/evidence}"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"
# shellcheck source=PINS.env
source "$HERE/PINS.env"     # PR615_SHA, PR616_SHA (reviewed + CI-tested pins)

require_env EXPECTED_REF "set EXPECTED_REF to the target project ref (20 chars)"
assert_ref_format "$EXPECTED_REF"
[[ "${PR615_SHA:-}" =~ ^[0-9a-f]{40}$ && "${PR616_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || die "PINS.env missing valid PR615_SHA/PR616_SHA"
MIN_DRAIN_SECONDS="${MIN_DRAIN_SECONDS:-$ROLLOUT_DRAIN_FLOOR}"

V1=20261006100000; V2=20261006110000; V3=20261006120000
EXPECTED_VERSIONS="$(printf '%s\n%s\n%s\n' "$V1" "$V2" "$V3")"

WT=""
# EXIT trap: PRESERVE the original exit status. Capture $? first, keep worktree
# removal best-effort (its failure must never change the result), then exit with
# the captured status explicitly. The previous `return 0` masked failures; a
# bare non-zero last command masks successes. Both directions are pinned by
# verify/exit-status-test.sh.
cleanup() {
  local rc=$?
  if [[ -n "$WT" && -d "$WT" ]]; then
    git worktree remove --force "$WT" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT
require_yes() { [[ "${1:-}" == "--yes" ]] || die "refusing prod-mutating step without --yes"; }
run_artifact() { run_sql "$1" "$SQL_DIR/$2"; }

pr_head_sha() { local pr="$1" s; require_cmd gh
  s="$(gh pr view "$pr" --json headRefOid -q .headRefOid)"; [[ "$s" =~ ^[0-9a-f]{40}$ ]] || die "no head SHA for #$pr"; printf '%s' "$s"; }
pr_merge_sha() { local pr="$1" s st; require_cmd gh
  st="$(gh pr view "$pr" --json state -q .state)"; [[ "$st" == "MERGED" ]] || die "PR #$pr not MERGED (state=$st)"
  s="$(gh pr view "$pr" --json mergeCommit -q .mergeCommit.oid)"; [[ "$s" =~ ^[0-9a-f]{40}$ ]] || die "no merge SHA for #$pr"; printf '%s' "$s"; }

# detached worktree at $1, identity-validated inside it
mk_worktree() {
  local sha="$1"; git cat-file -e "${sha}^{commit}" 2>/dev/null || die "commit $sha not present locally (git fetch first)"
  WT="$(mktemp -d -t rollout-wt-XXXX)"; git worktree add --detach "$WT" "$sha" >&2
  ( cd "$WT" && assert_config_project_ref_is "$EXPECTED_REF" )
  ok "rollout worktree @ ${sha:0:12} identity-validated"
}
# --- dry-run pending set, with the CLI's failure reason PRESERVED --------------
# The old shape was `supabase ... 2>&1 1>/dev/null | sed …`: the CLI prints its
# pending bullets on stderr, so stderr was piped into a 14-digit-number parser —
# which also swallowed every FATAL diagnostic. A real failure became an aborted
# pipeline with no message at all (observed: dryrun615 exited 1 after the identity
# gates with nothing printed). The same helper backs apply615 and resume615, where
# a silent failure would land mid-maintenance-window with the gate already ON.
#
# Contract:
#   * combined stdout+stderr is captured to a per-call 0600 temp file;
#   * the CLI's exit code is captured EXPLICITLY, never inferred from a pipeline;
#   * exit 0  -> parse, emit ONLY the normalised 14-digit versions on stdout;
#   * exit !0 -> the parser is NEVER invoked, a bounded redacted diagnostic goes to
#                stderr, nothing goes to stdout, and the CLI's own code is returned
#                so the caller fails closed (an empty stdout can never read as a
#                successful "nothing pending");
#   * the capture file is securely deleted on both paths; a cleanup failure is
#     itself a failure, but never replaces or masks the original CLI code/message.
# (mutation-pinned: verify/dryrun-diagnostics-test.sh)

# Bounded, secret-free rendition of a captured CLI diagnostic.
# Redaction is done by jq with the secrets read from the ENVIRONMENT (`env.X`) and
# matched as LITERALS via 1-arg `split`, so no secret is ever placed in argv and no
# regex metacharacter in a password can corrupt the pattern.
ROLLOUT_DIAG_MAX_LINES=20
ROLLOUT_DIAG_MAX_COLS=200
# NON-THROWING: returns non-zero instead of exiting, so a broken sanitiser can
# never skip the caller's secure_delete nor replace the CLI's own exit code. It
# also never falls back to raw output — if sanitisation fails there is simply
# nothing to show.
# The jq program alone. Split out so the caller can wrap the FULL pipeline —
# sanitiser AND bounding stage — in one pipefail subshell.
redact_jq() {   # $1 = captured file
  jq -R -r --argjson cols "$ROLLOUT_DIAG_MAX_COLS" '
      def lit_redact($v): if ($v | length) > 0 then (split($v) | join("***REDACTED***")) else . end;
      lit_redact(env.SUPABASE_DB_PASSWORD // "")
      | lit_redact(env.SUPABASE_ACCESS_TOKEN // "")
      | lit_redact(env.MANAGER_TOKEN // "")
      | lit_redact(env.PGPASSWORD // "")
      | gsub("(?<a>authorization[ \t]*:[ \t]*bearer[ \t]+)[^ \t]+"; "\(.a)***REDACTED***"; "i")
      | gsub("(?<p>postgres(?:ql)?://[^:@/ \t]+:)[^@ \t]+@"; "\(.p)***REDACTED***@"; "i")
      | .[0:$cols]
    ' "$1" 2>/dev/null
}
redact_diag() {   # $1 = captured file -> prints a safe rendition on stdout; !0 on failure
  command -v jq >/dev/null 2>&1 || return 1
  local rendered rc=0
  # `set -o pipefail` INSIDE the subshell so BOTH stages are checked regardless of
  # the caller's shell options: inspecting only PIPESTATUS[0] would let a failed
  # bounding stage publish an unbounded — or truncated-mid-secret — rendition.
  rendered="$( set -o pipefail; redact_jq "$1" | head -n "$ROLLOUT_DIAG_MAX_LINES" )" || rc=$?
  [[ "$rc" -eq 0 ]] || return "$rc"
  [[ -n "$rendered" ]] || return 1
  printf '%s\n' "$rendered"
}

# $1 = a NON-SECRET target label used in diagnostics; $2.. = the CLI's target argv.
# The label and the argv are kept strictly apart: the argv for a clone carries
# `--db-url postgresql://user:PASSWORD@host/db`, so interpolating "$*"/"$@" into a
# message printed the clone's password verbatim (reproduced with a stubbed CLI
# returning a non-zero code and no output). Diagnostics may name the operation,
# the target CLASS and the exit code — never the connection string.
dry_run_pending() {   # $1 label, $2.. selector (--linked | --db-url URL)
  local label="$1"; shift
  require_cmd supabase
  # every diagnostic prerequisite must exist BEFORE the CLI writes anything
  # sensitive: a missing sanitiser afterwards would strand the capture and lose
  # the CLI's reason and code.
  require_cmd jq
  # the PARSER's dependencies are preflighted too: discovering a missing sed or
  # sort after the CLI has run would strand a sensitive capture.
  require_cmd sed; require_cmd sort
  local cap rc=0 crc=0 prev_umask
  prev_umask="$(umask)"; umask 077
  cap="$(mktemp -t rollout-dryrun-XXXXXX)" || { umask "$prev_umask"; die "cannot create a temp file for the CLI output"; }
  umask "$prev_umask"
  # the 0600 contract is enforced, not attempted: if it cannot be established the
  # empty capture is removed and the CLI is never run.
  chmod 600 "$cap" || { rm -f "$cap"; die "cannot restrict the CLI capture to 0600 — refusing to run the dry run"; }
  NO_COLOR=1 supabase db push "$@" --dry-run >"$cap" 2>&1 || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    warn "supabase db push --dry-run FAILED (exit ${rc}) — the pending set was NOT parsed"
    local safe=""
    if [[ -s "$cap" ]]; then safe="$(redact_diag "$cap")" || safe=""; fi
    if [[ -n "$safe" ]]; then
      warn "CLI output (secrets redacted, first ${ROLLOUT_DIAG_MAX_LINES} lines):"
      printf '%s\n' "$safe" >&2
    elif [[ -s "$cap" ]]; then
      warn "the CLI produced output but it could NOT be sanitised — WITHHOLDING it; raw output is never printed"
    else
      warn "the CLI produced NO output; operation: db push --dry-run against the ${label} (exit ${rc})"
    fi
    secure_delete "$cap" || warn "could not securely delete the CLI capture — remove it by hand"
    return "$rc"                       # the ORIGINAL CLI code, never a cleanup code
  fi
  # The parser's status must be CAPTURED, not discarded. It used to run bare —
  # `sed … | sort -u` straight to stdout — after which secure_delete and `return 0`
  # overwrote `$?`. The helper is invoked through command substitution on the left
  # of `||`, so errexit cannot protect it: a failing sort produced exit 0 with
  # EMPTY stdout, i.e. a parser crash reading as "nothing pending".
  # (reproduced with a stubbed sort returning 42)
  local parsed prc=0
  parsed="$( set -o pipefail
             sed -n 's/.*[[:space:]]\([0-9]\{14\}\)_[A-Za-z0-9_]*\.sql.*/\1/p' "$cap" | sort -u )" || prc=$?
  if [[ "$prc" -ne 0 ]]; then
    warn "the dry run succeeded but the pending-migration PARSER failed (exit ${prc}) — no pending set was produced; the raw capture is never printed"
    secure_delete "$cap" || warn "could not securely delete the CLI capture — remove it by hand"
    return "$prc"                    # the PARSER's code, never a cleanup code
  fi
  secure_delete "$cap" || crc=1
  [[ "$crc" -eq 0 ]] || { warn "the dry run succeeded but its capture could not be securely deleted"; return 1; }
  printf '%s\n' "$parsed"           # published ONLY after the parser succeeded
  return 0
}
push_dry_run_pending()  { dry_run_pending "linked project"          --linked; }
clone_dry_run_pending() { dry_run_pending "explicit clone target"  --db-url "$1"; }


# ---------------------------------------------------------------------------
# WORKTREE POOLER LINK  (linked-database paths only)
# ---------------------------------------------------------------------------
# `supabase/.temp/` is GITIGNORED, so `git worktree add` never carries it into the
# detached rollout worktree. The CLI there finds no pooler metadata and falls back
# to the DIRECT host db.<ref>.supabase.co, which resolves IPv6-only — observed as
# "IPv6 is not supported on your current network" during step 7, even though the
# ordinary checkout was correctly linked with a pooler URL.
#
# Linking the ORDINARY CHECKOUT does not fix this: dryrun615 / apply615 /
# resume615 each build a fresh detached worktree, and none of them inherit that
# metadata. Each rollout worktree must establish and VERIFY its own link.
#
# We deliberately never copy the ambient `.temp`: it is mutable, unversioned and
# could point at any project — exactly the sort of thing the identity guards
# exist to refuse.
#
# The password is taken ONLY from the environment: never `--password`, never in
# argv. `--skip-pooler` is never used — the pooler is the entire point.
# (mutation-pinned: verify/worktree-link-test.sh)
link_worktree_pooler() {
  require_cmd supabase; require_cmd git
  require_env SUPABASE_DB_PASSWORD "set SUPABASE_DB_PASSWORD (the CLI reads it from the environment)"
  [[ -n "${WT:-}" && -d "$WT" ]] || die "link_worktree_pooler called without a rollout worktree"
  local cap rc=0 prev_umask
  prev_umask="$(umask)"; umask 077
  cap="$(mktemp -t rollout-link-XXXXXX)" || { umask "$prev_umask"; die "cannot create a temp file for the link output"; }
  umask "$prev_umask"
  chmod 600 "$cap" || { rm -f "$cap"; die "cannot restrict the link capture to 0600 — refusing to link"; }
  log "linking the rollout worktree to project ${EXPECTED_REF} (pooler metadata)"
  ( cd "$WT" && NO_COLOR=1 supabase link --project-ref "$EXPECTED_REF" ) >"$cap" 2>&1 || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    warn "supabase link FAILED in the rollout worktree (exit ${rc}) — refusing to reach any db push"
    local safe=""
    if [[ -s "$cap" ]]; then safe="$(redact_diag "$cap")" || safe=""; fi
    if [[ -n "$safe" ]]; then
      warn "CLI output (secrets redacted, first ${ROLLOUT_DIAG_MAX_LINES} lines):"
      printf '%s\n' "$safe" >&2
    elif [[ -s "$cap" ]]; then
      warn "the CLI produced output but it could NOT be sanitised — WITHHOLDING it; raw output is never printed"
    else
      warn "the CLI produced NO output; operation: supabase link against the rollout worktree (exit ${rc})"
    fi
    secure_delete "$cap" \
      || warn "additionally, the link capture could not be securely deleted — remove it by hand"
    return "$rc"                      # the CLI's own code, never a cleanup code
  fi
  # A SUCCESSFUL link whose capture cannot be destroyed must not continue: the
  # capture may hold connection detail, and "we could not clean up" is not a
  # state in which to proceed to validation, a dry run or a push.
  if ! secure_delete "$cap"; then
    warn "the link SUCCEEDED but its capture could not be securely deleted — refusing to continue to validation or any push; remove it by hand"
    return 1
  fi
  assert_worktree_pooler_link
}

# Fail closed unless the worktree's OWN freshly written metadata is exactly right.
# A wrong or absent pooler URL silently reverts the CLI to the direct IPv6 host,
# which is the failure this whole stage exists to prevent.
assert_worktree_pooler_link() {
  local t="$WT/supabase/.temp" ref pu host user port scheme
  # Metadata reached through a SYMLINKED PARENT is not worktree-owned: `.temp`
  # (or `supabase/`) could point at the ambient checkout or anywhere else, and
  # the children would still look like perfectly ordinary regular files. That
  # defeats the whole "this worktree established its own fresh link" contract.
  [[ ! -L "$WT/supabase" ]] || die "worktree link: supabase/ is a SYMLINK — refusing metadata reached through a symlinked parent"
  [[ ! -L "$t" ]] || die "worktree link: .temp is a SYMLINK — refusing metadata reached through a symlinked parent"
  [[ -d "$t" ]] || die "worktree link: .temp is not a directory — the link did not write worktree-owned metadata"
  [[ ! -L "$t/project-ref" && -f "$t/project-ref" ]] \
    || die "worktree link: .temp/project-ref is missing or not a regular file"
  ref="$(cat "$t/project-ref")"
  [[ "$ref" == "$EXPECTED_REF" ]] \
    || die "worktree link: .temp/project-ref '${ref}' != EXPECTED_REF '${EXPECTED_REF}'"
  [[ ! -L "$t/pooler-url" ]] || die "worktree link: .temp/pooler-url is a SYMLINK — refusing"
  [[ -f "$t/pooler-url" ]] \
    || die "worktree link: .temp/pooler-url is missing or not a regular file — the CLI would fall back to the DIRECT IPv6 host"
  pu="$(cat "$t/pooler-url")"
  # This single pattern also rejects any password: a credential-bearing URL has
  # `user:secret@`, which cannot match a userinfo field that forbids ':'.
  [[ "$pu" =~ ^(postgres|postgresql)://([^:@/]+)@([^:@/]+):([0-9]+)(/.*)?$ ]] \
    || die "worktree link: pooler-url is not a password-free postgres URL of the expected shape"
  scheme="${BASH_REMATCH[1]}"; user="${BASH_REMATCH[2]}"; host="${BASH_REMATCH[3]}"; port="${BASH_REMATCH[4]}"
  [[ "$user" == "postgres.${EXPECTED_REF}" ]] \
    || die "worktree link: pooler user is not 'postgres.${EXPECTED_REF}'"
  [[ "$host" == *.pooler.supabase.com ]] \
    || die "worktree link: pooler host does not end in .pooler.supabase.com"
  [[ "$host" != "db.${EXPECTED_REF}.supabase.co" ]] \
    || die "worktree link: pooler-url points at the DIRECT host (IPv6-only) — refusing"
  [[ "$port" == 5432 || "$port" == 6543 ]] \
    || die "worktree link: pooler port '${port}' is neither 5432 nor 6543"
  # errexit is disabled through this function (it is called on the left of `||`),
  # so a FAILED `git status` would leave dirty="" and read as a clean tree.
  # Capture the status explicitly and only interpret emptiness after exit 0.
  local dirty grc=0
  dirty="$(git -C "$WT" status --porcelain --untracked-files=no)" || grc=$?
  [[ "$grc" -eq 0 ]] \
    || die "worktree link: could not determine tracked-file status (git exit ${grc}) — refusing to proceed to any push"
  [[ -z "$dirty" ]] \
    || die "worktree link: supabase link modified TRACKED files in the rollout worktree — refusing"
  ok "worktree linked: ${scheme}://postgres.${EXPECTED_REF}@${host}:${port} (pooler, password-free, tracked tree clean)"
}

# --- authoritative, blocking drain proof -----------------------------------
prove_drain() {
  local t_gate="$1" min="$MIN_DRAIN_SECONDS"
  require_env SUPABASE_ACCESS_TOKEN "PAT required"
  require_env MANAGER_TOKEN "manager JWT required"
  assert_drain_window "$min"
  local fn="https://${EXPECTED_REF}.functions.supabase.co/send-invoice-email" resp code body canary_id
  # 1) safe authenticated NON-probe canary MUST 503; capture the EXACT invocationId
  #    the maintenance response echoes, so we can correlate its precise blocked event.
  resp="$(curl -sS -X POST "$fn" -H "Authorization: Bearer ${MANAGER_TOKEN}" -H 'Content-Type: application/json' \
    -w $'\n%{http_code}' --data '{"invoiceId":"drain-canary","previewOnly":true}')" || die "canary request failed"
  code="$(printf '%s' "$resp" | tail -n1)"; body="$(printf '%s' "$resp" | sed '$d')"
  [[ "$code" == 503 ]] || die "canary did not return 503 (gate not active? http=$code)"
  canary_id="$(printf '%s' "$body" | jq -r '.invocationId // empty')"
  [[ "$canary_id" =~ ^[0-9a-fA-F-]{36}$ ]] || die "canary 503 lacked a valid invocationId (deploy #616 build that echoes it)"
  ok "canary 503 with invocationId ${canary_id:0:8}… — gate active"
  # 2) wait out the drain window (covers the 400s hosted-function wall). There is
  #    NO way to shorten this: the loop advances only via the real clock (date)
  #    and only breaks once (now - T_GATE) >= min, where min is floored at 520s by
  #    assert_drain_window. Tests exercise it by stubbing date/sleep, not by any
  #    env flag. (mutation-pinned: verify/guard-mutation-test.sh)
  local g_epoch now_epoch elapsed
  g_epoch="$(iso_to_epoch "$t_gate")"
  log "draining >= ${min}s before any migration"
  while :; do now_epoch="$(date -u +%s)"; elapsed=$((now_epoch - g_epoch)); [[ "$elapsed" -ge "$min" ]] && break; sleep 15; done
  # 3) ONE widened, minute-rounding-padded snapshot enforcing EVERYTHING locally:
  #    exact canary blocked present + zero POST-gate sends (local --gate-at-epoch) +
  #    no straggler + no record_failed. Empty results fail (require-invocation).
  #    Retry ONLY ingestion lag of the canary (rc 4).
  local w_start w_end rc attempt
  w_start="$(epoch_to_iso $(( g_epoch - min - 60 )))"
  for attempt in 1 2 3 4 5 6; do
    w_end="$(epoch_to_iso $(( $(date -u +%s) + 60 )))"; rc=0
    "$HERE/logfetch/fetch-edge-logs.sh" --ref "$EXPECTED_REF" --start "$w_start" --end "$w_end" \
      --gate-at-epoch "$g_epoch" --require-invocation "$canary_id" \
      --assert-all-finished --fail-on-record-failed || rc=$?
    case "$rc" in
      0) break;;
      4) log "canary evidence not ingested yet — retry $attempt/6"; sleep 15;;
      3) die "DRAIN PROOF FAILED: gate BYPASS (post-gate provider_send_started) in [$w_start,$w_end]";;
      5) die "DRAIN PROOF FAILED: in-flight straggler in [$w_start,$w_end]";;
      6) die "DRAIN PROOF FAILED: record_failed in [$w_start,$w_end]";;
      *) die "drain fetch failed (rc=$rc)";;
    esac
  done
  [[ "$rc" == 0 ]] || die "DRAIN PROOF FAILED: canary evidence ${canary_id:0:8}… absent after retries"
  assert_drain_proven "$elapsed" "$min" 0
}

# --- no-loss manifest (concurrency-safe; validate/compare live in common.sh) --
# The manifest + salt are PSEUDONYMOUS PERSONAL DATA (salted SHA-256 of emails):
# written 0600 under umask 077, salt passed via env (never argv). Delete after
# the rollout with `run-rollout.sh clean-evidence`. ROLLOUT_SALT is set by
# apply615 and persisted so resume615 can reuse the ORIGINAL manifest.
persist_salt() {  # write the per-run secret salt 0600
  ( umask 077; printf '%s' "$ROLLOUT_SALT" > "$EVID/manifest-salt.txt" )
  chmod 600 "$EVID/manifest-salt.txt" 2>/dev/null || true
}
capture_manifest() {
  local url="$1" tag="$2"; local out="$EVID/manifest-${tag}.txt"; require_cmd psql
  require_env ROLLOUT_SALT "internal: manifest salt not set"
  # salt via env (\getenv in manifest.sql) so it never appears in process args; 0600 output
  ( umask 077; ROLLOUT_SALT="$ROLLOUT_SALT" psql "$url" -v ON_ERROR_STOP=1 --no-psqlrc -q -f "$SQL_DIR/manifest.sql" | sed '/^$/d' > "$out" ) \
    || die "manifest capture ($tag) failed"
  chmod 600 "$out" 2>/dev/null || true
  validate_manifest "$out" "$tag"; ok "manifest captured + validated: $out"
}

# Resolve the commit to build a recovery worktree from. Default = the reviewed
# pin. A DIFFERING recovery requires a fully-reviewed, MERGED RECOVERY_PR whose
# head equals RECOVERY_SHA and whose checks are green; we then deploy from its
# verified MERGE commit. Arbitrary local commits are rejected.
resolve_recovery_sha() {
  if [[ -z "${RECOVERY_PR:-}" && -z "${RECOVERY_SHA:-}" ]]; then printf '%s' "$PR615_SHA"; return 0; fi
  require_cmd gh
  require_env RECOVERY_PR "a differing recovery requires RECOVERY_PR (the reviewed PR number)"
  require_env RECOVERY_SHA "a differing recovery requires RECOVERY_SHA (the reviewed head SHA)"
  [[ "$RECOVERY_SHA" =~ ^[0-9a-f]{40}$ ]] || die "RECOVERY_SHA must be a 40-hex commit"
  git fetch origin
  assert_sha_matches_pin "$(pr_head_sha "$RECOVERY_PR")" "$RECOVERY_SHA" "recovery PR #$RECOVERY_PR head"
  gh pr checks "$RECOVERY_PR" || die "recovery PR #$RECOVERY_PR checks are not all green"
  local state; state="$(gh pr view "$RECOVERY_PR" --json state -q .state)"
  [[ "$state" == "MERGED" ]] || die "recovery PR #$RECOVERY_PR is not MERGED (state=$state)"
  pr_merge_sha "$RECOVERY_PR"   # deploy from the verified merge commit
}

# --- migration ledger (fail-loud, valid prefixes only) ---------------------
ledger_status() { # $1 url ; echoes none|prefix1|prefix2|all|invalid
  local url="$1" csv; require_cmd psql
  csv="$(psql "$url" -v ON_ERROR_STOP=1 -Atqc \
    "SELECT CASE WHEN to_regclass('supabase_migrations.schema_migrations') IS NULL THEN ''
       ELSE coalesce((SELECT string_agg(version, ',' ORDER BY version)
                      FROM supabase_migrations.schema_migrations
                      WHERE version IN ('$V1','$V2','$V3')), '') END")" \
    || die "ledger query failed (connection/auth?) — cannot classify migration state"
  classify_ledger "$csv" "$V1" "$V2" "$V3"
}

# ===========================================================================
cmd_check_identity() {
  ok "EXPECTED_REF format valid: $EXPECTED_REF"
  if [[ -n "${1:-}" ]]; then assert_conn_url_is_ref "$EXPECTED_REF" "$1"; else assert_linked_ref_is "$EXPECTED_REF"; fi
}

cmd_phase616() {
  require_yes "${1:-}"; require_cmd gh; require_cmd supabase; require_cmd curl; require_cmd jq
  require_env MANAGER_TOKEN "set MANAGER_TOKEN (academy manager JWT)"
  log "Phase 1 (#616): pin-checked merge + deploy from merge-SHA worktree + verify gate OFF"
  git fetch origin
  assert_sha_matches_pin "$(pr_head_sha 616)" "$PR616_SHA" "#616 head"
  gh pr checks 616; gh pr ready 616 || true
  gh pr merge 616 --squash --match-head-commit "$PR616_SHA" --delete-branch=false
  git fetch origin
  mk_worktree "$(pr_merge_sha 616)"
  ( cd "$WT"; export SUPABASE_PROJECT_ID="$EXPECTED_REF"
    supabase functions deploy send-invoice-email --project-ref "$EXPECTED_REF" )
  local probe="https://${EXPECTED_REF}.functions.supabase.co/send-invoice-email?probe=1" body
  body="$(curl -sS "$probe" -H "Authorization: Bearer ${MANAGER_TOKEN}")"
  printf '%s' "$body" | jq -e '.maintenance == false' >/dev/null || die "gate not maintenance=false after deploy: $body"
  ok "Phase 1 complete: #616 merged (pin ${PR616_SHA:0:12}), deployed; gate OFF"
}

cmd_dryrun615() {
  require_cmd gh; require_cmd supabase; git fetch origin
  assert_sha_matches_pin "$(pr_head_sha 615)" "$PR615_SHA" "#615 head"
  mk_worktree "$PR615_SHA"
  require_env SUPABASE_DB_PASSWORD "set SUPABASE_DB_PASSWORD for the dry-run connection"
  link_worktree_pooler || die "worktree link failed — the dry run was NOT attempted"
  ( cd "$WT"; export SUPABASE_PROJECT_ID="$EXPECTED_REF"
    local pending; pending="$(push_dry_run_pending)" || die "dry run failed (see the CLI diagnostic above)"
    log "db push --dry-run pending:"; printf '%s\n' "$pending" >&2
    assert_pending_is_expected "$pending" "$EXPECTED_VERSIONS" )
  ok "dry run verified: exactly $V1,$V2,$V3 pending"
}

cmd_apply615() {
  require_yes "${1:-}"; require_cmd gh; require_cmd supabase; require_cmd curl; require_cmd jq; require_cmd psql
  require_env MANAGER_TOKEN "set MANAGER_TOKEN"
  # BOTH caps validated BEFORE the merge, the gate change and the push: a cap of 0
  # would disable the timeout Postgres-side and unbound the production window.
  assert_caps
  require_env SUPABASE_ACCESS_TOKEN "set SUPABASE_ACCESS_TOKEN"
  require_env SUPABASE_DB_PASSWORD "set SUPABASE_DB_PASSWORD"
  require_env PROD_CONN_URL "set PROD_CONN_URL (password via PGPASSWORD)"
  local CAP_LOCK="${CAP_LOCK:-3000}" prod="$PROD_CONN_URL"
  assert_conn_url_is_ref "$EXPECTED_REF" "$prod"
  local probe="https://${EXPECTED_REF}.functions.supabase.co/send-invoice-email?probe=1"

  git fetch origin
  assert_sha_matches_pin "$(pr_head_sha 615)" "$PR615_SHA" "#615 head"
  gh pr checks 615; gh pr ready 615 || true
  gh pr merge 615 --squash --match-head-commit "$PR615_SHA" --delete-branch=false
  git fetch origin
  mk_worktree "$(pr_merge_sha 615)"
  # linked ONCE here; the same worktree serves both dry runs and the real push
  link_worktree_pooler || die "worktree link failed — no dry run or push was attempted"
  ( cd "$WT"; export SUPABASE_PROJECT_ID="$EXPECTED_REF"
    local p2; p2="$(push_dry_run_pending)" || die "dry run failed before the #615 merge push"
    assert_pending_is_expected "$p2" "$EXPECTED_VERSIONS" )

  log "activating maintenance gate"
  supabase secrets set INVOICE_EMAIL_MAINTENANCE=1 --project-ref "$EXPECTED_REF"
  local body; body="$(curl -sS "$probe" -H "Authorization: Bearer ${MANAGER_TOKEN}")"
  printf '%s' "$body" | jq -e '.maintenance == true' >/dev/null || die "gate not maintenance=true; ABORT"
  local T_GATE; T_GATE="$(now_iso)"; ok "gate ON at $T_GATE"

  prove_drain "$T_GATE"       # cannot reach db push without this

  # capture the pre-migration manifest AFTER the drain (reflects the gated,
  # drained state); a fresh per-run secret salt is persisted 0600 so resume615
  # can reuse it.
  ROLLOUT_SALT="$(gen_salt)"; persist_salt
  capture_manifest "$prod" pre

  ( cd "$WT"; export SUPABASE_PROJECT_ID="$EXPECTED_REF"
    local p3; p3="$(push_dry_run_pending)" || die "dry run failed inside the maintenance window — gate stays ON"
    assert_pending_is_expected "$p3" "$EXPECTED_VERSIONS"
    log "db push (lock_timeout=${CAP_LOCK}ms statement_timeout=${CAP_STMT}ms)"
    PGOPTIONS="-c lock_timeout=${CAP_LOCK} -c statement_timeout=${CAP_STMT}" supabase db push --linked --yes ) || {
      die "db push failed. ledger=$(ledger_status "$prod"). Gate stays ON. Run 'resume615 --yes' or 'rollback615 $prod'."
    }
  local st; st="$(ledger_status "$prod")"
  case "$st" in
    all) ok "all three migrations recorded";;
    invalid) die "INVALID ledger state after push — STOP, investigate. Gate stays ON.";;
    *) die "post-push ledger='$st' (expected all). Gate stays ON; run 'resume615 --yes'.";;
  esac

  run_artifact "$prod" postflight.sql
  run_artifact "$prod" acl_matrix.sql
  run_artifact "$prod" ledger_verification.sql
  capture_manifest "$prod" post
  assert_manifest_no_loss "$EVID/manifest-pre.txt" "$EVID/manifest-post.txt"

  log "deactivating maintenance gate"
  supabase secrets unset INVOICE_EMAIL_MAINTENANCE --project-ref "$EXPECTED_REF"
  body="$(curl -sS "$probe" -H "Authorization: Bearer ${MANAGER_TOKEN}")"
  printf '%s' "$body" | jq -e '.maintenance == false' >/dev/null || die "gate not back to maintenance=false; investigate"
  ok "Phase 2 complete: #615 applied; gate OFF; digest engine still disabled"
}

# POST-migration clone battery. The clone rehearsal is TWO-PHASE and these
# artifacts are mutually exclusive by design:
#   phase 1 (BEFORE `db push` to the clone):  run-rollout.sh preflight "$CLONE"
#                                             -> asserts the #615 delta is ABSENT
#   phase 2 (AFTER  `db push` to the clone):  run-rollout.sh verify-clone "$CLONE"
#                                             -> asserts the delta is PRESENT + correct
# preflight.sql must NOT appear below: it asserts `is_suppressed is ABSENT` while
# postflight.sql asserts it EXISTS and academy_fixture.sql calls the re-emitted
# reader, so including it made this battery unpassable in EITHER clone state.
# (regression-pinned: verify/rehearsals.mjs rehearsal F)
# CLONE-ONLY and WRITE-BEARING: academy_fixture.sql INSERTs a fixture graph before
# it ROLLBACKs, so running this against production would write to production.
# It therefore requires explicit --clone AND a CLONE_REF that is format-valid,
# different from EXPECTED_REF, and matched exactly by the URL.
cmd_verify_clone() {
  local url="${1:-}"; require_arg "$url" "usage: CLONE_REF=<ref> verify-clone <clone_conn_url> --clone   # AFTER db push to the clone"
  [[ "${2:-}" == "--clone" ]] || die "verify-clone REQUIRES explicit --clone (it writes a fixture; never run it against production)"
  assert_clone_url "$url"
  assert_clone_isolated "$url"          # no rehearsal touches a clone that is not provably inert
  run_artifact "$url" academy_fixture.sql
  run_artifact "$url" postflight.sql; run_artifact "$url" acl_matrix.sql; run_artifact "$url" ledger_verification.sql
  ok "clone verification battery passed (post-migration)"; }


# ===========================================================================
# CLONE SAFETY — a restored project is NOT inert by default
# ===========================================================================
# A Supabase restore copies pg_cron jobs, the pg_net queue, database webhooks,
# Auth data and Vault-readable secrets. The clone therefore boots with REAL
# credentials and resumes cron immediately. On this project
# notification-email-worker and notification-whatsapp-worker run every 2 minutes
# and issue outbound HTTP: a naive clone would send real email/WhatsApp to real
# customers within minutes. Nothing may be cloned from a source that has not
# been proven quiescent, and no rehearsal may touch a clone that is not proven
# inert. (mutation-pinned: verify/clone-safety-test.sh)
# Reviewed floor for the scheduler-observation interval between quiet samples.
# Deliberately not overridable: see quiesce_drain.
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
QUIESCE_MIN_SETTLE_SECS=15
REVIEWED_JOBS="$HERE/clone-safety/reviewed-cron-jobs.tsv"
SRC_MANIFEST="$EVID/clone-source-manifest.txt"

# Parse the inventory artifact into safe fields. Never echoes a command, URL,
# header, body or secret — the SQL only ever emits names, counts and md5s.
read_source_inventory() {   # $1 = prod url -> writes $2 (raw safe lines)
  run_sql "$1" "$SQL_DIR/clone_source_inventory.sql" > "$2" 2>&1 \
    || die "clone-source inventory FAILED to read (connection/permissions?) — refusing to classify blind"
  local k
  for k in NETQUEUE INFLIGHT LOGRUN CFGFP FENCEABLE PRIORWINDOW; do
    grep -q "^${k} " "$2" || die "clone-source inventory produced no ${k} record — refusing to proceed on a partial read"
  done
}

# FAIL CLOSED on anything not in the reviewed set, and on any outbound mechanism
# the review did not classify.
REVIEWED_FNS="$HERE/clone-safety/reviewed-outbound-functions.tsv"
REVIEWED_EXTS="$HERE/clone-safety/reviewed-extensions.tsv"
in_reviewed() {   # $1 = file, $2 = key
  awk -F'\t' -v k="$2" '!/^#/ && $1==k {found=1} END{exit !found}' "$1"; }
reviewed_field() { # $1 = file, $2 = key, $3 = column
  awk -F'\t' -v k="$2" -v c="$3" '!/^#/ && $1==k {print $c; exit}' "$1"; }

assert_inventory_is_reviewed() {   # $1 = inventory file
  local inv="$1" name flag want unknown=0 n
  for f in "$REVIEWED_JOBS" "$REVIEWED_FNS" "$REVIEWED_EXTS"; do
    [[ -f "$f" ]] || die "missing reviewed list: $f"
  done
  # cron jobs: present in the reviewed set AND the live outbound classification
  # must still match the reviewed one (a command edit can change it).
  while read -r name flag; do
    [[ -n "$name" ]] || continue
    if ! in_reviewed "$REVIEWED_JOBS" "$name"; then
      warn "UNREVIEWED cron job present: ${name}"; unknown=$((unknown+1)); continue
    fi
    want="$(reviewed_field "$REVIEWED_JOBS" "$name" 2)"
    [[ "$flag" == "$want" ]] \
      || { warn "CLASSIFICATION DRIFT for ${name}: live outbound='${flag}' but reviewed='${want}'"; unknown=$((unknown+1)); }
  done < <(awk '$1=="CRONJOB"{print $2, $4}' "$inv")
  # outbound-capable functions (transitive closure) must all be reviewed
  while read -r name; do
    [[ -n "$name" ]] || continue
    in_reviewed "$REVIEWED_FNS" "$name" \
      || { warn "UNREVIEWED outbound-capable function: ${name}"; unknown=$((unknown+1)); }
  done < <(awk '$1=="OUTFN"{print $2}' "$inv")
  # extensions with external capability must all be reviewed
  while read -r name; do
    [[ -n "$name" ]] || continue
    in_reviewed "$REVIEWED_EXTS" "$name" \
      || { warn "UNREVIEWED extension with external capability: ${name}"; unknown=$((unknown+1)); }
  done < <(awk '$1=="EXT"{print $2}' "$inv")
  [[ "$unknown" -eq 0 ]] \
    || die "${unknown} unreviewed/drifted outbound mechanism(s) — a job may have been added at runtime (schedule_*_job) or a classification may have changed; review before quiescing"
  # OUTFN/EXT may legitimately be empty; a cron-job section may not.
  grep -q '^CRONJOB ' "$inv" || die "inventory has no CRONJOB records — refusing to proceed on an incomplete read"
  for n in HOOKTRIG OUTTRIG FDWSRV; do
    local v; v="$(awk -v k="$n" '$1==k{print $2}' "$inv")"
    [[ -n "$v" ]] || die "inventory is missing the ${n} count — refusing to proceed on an incomplete read"
    [[ "$v" -eq 0 ]] || die "${v} unclassified outbound mechanism(s) of type ${n} — a clone would fire them; classify before cloning"
  done
  ok "inventory reviewed: $(awk '$1=="CRONJOB"{n++} END{print n+0}' "$inv") cron job(s), all known; no webhooks/outbound triggers/FDWs"
}


source_config_fp() {   # $1 = inventory file -> the cron CONFIGURATION fingerprint
  local fp; fp="$(awk '$1=="CFGFP"{print $2}' "$1")"
  [[ "$fp" =~ ^[0-9a-f]{32}$ ]] || die "inventory did not report a well-formed cron configuration fingerprint"
  printf '%s' "$fp"
}

# STRICT grammar + uniqueness for the EXPORTED evidence manifest. This file is a
# human-readable record and a cross-check; it is NEVER the input to restoration
# (that is rollout_clone.snapshot_job_state, captured by the seal from cron.job
# itself), so no manifest text is ever interpolated into SQL. It is still
# validated fail-closed, including a truncated final line: `read` returns false
# on an unterminated last record and would otherwise DROP it silently.
validate_source_manifest() {   # $1 = manifest
  local f="$1" tag id name act n=0 last
  local -a ids=() names=()
  [[ -s "$f" ]] || die "manifest is empty"
  last="$(tail -c 1 "$f" | od -An -c | tr -d ' ')"
  [[ "$last" == '\n' ]] || die "manifest does not end in a newline — its final record is truncated and would be silently dropped"
  while IFS=$'\t' read -r tag id name act; do
    n=$((n+1))
    [[ "$tag" == JOB ]] || die "manifest line ${n}: unknown record tag '${tag}' (expected JOB)"
    [[ "$id" =~ ^[0-9]+$ ]] || die "manifest line ${n}: job id is not a plain integer"
    [[ "$name" =~ ^[A-Za-z0-9_.-]+$ ]] || die "manifest line ${n}: job name has characters outside [A-Za-z0-9_.-]"
    [[ "$act" == true || "$act" == false ]] || die "manifest line ${n}: active state '${act}' is neither true nor false"
    ids+=("$id"); names+=("$name")
  done < "$f"
  [[ "$n" -gt 0 ]] || die "manifest has no records"
  [[ "$(printf '%s\n' "${ids[@]}"   | sort | uniq -d | wc -l | tr -d ' ')" == 0 ]] || die "manifest has DUPLICATE job ids"
  [[ "$(printf '%s\n' "${names[@]}" | sort | uniq -d | wc -l | tr -d ' ')" == 0 ]] || die "manifest has DUPLICATE job names"
  ok "exported prior-state manifest validated: ${n} job(s), unique ids and names, well-formed states, complete final record"
}

cmd_clone_source_inventory() {   # READ-ONLY; safe to run against production
  local url="${1:-}"; require_arg "$url" "usage: clone-source-inventory <prod_conn_url>"
  require_cmd psql; assert_conn_url_is_ref "$EXPECTED_REF" "$url"
  mkdir -p "$EVID"
  local inv="$EVID/clone-source-inventory.txt"
  read_source_inventory "$url" "$inv"
  assert_inventory_is_reviewed "$inv"
  # NOT assert_source_is_sealable: fenceability was a requirement of the
  # WITHDRAWN design (ADR-001). Synthetic rehearsals never fence production, so
  # gating this read-only audit on FENCEABLE would block it permanently for a
  # property nothing needs any more. It is still REPORTED below.
  awk '$1=="CRONJOB"{printf "  %-38s active=%-5s outbound=%s\n",$2,$3,$4}
       $1=="INFLIGHT"{printf "  cron runs in flight    : %s\n",$2}
       $1=="LOGRUN"{printf "  cron.log_run           : %s\n",$2}
       $1=="NETQUEUE"{printf "  pg_net queued requests : %s\n",$2}
       $1=="VAULTCOUNT"{printf "  vault secrets (count)  : %s\n",$2}
       $1=="CFGFP"{printf "  cron configuration fp  : %s\n",$2}
       $1=="FENCEABLE"{printf "  fenceable (informational, ADR-001): %s\n",$2}
       $1=="OUTFN"{printf "  outbound-capable fn    : %s\n",$2}' "$inv" >&2
  ok "clone-source inventory complete (read-only, no commands/URLs/secrets displayed) -> ${inv##*/}"
}

# Capture, pause, FENCE and mark — all inside ONE server-side transaction, then
# drain in-flight executions and ARM the window.
#
# A seal failure changes NOTHING (single transaction, rolled back), so there is
# no compensating restore to get wrong. Only an ARM failure needs one, and that
# is the same atomic resume the operator would run by hand.
# ===========================================================================
# UNSUPPORTED — the extension-table fence design is withdrawn (ADR-001)
# ===========================================================================
# The sealed-window design fenced cron.job and net.http_request_queue with
# deliberately-failing statement triggers. Both halves are unsupported:
#
#   * Supabase documents that triggers on net.http_request_queue — especially
#     failing ones — can disrupt pg_net itself:
#     https://supabase.com/docs/guides/troubleshooting/webhook-debugging-guide-M8sk47
#   * CREATE TRIGGER can be reached with the table's TRIGGER privilege, but
#     DROP TRIGGER requires ownership of the table. cron.job and
#     net.http_request_queue are extension-managed, so a GRANT TRIGGER produces
#     a fence that can be installed and NEVER removed by the same role. The
#     production inventory of 2026-08-02 returned FENCEABLE no for exactly this
#     reason.
#
# The supported remedies (taking ownership of extension tables, joining the
# extension-owner role, dropping/recreating the extension, or installing the
# trigger through a privileged wrapper) are all explicitly out of scope: each
# one trades a rehearsal convenience for a permanent change to how production's
# scheduler and outbound queue are owned.
#
# This guard therefore refuses BEFORE any connection is opened, before psql is
# required, and before any state is read or written. It is not a warning.
# (mutation-pinned: verify/clone-safety-test.sh, verify/repo-guard-test.sh)
UNSUPPORTED_ADR="docs/ADR-001-clone-safety-fence-withdrawn.md"
refuse_unsupported_fence() {   # $1 = the command name the operator typed
  warn "=========================================================================="
  warn "'$1' is WITHDRAWN and cannot run."
  warn ""
  warn "It installs statement triggers on cron.job and net.http_request_queue to"
  warn "freeze the snapshot window. Supabase advises against triggers on"
  warn "net.http_request_queue (a failing one can disrupt pg_net), and DROP TRIGGER"
  warn "needs OWNERSHIP of these extension-managed tables — which a GRANT TRIGGER"
  warn "does not confer. The fence could therefore be installed and never removed."
  warn ""
  warn "Production inventory (read-only, 2026-08-02) confirmed: FENCEABLE no."
  warn ""
  warn "Use the supported replacement instead — an empty, disposable project"
  warn "loaded with SYNTHETIC data at production scale:"
  warn "    clone-verify-empty      <clone_url>"
  warn "    clone-build-baseline    --yes <clone_url>"
  warn "    clone-reset-baseline    --yes <clone_url>   # between rehearsals"
  warn ""
  warn "Rationale, threat model and the open Supabase Support question:"
  warn "    scripts/rollout/notif-10ca3/${UNSUPPORTED_ADR}"
  warn "=========================================================================="
  die "$1 is withdrawn (ADR-001); nothing was connected to, read or changed"
}

cmd_clone_source_quiesce() {
  # FIRST STATEMENT. No require_yes, no argument parsing, no require_cmd psql, no
  # identity assertion — none of those may run, because none of them may connect.
  refuse_unsupported_fence "clone-source-quiesce"
}

# The captured relation is the authority; this is its human-readable shadow.
export_source_manifest() {   # $1 url
  psql "$1" -v ON_ERROR_STOP=1 -Atqc \
    "SELECT format('JOB\t%s\t%s\t%s', jobid, jobname, prior_active) FROM rollout_clone.snapshot_job_state ORDER BY jobid" \
    > "$SRC_MANIFEST" || die_rc "$?" "could not export the captured prior-state manifest"
  chmod 600 "$SRC_MANIFEST" 2>/dev/null || true
  validate_source_manifest "$SRC_MANIFEST"
}

# Quiescence is a STABLE property, not an instant. Two things go wrong with
# "sample once, see zero, proceed":
#   * pg_cron reaches 'running' only after starting -> connecting -> sending, so
#     a job about to issue an outbound request can read as zero (see
#     sql/_cron_inflight.sql — the count is by complement of the terminal set);
#   * the scheduler needs a cycle to observe active=false, so a zero read taken
#     immediately after the pause can be followed by a fresh start.
# We therefore require N consecutive quiet samples separated by a
# scheduler-observation interval, and any non-quiet sample resets the streak.
quiesce_drain() {   # $1 url
  local url="$1"
  local need="${QUIESCE_QUIET_SAMPLES:-2}" gap="${QUIESCE_SETTLE_SECS:-60}" tries="${QUIESCE_MAX_SAMPLES:-20}"
  [[ "$need" =~ ^[0-9]+$ && "$need" -ge 2 ]] || { warn "QUIESCE_QUIET_SAMPLES must be >= 2 (a single zero sample proves nothing)"; return 1; }
  # A zero or tiny interval collapses "two stable samples" into two back-to-back
  # reads, which is the very false green this loop exists to prevent. The floor
  # is a reviewed constant, not a knob: tests stub `sleep`, they do not disable
  # the safety interval. (mutation-pinned: verify/clone-safety-test.sh)
  [[ "$gap"  =~ ^[0-9]+$ && "$gap" -ge "$QUIESCE_MIN_SETTLE_SECS" ]] \
    || { warn "QUIESCE_SETTLE_SECS must be an integer >= ${QUIESCE_MIN_SETTLE_SECS}s (the scheduler needs a cycle to observe active=false); got '${gap}'"; return 1; }
  [[ "$tries" =~ ^[0-9]+$ && "$tries" -ge "$need" ]] || { warn "QUIESCE_MAX_SAMPLES must be >= QUIESCE_QUIET_SAMPLES"; return 1; }
  local streak=0 i out rc inflight queued logrun
  for (( i = 1; i <= tries; i++ )); do
    rc=0
    out="$(set -o pipefail
           psql "$url" -v ON_ERROR_STOP=1 --no-psqlrc -q -f "$SQL_DIR/cron_quiet_sample.sql" 2>/dev/null | sed -n 's/^SAMPLE //p' | tail -1)" || rc=$?
    # a failing subprocess keeps ITS status all the way out to the caller
    [[ "$rc" -eq 0 ]] || { warn "could not sample cron quiescence (psql exit ${rc})"; return "$rc"; }
    # exit 0 with no output has no subprocess status to preserve; 1 is the
    # tooling's own refusal, and the README says so rather than claiming more
    [[ -n "$out" ]] || { warn "the quiescence sample produced no SAMPLE record"; return 1; }
    read -r inflight queued logrun <<<"$out"
    case "$(printf '%s' "$logrun" | tr 'A-Z' 'a-z')" in
      on|true|yes|1) ;;
      *) warn "cron.log_run is '${logrun}' — in-flight runs are unobservable; refusing to certify a drain"; return 1;;
    esac
    if [[ "$inflight" == 0 && "$queued" == 0 ]]; then
      streak=$((streak + 1))
      log "quiet sample ${streak}/${need} (in-flight 0, queued 0)"
      [[ "$streak" -ge "$need" ]] && { ok "drained: ${need} consecutive quiet samples ${gap}s apart"; return 0; }
    else
      [[ "$streak" -eq 0 ]] || warn "quiet streak BROKEN by a late start (in-flight ${inflight}, queued ${queued}) — restarting the count"
      streak=0
      log "waiting: ${inflight} cron run(s) in flight, ${queued} queued (sample ${i}/${tries})"
    fi
    # an interrupted or failed sleep must NOT be read as "the interval elapsed",
    # and it keeps its own status too (SIGINT surfaces as 130, not a flat 1)
    sleep "$gap" || { rc=$?
      warn "the scheduler-observation sleep failed or was interrupted (exit ${rc}) — the interval did not elapse, so the samples are not separated"
      return "$rc"; }
  done
  warn "cron did not stay quiet for ${need} consecutive samples within ${tries} tries"
  return 1
}

# The ONE atomic transition out of the window: verify -> unfence -> restore ->
# prove -> drop the marker, in a single server-side transaction under ACCESS
# EXCLUSIVE. No committed state ever carries a valid marker beside active cron.
# Best-effort removal of a FALLBACK capture. Never changes the resume's status:
# a leaked temp file is a nuisance, a lost exit code is a wrong decision.
discard_temp_capture() {   # $1 path, $2 is_temp(0|1)
  [[ "${2:-0}" -eq 1 && -n "${1:-}" && -e "$1" ]] || return 0
  secure_delete "$1" || warn "could not remove the temporary resume capture ${1} — remove it manually"
  return 0
}

clone_source_leave_window() {   # $1 url, $2 nonce, $3 allow_unarmed(0|1)
  local url="$1" nonce="$2" unarmed="$3" rc=0 cap="" cap_tmp=0
  # DIAGNOSTIC CAPTURE IS BEST EFFORT AND MUST NEVER GATE THE RESUME. The failure
  # that triggered recovery may BE an unwritable or full evidence directory, and
  # a redirection that cannot open its target would stop the SQL from running at
  # all — leaving production paused and fenced for the sake of a log file.
  # Preference order: evidence dir -> a temp file -> no capture, straight to stderr.
  if : > "$EVID/clone-source-resume.txt" 2>/dev/null; then
    cap="$EVID/clone-source-resume.txt"
  # An explicit template, NOT `mktemp -t`: on macOS the -t form ignores $TMPDIR
  # and always uses the system temp directory, so the fallback would land
  # somewhere the caller never chose — and a cleanup contract for a file whose
  # location you do not control is not a contract. (Found while pinning that
  # cleanup: the assertion was passing vacuously.)
  elif cap="$(mktemp "${TMPDIR:-/tmp}/rollout-resume-XXXXXX" 2>/dev/null)"; then
    cap_tmp=1                    # transient: removed below on BOTH exit paths
    warn "the evidence directory is not writable — resume diagnostics go to ${cap}"
  else
    cap=""
    warn "no writable location for resume diagnostics — running the resume anyway, output to stderr"
  fi
  if [[ -n "$cap" ]]; then
    run_sql_soft "$url" "$SQL_DIR/clone_source_resume.sql" -v "nonce=$nonce" -v "allow_unarmed=$unarmed" \
      > "$cap" 2>&1 || rc=$?
  else
    run_sql_soft "$url" "$SQL_DIR/clone_source_resume.sql" -v "nonce=$nonce" -v "allow_unarmed=$unarmed" \
      >&2 || rc=$?
  fi
  if [[ "$rc" -ne 0 ]]; then
    warn "resume transaction FAILED and rolled back — production remains paused and fenced with its marker intact"
    [[ -n "$cap" ]] && grep -E '^(ERROR|psql)' "$cap" 2>/dev/null | head -6 >&2
    [[ "$cap_tmp" -eq 1 ]] && warn "the diagnostics above came from a temporary capture, which is now removed"
    discard_temp_capture "$cap" "$cap_tmp"
    return "$rc"
  fi
  discard_temp_capture "$cap" "$cap_tmp"
  ok "production cron restored to its EXACT recorded set, configuration and active state; fences and marker removed"
  return 0
}

cmd_clone_source_resume() {
  require_yes "${1:-}"
  local url="${2:-}"; require_arg "$url" "usage: clone-source-resume --yes <prod_conn_url>"
  require_cmd psql; assert_conn_url_is_ref "$EXPECTED_REF" "$url"
  local nonce; nonce="$(read_recorded_nonce)"
  clone_source_leave_window "$url" "$nonce" 0 \
    || die "RESUME FAILED — production is still PAUSED and FENCED; investigate and retry immediately"
  # the nonce FILE is retained deliberately: clones are verified after production
  # resumes, and each clone must still prove it carries this exact marker.
  ok "restore-point contract: only a clone restored between the ARM commit and this"
  ok "resume commit carries an armed marker AND a live fence — anything outside fails"
}

# EXPLICIT, reviewed recovery for a window whose run was abandoned (e.g. the
# operator's session died between seal and arm). Requires the operator to read
# the nonce out of the database and pass it back, so no stale window is ever
# cleared implicitly or by accident.
cmd_clone_source_abandon() {
  require_yes "${1:-}"; shift
  local nonce="" url=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --nonce) nonce="${2:-}"; shift 2;;
      *) url="$1"; shift;;
    esac
  done
  require_arg "$url"   "usage: clone-source-abandon --yes --nonce <nonce> <prod_conn_url>"
  require_arg "$nonce" "clone-source-abandon REQUIRES --nonce <the nonce recorded in rollout_clone.snapshot_marker>"
  [[ "$nonce" =~ ^[0-9a-f]{32,}$ ]] || die "the supplied nonce is malformed"
  require_cmd psql; assert_conn_url_is_ref "$EXPECTED_REF" "$url"
  warn "ABANDON: leaving an un-armed or foreign sealed window. This restores prior"
  warn "cron state and removes the fence and marker — the same atomic transition as"
  warn "resume, with the arm requirement waived because you named the nonce."
  clone_source_leave_window "$url" "$nonce" 1 \
    || die "ABANDON FAILED — production is still PAUSED and FENCED; investigate immediately"
}

read_recorded_nonce() {
  [[ -f "$EVID/clone-source-nonce.txt" ]] \
    || die "no sealed snapshot on file — run clone-source-quiesce first (or, for an abandoned window, clone-source-abandon --nonce <n>)"
  local n; n="$(cat "$EVID/clone-source-nonce.txt")"
  [[ "$n" =~ ^[0-9a-f]{32,}$ ]] || die "recorded snapshot nonce is malformed"
  printf '%s' "$n"
}


# ===========================================================================
# SUPPORTED REHEARSAL TARGET — empty project + synthetic scale data (ADR-001)
# ===========================================================================
# Replaces "restore production, then fence it". Nothing about production is
# copied: no cron jobs, no pg_net queue or responses, no Vault secrets, no
# webhooks or outbound triggers, no FDWs, no auth users, no customer rows. The
# target is outbound-inert BY CONSTRUCTION, which is a stronger property than a
# restored project that has been quiesced.
SCALE_FILE="$HERE/clone-safety/rehearsal-scale.json"
BASELINE_FP="$EVID/rehearsal-baseline-fingerprint.txt"

# The target must be a real, distinct, disposable project — the same identity
# proof the old flow used, because that part was never the problem.
assert_rehearsal_target() {   # $1 = url
  assert_clone_url "$1"
  run_artifact "$1" empty_project_check.sql
  ok "rehearsal target verified EMPTY and outbound-inert (nothing to quiesce, nothing to fence)"
}

cmd_clone_verify_empty() {
  local url="${1:-}"; require_arg "$url" "usage: CLONE_REF=<ref> clone-verify-empty <clone_conn_url>"
  require_cmd psql
  assert_rehearsal_target "$url"
}

# A rehearsal is only honest if its scale was MEASURED. Invented row counts
# produce an invented timing result, so the file must say so explicitly.
assert_scale_is_measured() {
  require_cmd node
  [[ -f "$SCALE_FILE" ]] || die "missing rehearsal scale file: $SCALE_FILE"
  local src
  src="$(node -e 'process.stdout.write(String(require(process.argv[1]).source))' "$SCALE_FILE")" \
    || die "could not read $SCALE_FILE"
  [[ "$src" == measured ]] \
    || die "rehearsal-scale.json has source=\"${src}\": the affected-table row counts have not been measured against production. A rehearsal built on invented numbers is not evidence. Fill it from the READ-ONLY sizing query in ${UNSUPPORTED_ADR} section 7 and set source=\"measured\"."
  ok "rehearsal scale is marked measured"
}

# Build the pristine baseline: schema from MAIN (pre-#615), every schedule
# deactivated, then synthetic rows in ONLY the two tables #615 locks.
cmd_clone_build_baseline() {
  require_yes "${1:-}"
  local url="${2:-}"; require_arg "$url" "usage: CLONE_REF=<ref> clone-build-baseline --yes <clone_conn_url>"
  require_cmd psql; require_cmd supabase; require_cmd node
  # Identity first, and FATALLY: an auth, connectivity or wrong-ref failure must
  # surface as itself. Recommending a destructive recovery for those would be
  # actively harmful.
  assert_clone_url "$url"

  # Only now, the emptiness question. A build that failed PART-WAY leaves a
  # target that is no longer empty and has no fingerprint, and without a hint the
  # operator is stuck between a build that refuses a non-empty target and a reset
  # that refuses a missing baseline. The ORIGINAL diagnostic is always shown.
  local probe rc=0
  probe="$(mktemp "${TMPDIR:-/tmp}/rollout-empty-XXXXXX")" || die "could not create a probe capture"
  run_sql_soft "$url" "$SQL_DIR/empty_project_check.sql" > "$probe" 2>&1 || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    warn "the target did not pass the empty-project check:"
    grep -E '^(ERROR|psql|NOTICE)' "$probe" | sed 's/^/  /' | head -6 >&2
    local partial=0
    grep -q 'not a pristine disposable project\|is not empty\|rehearsal_target_marker\|holds .* Vault\|auth user' "$probe" && partial=1
    if [[ "$partial" -eq 1 ]] && psql "$url" -v ON_ERROR_STOP=1 -Atqc \
         "SELECT 1 FROM net.rehearsal_target_marker LIMIT 1" >/dev/null 2>&1; then
      rm -f "$probe"
      [[ -s "$BASELINE_FP" ]] \
        && die "this target already carries a recorded baseline — use 'clone-baseline-verify' or 'clone-reset-baseline --yes'" \
        || die "the target carries THIS TOOLING'S marker but no baseline is on file, so a previous build failed part-way. Recover with:
    clone-reset-baseline --yes --recover <clone_url>
  which wipes it back to bare metal, rebuilds, and records the baseline."
    fi
    rm -f "$probe"
    die "the target is not usable as a rehearsal target — see the diagnostic above. --recover is NOT offered: it is only for a target this tooling part-built (one carrying net.rehearsal_target_marker), and destroying anything else would be the wrong answer."
  fi
  rm -f "$probe"
  ok "rehearsal target verified EMPTY and outbound-inert (nothing to quiesce, nothing to fence)"

  assert_scale_is_measured
  mkdir -p "$EVID"
  clone_build_schema_and_data "$url"
  clone_capture_baseline "$url"
  ok "PRISTINE BASELINE built. Every rehearsal must start from this fingerprint;"
  ok "use 'clone-reset-baseline --yes <url>' between rehearsals B/C/D."
}

# The build itself. Shared by build and reset so a reset cannot drift from the
# thing it claims to restore.
clone_build_schema_and_data() {   # $1 url
  local url="$1" san rc=0

  # 1) INERT FIRST — and inert by CONSTRUCTION, not by hope. The chain installs
  #    pg_cron and pg_net (20260117134212, 20260330204208), so pre-creating
  #    stand-ins and leaving those statements in place would collide with the
  #    extension and then hand the target a real scheduler anyway. The source is
  #    therefore SANITIZED (those CREATE EXTENSION statements neutralised, and
  #    anything else that could reach outside the box refused), and the inert
  #    stand-ins go in before it runs.
  run_artifact "$url" platform_stub.sql
  san="$(mktemp -d "${TMPDIR:-/tmp}/rollout-sanitized-XXXXXX")" || die "could not create a sanitized migration directory"
  node "$HERE/synth/sanitize-migrations.mjs" "$REPO_ROOT/supabase/migrations" "$san/migrations" \
    || { rm -rf "$san"; die "the migration chain could not be sanitized — see the refusals above"; }

  # 2) schema from the sanitized MAIN chain — NOT from the #615 pin. The
  #    migrations under test are applied later, on their own, or the measurement
  #    means nothing.
  log "building schema on the rehearsal target from sanitized main"
  ( cd "$san" && printf 'project_id = "%s"\n' "$CLONE_REF" > config.toml \
    && NO_COLOR=1 supabase db push --db-url "$url" --workdir "$san" ) || rc=$?
  rm -rf "$san"
  [[ "$rc" -eq 0 ]] || die "schema build failed on the rehearsal target (exit ${rc})"

  # 3) belt and braces: prove nothing became active, and that the target is inert
  run_artifact "$url" clone_deactivate_schedules.sql
  run_artifact "$url" rehearsal_inert_check.sql

  # 4) synthetic scale data — only the affected tables
  log "loading synthetic scale data (no production value is read or copied)"
  node "$HERE/synth/build-baseline.mjs" "$url" "$SCALE_FILE" \
    || die "synthetic baseline load failed"
}

clone_capture_baseline() {   # $1 url
  local tmp rc=0
  tmp="$(mktemp "${TMPDIR:-/tmp}/rollout-baseline-XXXXXX")" || die "could not create a baseline capture"
  psql "$1" -v ON_ERROR_STOP=1 --no-psqlrc -q -f "$SQL_DIR/baseline_fingerprint.sql" > "$tmp" 2>&1 || rc=$?
  if [[ "$rc" -ne 0 ]]; then rm -f "$tmp"; die "could not fingerprint the baseline (psql exit ${rc})"; fi
  grep -q '^SYNTHETIC ok$' "$tmp" || { rm -f "$tmp"; die "baseline contains a NON-SYNTHETIC address — refusing to record it"; }
  mv "$tmp" "$BASELINE_FP"; chmod 600 "$BASELINE_FP" 2>/dev/null || true
  ok "baseline fingerprint recorded -> ${BASELINE_FP##*/}"
}

# Re-assert the recorded fingerprint. A rehearsal that starts from a drifted
# baseline is refused — including one drifted by a FAILED migration, which is
# exactly the false green this guard exists to prevent.
cmd_clone_baseline_verify() {
  local url="${1:-}"; require_arg "$url" "usage: CLONE_REF=<ref> clone-baseline-verify <clone_conn_url>"
  require_cmd psql; assert_clone_url "$url"
  [[ -s "$BASELINE_FP" ]] || die "no recorded baseline — run clone-build-baseline first"
  local tmp rc=0
  tmp="$(mktemp "${TMPDIR:-/tmp}/rollout-baseline-XXXXXX")" || die "could not create a comparison capture"
  psql "$url" -v ON_ERROR_STOP=1 --no-psqlrc -q -f "$SQL_DIR/baseline_fingerprint.sql" > "$tmp" 2>&1 || rc=$?
  if [[ "$rc" -ne 0 ]]; then rm -f "$tmp"; die "could not fingerprint the target (psql exit ${rc})"; fi
  if ! diff -q "$BASELINE_FP" "$tmp" >/dev/null 2>&1; then
    warn "the target does NOT match the recorded pristine baseline:"
    diff "$BASELINE_FP" "$tmp" | head -20 >&2
    rm -f "$tmp"
    die "rehearsal target has drifted — run 'clone-reset-baseline --yes <url>' before rehearsing"
  fi
  rm -f "$tmp"
  ok "rehearsal target matches the recorded pristine baseline exactly"
}

# Between rehearsals: reload the synthetic data and prove the fingerprint is
# identical to the recorded baseline. No production snapshot is restored.
# Between rehearsals: a REAL rebuild, not a row reload.
#
# Rehearsals B and C deliberately leave the target broken, and A/D leave all
# three #615 migrations applied — new columns, functions, tables, constraints and
# three ledger rows. Truncating two tables cannot reverse any of that, so a
# reset that only reloaded rows would hand the next rehearsal a migrated target
# and call it pristine. The target is therefore wiped to bare metal (schema,
# shims and migration ledger) and rebuilt by the same code path as the original
# build, then the fingerprint is required to match byte for byte.
#
# Still no production snapshot is restored, and still no customer data exists.
cmd_clone_reset_baseline() {
  require_yes "${1:-}"; shift
  local recover=0 url=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --recover) recover=1; shift;;
      *) url="$1"; shift;;
    esac
  done
  require_arg "$url" "usage: CLONE_REF=<ref> clone-reset-baseline --yes [--recover] <clone_conn_url>"
  require_cmd psql; require_cmd supabase; require_cmd node; assert_clone_url "$url"
  if [[ "$recover" -eq 1 ]]; then
    # RECOVERY. Only for a target whose FIRST build failed before any fingerprint
    # was recorded. It is explicit precisely because it will happily discard a
    # half-built target — which is correct there and wrong anywhere else.
    [[ -s "$BASELINE_FP" ]] \
      && die "--recover is only for a target with NO recorded baseline; this one has one, so use a plain reset (it verifies against the recorded fingerprint)"
    warn "RECOVERING a part-built target: wiping to bare metal and rebuilding from scratch"
  else
    [[ -s "$BASELINE_FP" ]] \
      || die "no recorded baseline — if a first build failed part-way, use 'clone-reset-baseline --yes --recover <url>'; otherwise run clone-build-baseline first"
  fi
  assert_scale_is_measured
  warn "wiping the rehearsal target to bare metal (schema + stand-ins + migration ledger)"
  run_artifact "$url" clone_wipe.sql
  run_artifact "$url" empty_project_check.sql
  ok "target is bare and inert again; rebuilding"
  clone_build_schema_and_data "$url"
  if [[ "$recover" -eq 1 ]]; then
    clone_capture_baseline "$url"
    ok "target RECOVERED and a pristine baseline recorded"
  else
    cmd_clone_baseline_verify "$url"
    ok "rehearsal target REBUILT and byte-identical to the recorded pristine baseline"
  fi
}

# CLONE-SIDE GATE for the supported model. No rehearsal command may touch a
# target until it is proven INERT and byte-identical to the recorded pristine
# baseline. There is no marker and no fence to check any more: the target never
# held production state, so there is no provenance question to answer — only an
# inertness one, and it is answered directly. (ADR-001 §5)
assert_clone_isolated() {   # $1 = target url
  local url="$1"
  run_artifact "$url" rehearsal_inert_check.sql
  cmd_clone_baseline_verify "$url"
  ok "rehearsal target proven inert and matching the pristine baseline"
}

# Shared preamble for the two clone-migrating commands: clone identity (provably
# NOT production), a green + head-pinned #615, and a detached worktree at that pin.
# #615 is NOT merged at step 8, so its three migrations exist ONLY at PR615_SHA —
# a push from main/#620 would apply NOTHING. Never merges #615; never uses the
# ambient linked project (--db-url addresses the clone directly).
clone_push_preamble() {   # $1 = clone url
  require_cmd gh; require_cmd supabase; require_cmd psql
  assert_clone_url "$1"                         # clone identity, and provably not production
  assert_caps                                   # positive integers; 0 would disable the cap
  git fetch origin
  assert_sha_matches_pin "$(pr_head_sha 615)" "$PR615_SHA" "#615 head"
  gh pr checks 615 || die "#615 checks are not green — refusing to rehearse an unreviewed migration set"
  mk_worktree "$PR615_SHA"                      # the migrations live HERE, not on main
}

# STEP 8 clone push — applies the migrations still MISSING from the clone.
# It must NOT demand all three: rehearsal C deliberately leaves the clone at a
# legitimate ordered PREFIX, and the whole point of that rehearsal is to push the
# remaining suffix. So it classifies the clone ledger exactly like production
# recovery does (none/prefix1/prefix2/all/invalid) and requires the matching
# pending suffix — none->V1,V2,V3  prefix1->V2,V3  prefix2->V3  all->no-op
# invalid->refuse. (runtime + mutation pinned: verify/operator-flow-test.sh)
cmd_clone_push() {
  require_yes "${1:-}"
  local url="${2:-}"; require_arg "$url" "usage: CLONE_REF=<ref> CAP_STMT=<ms> clone-push --yes <clone_conn_url>"
  require_cmd psql; assert_clone_url "$url"
  assert_clone_isolated "$url"          # no rehearsal touches a clone that is not provably inert
  local CAP_LOCK="${CAP_LOCK:-3000}" st suffix
  st="$(ledger_status "$url")"; ok "clone ledger state = $st"
  case "$st" in
    invalid) die "clone ledger holds an IMPOSSIBLE subset — refusing to push onto a corrupt state; restore the snapshot";;
    all)     ok "clone already at 'all' — nothing to push. Next: CLONE_REF=$CLONE_REF $0 verify-clone <url> --clone"; return 0;;
  esac
  suffix="$(expected_pending_suffix "$st" "$V1" "$V2" "$V3")"
  clone_push_preamble "$url"
  ( cd "$WT"
    local pending; pending="$(clone_dry_run_pending "$url")" || die "clone dry run failed (see the CLI diagnostic above)"
    log "clone db push --dry-run pending:"; printf '%s\n' "$pending" >&2
    assert_pending_is_expected "$pending" "$suffix"
    log "clone db push (lock_timeout=${CAP_LOCK}ms statement_timeout=${CAP_STMT}ms)"
    PGOPTIONS="-c lock_timeout=${CAP_LOCK} -c statement_timeout=${CAP_STMT}" \
      supabase db push --db-url "$url" --yes ) || die "clone db push failed (ledger=$(ledger_status "$url"))"
  local st2; st2="$(ledger_status "$url")"
  [[ "$st2" == all ]] || die "after the clone push, ledger='$st2' (expected all)"
  ok "clone migrated ${st} -> all from the reviewed pin ${PR615_SHA:0:12} (#615 NOT merged)"
}

# REHEARSAL C setup: put the clone into a LEGITIMATE prefix state on purpose.
# `supabase db push` has no "apply only the first file" flag, so the prefix is
# produced the way a real interrupted push produces it: the CLI applies whole
# migration files, one transaction + one ledger row each. We hand it a detached
# worktree at the reviewed pin with the LATER files PRUNED, so it applies exactly
# the prefix and writes exactly those ledger rows — real CLI, real ledger, no
# hand-written INSERT into supabase_migrations. The prune touches ONLY the
# disposable worktree; the checkout and the pinned commit are untouched.
# Requires a PRISTINE clone: you cannot manufacture a prefix over existing state.
cmd_clone_make_prefix() {
  require_yes "${1:-}"
  local depth="${2:-}" url="${3:-}" usage="usage: CLONE_REF=<ref> CAP_STMT=<ms> clone-make-prefix --yes <1|2> <clone_conn_url>"
  require_arg "$depth" "$usage"; require_arg "$url" "$usage"
  [[ "$depth" == 1 || "$depth" == 2 ]] || die "prefix depth must be 1 or 2 (got '$depth') — those are the only legitimate prefixes"
  require_cmd psql; assert_clone_url "$url"
  assert_clone_isolated "$url"          # no rehearsal touches a clone that is not provably inert
  local CAP_LOCK="${CAP_LOCK:-3000}" st want prune
  st="$(ledger_status "$url")"
  [[ "$st" == none ]] || die "clone-make-prefix needs a PRISTINE clone (ledger=none); this clone is '$st' — restore the snapshot first"
  if [[ "$depth" == 1 ]]; then want="$(printf '%s\n' "$V1")";        prune="$V2 $V3"
  else                        want="$(printf '%s\n%s\n' "$V1" "$V2")"; prune="$V3"; fi
  clone_push_preamble "$url"
  ( cd "$WT"
    local v; for v in $prune; do rm -f supabase/migrations/"${v}"_*.sql; done
    log "worktree pruned to the first ${depth} migration(s); dry-run:"
    local pw; pw="$(clone_dry_run_pending "$url")" || die "clone dry run failed"
    assert_pending_is_expected "$pw" "$want"
    PGOPTIONS="-c lock_timeout=${CAP_LOCK} -c statement_timeout=${CAP_STMT}" \
      supabase db push --db-url "$url" --yes ) || die "partial (prefix) push failed"
  local st2; st2="$(ledger_status "$url")"
  [[ "$st2" == "prefix${depth}" ]] || die "expected ledger 'prefix${depth}' after the partial push, got '$st2'"
  ok "clone is now at ${st2} — created by the real CLI writing real ledger rows"
}
# These three take a <conn_url> and are DECISION-CRITICAL: preflight's CAP_STMT is
# what bounds the production push, postflight is the documented gate-OFF
# authorization, and ledger-status decides resume615-vs-apply615. Run against the
# wrong database (typo, a stale clone URL in scrollback, wrong project) they would
# report green about a database nobody is rolling out. So they now assert the
# target is EXPECTED_REF by default; a clone must be named explicitly with
# --clone, which is loud and cannot happen by accident.
# (mutation-pinned: verify/operator-flow-test.sh)
target_guard() {   # $1 url, $2 = "--clone" | ""
  if [[ "${2:-}" == "--clone" ]]; then
    assert_clone_url "$1"          # NOT a skip: proves CLONE_REF is set, != prod, and matches the URL
  else
    assert_conn_url_is_ref "$EXPECTED_REF" "$1"
  fi
}
cmd_preflight()  { local url="${1:-}"; require_arg "$url" "usage: preflight <conn_url> [--clone]"
  target_guard "$url" "${2:-}"
  # NB: `[[ cond ]] && cmd` as a non-final statement returns 1 when cond is false
  # and aborts under `set -e` — production preflight must not depend on that.
  if [[ "${2:-}" == "--clone" ]]; then assert_clone_isolated "$url"; fi
  run_artifact "$url" preflight.sql; }
cmd_postflight() { local url="${1:-}"; require_arg "$url" "usage: postflight <conn_url> [--clone]"
  target_guard "$url" "${2:-}"
  run_artifact "$url" postflight.sql; run_artifact "$url" acl_matrix.sql; run_artifact "$url" ledger_verification.sql; }
cmd_ledger_status() { local url="${1:-}"; require_arg "$url" "usage: ledger-status <conn_url> [--clone]"
  target_guard "$url" "${2:-}"; echo "ledger state: $(ledger_status "$url")"; }

# Delete the pseudonymous manifests + secret salt — ONLY once the rollout is
# provably COMPLETE. The pre-manifest + salt are the only recovery material for
# resume615, so every prerequisite below must pass BEFORE anything is deleted;
# any failure preserves all files. (mutation-tested by operator-flow-test.sh)
cmd_clean_evidence() {
  require_yes "${1:-}"
  local url="${2:-}"; require_arg "$url" "usage: clean-evidence --yes <prod_conn_url>"
  require_cmd psql; require_cmd curl; require_cmd jq
  require_env MANAGER_TOKEN "set MANAGER_TOKEN (academy manager JWT) for the gate probe"
  # 1) exact project identity
  assert_conn_url_is_ref "$EXPECTED_REF" "$url"
  # 2) rollout complete: all three migrations in the ledger
  local st; st="$(ledger_status "$url")"
  [[ "$st" == all ]] || die "clean-evidence REFUSED: ledger='$st' (need all) — the pre-manifest is recovery material for resume615"
  # 3) both manifests present, internally valid, and the no-loss proof passes
  local pre="$EVID/manifest-pre.txt" post="$EVID/manifest-post.txt"
  [[ -f "$pre" && -f "$post" ]] || die "clean-evidence REFUSED: missing pre/post manifest"
  assert_manifest_no_loss "$pre" "$post"
  # 4) postflight / ACL / ledger verification still pass on prod
  run_artifact "$url" postflight.sql
  run_artifact "$url" acl_matrix.sql
  run_artifact "$url" ledger_verification.sql
  # 5) maintenance gate confirmed OFF (sends restored)
  local probe="https://${EXPECTED_REF}.functions.supabase.co/send-invoice-email?probe=1" body
  body="$(curl -sS "$probe" -H "Authorization: Bearer ${MANAGER_TOKEN}")"
  printf '%s' "$body" | jq -e '.maintenance == false' >/dev/null \
    || die "clean-evidence REFUSED: maintenance gate is not OFF"
  # ALL prerequisites passed — deletion happens strictly last. edge-log-lines.txt
  # is deliberately NOT deleted here (drain evidence; PII-free by design).
  # A file that could not be securely deleted must NEVER be counted as cleaned:
  # secure_delete fails closed (symlink / failed overwrite / failed unlink), and
  # that failure is propagated instead of being absorbed by the loop.
  # (mutation-pinned: verify/operator-flow-test.sh)
  local f n=0 bad=0
  for f in "$pre" "$post" "$EVID/manifest-salt.txt"; do
    if [[ -f "$f" || -L "$f" ]]; then
      if secure_delete "$f"; then n=$((n+1)); else bad=$((bad+1)); fi
    fi
  done
  [[ "$bad" -eq 0 ]] || die "rollout is verified BUT ${bad} evidence file(s) could NOT be securely deleted (${n} were) — they still hold pseudonymous data; delete them by hand. NOT reporting the evidence as cleaned."
  ok "rollout complete + verified — cleaned ${n} pseudonymous file(s) (manifests + salt)"
}

cmd_rollback615() {
  local url="${1:-}" st; require_arg "$url" "usage: rollback615 <conn_url> [--clone]"
  target_guard "$url" "${2:-}"; st="$(ledger_status "$url")"
  cat >&2 <<EOF
[recovery] migration-ledger state = ${st}

Each 20261006* file is additive + transactional; \`supabase db push\` applies
each file in its own transaction + ledger row, so a mid-way failure leaves an
ordered PREFIX (only none, {$V1}, {$V1,$V2}, or all are legitimate).

  none     -> nothing applied. Fix the migration; re-run dryrun615 then apply615.
  prefix1  -> only $V1 applied. Run 'resume615 --yes' (pushes the $V2,$V3 suffix).
  prefix2  -> $V1,$V2 applied. Run 'resume615 --yes' (pushes the $V3 suffix).
  all      -> every file applied. Run 'postflight $url'; gate may go OFF once it passes.
  invalid  -> the ledger holds an IMPOSSIBLE subset (e.g. {$V2} or {$V1,$V3}).
              STOP. Investigate manually; do NOT resume and do NOT turn the gate OFF.

resume615 does NOT re-merge #615 and does NOT overwrite the original
pre-migration baseline. Never turn the gate OFF until 'postflight $url' passes.
EOF
}

# Executable partial-migration recovery. Resumes an interrupted apply615 WITHOUT
# re-merging #615 and WITHOUT overwriting the ORIGINAL pre-migration manifest.
# For prefix states it re-establishes gating and runs a FRESH exact-canary drain
# immediately before the suffix push (current maintenance state does not prove
# uninterrupted gating).
cmd_resume615() {
  require_yes "${1:-}"; require_cmd supabase; require_cmd curl; require_cmd jq; require_cmd psql
  require_env MANAGER_TOKEN "set MANAGER_TOKEN"
  assert_caps            # before the gate is re-enabled and before the suffix push
  require_env SUPABASE_DB_PASSWORD "set SUPABASE_DB_PASSWORD"
  require_env SUPABASE_ACCESS_TOKEN "set SUPABASE_ACCESS_TOKEN"
  require_env PROD_CONN_URL "set PROD_CONN_URL (password via PGPASSWORD)"
  local CAP_LOCK="${CAP_LOCK:-3000}" prod="$PROD_CONN_URL"
  assert_conn_url_is_ref "$EXPECTED_REF" "$prod"
  local probe="https://${EXPECTED_REF}.functions.supabase.co/send-invoice-email?probe=1" body
  # reuse the ORIGINAL apply615 manifest + salt (never re-capture pre)
  local pre="$EVID/manifest-pre.txt" saltf="$EVID/manifest-salt.txt"
  [[ -f "$pre" && -f "$saltf" ]] || die "no original pre-migration manifest+salt in $EVID — cannot resume safely"
  validate_manifest "$pre" pre
  ROLLOUT_SALT="$(cat "$saltf")"; [[ -n "$ROLLOUT_SALT" ]] || die "empty manifest salt"
  local st; st="$(ledger_status "$prod")"; ok "ledger state = $st"
  case "$st" in
    none)    die "ledger=none — nothing applied. Use apply615 (not resume).";;
    invalid) die "ledger=INVALID (impossible subset) — STOP. Do NOT resume.";;
    all)
      # verify-only: no migration to push, so no drain needed
      body="$(curl -sS "$probe" -H "Authorization: Bearer ${MANAGER_TOKEN}")"
      printf '%s' "$body" | jq -e '.maintenance != null' >/dev/null || die "probe failed"
      ;;
    prefix1|prefix2)
      local suffix resume_sha; suffix="$(expected_pending_suffix "$st" "$V1" "$V2" "$V3")"
      resume_sha="$(resolve_recovery_sha)"      # reviewed pin, or a proven-merged RECOVERY_PR
      # ALWAYS re-establish gating + a FRESH exact-canary drain before pushing
      log "ensuring maintenance gate is ON before resume"
      supabase secrets set INVOICE_EMAIL_MAINTENANCE=1 --project-ref "$EXPECTED_REF"
      body="$(curl -sS "$probe" -H "Authorization: Bearer ${MANAGER_TOKEN}")"
      printf '%s' "$body" | jq -e '.maintenance == true' >/dev/null || die "gate did not activate; ABORT resume"
      local T_GATE; T_GATE="$(now_iso)"; ok "gate ON at $T_GATE (resume)"
      prove_drain "$T_GATE"                      # cannot reach the suffix push without this
      git fetch origin
      mk_worktree "$resume_sha"
      link_worktree_pooler || die "worktree link failed — the suffix push was NOT attempted; gate stays ON"
      ( cd "$WT"; export SUPABASE_PROJECT_ID="$EXPECTED_REF"
        local pr; pr="$(push_dry_run_pending)" || die "resume dry run failed — gate stays ON"
        assert_pending_is_expected "$pr" "$suffix"
        log "resume db push (suffix; lock_timeout=${CAP_LOCK}ms statement_timeout=${CAP_STMT}ms)"
        PGOPTIONS="-c lock_timeout=${CAP_LOCK} -c statement_timeout=${CAP_STMT}" supabase db push --linked --yes ) \
        || die "resume db push failed. ledger=$(ledger_status "$prod"). Gate stays ON."
      local st2; st2="$(ledger_status "$prod")"
      [[ "$st2" == all ]] || die "after resume, ledger='$st2' (expected all). Gate stays ON."
      ;;
  esac
  # verify + no-loss vs the ORIGINAL pre-manifest, then permit gate-off
  run_artifact "$prod" postflight.sql
  run_artifact "$prod" acl_matrix.sql
  run_artifact "$prod" ledger_verification.sql
  capture_manifest "$prod" post
  assert_manifest_no_loss "$pre" "$EVID/manifest-post.txt"
  log "deactivating maintenance gate"
  supabase secrets unset INVOICE_EMAIL_MAINTENANCE --project-ref "$EXPECTED_REF"
  body="$(curl -sS "$probe" -H "Authorization: Bearer ${MANAGER_TOKEN}")"
  printf '%s' "$body" | jq -e '.maintenance == false' >/dev/null || die "gate not back to maintenance=false; investigate"
  ok "resume complete: ledger=all, postflight passed, no-loss verified, gate OFF"
}

# --- dispatch --------------------------------------------------------------
sub="${1:-}"; shift || true
case "$sub" in
  check-identity) cmd_check_identity "$@";;
  phase616)       cmd_phase616 "$@";;
  dryrun615)      cmd_dryrun615 "$@";;
  preflight)      cmd_preflight "$@";;
  apply615)       cmd_apply615 "$@";;
  resume615)      cmd_resume615 "$@";;
  verify-clone)   cmd_verify_clone "$@";;
  clone-push)     cmd_clone_push "$@";;
  clone-make-prefix) cmd_clone_make_prefix "$@";;
  clone-source-inventory) cmd_clone_source_inventory "$@";;
  clone-source-quiesce)   cmd_clone_source_quiesce "$@";;
  clone-verify-empty)     cmd_clone_verify_empty "$@";;
  clone-build-baseline)   cmd_clone_build_baseline "$@";;
  clone-baseline-verify)  cmd_clone_baseline_verify "$@";;
  clone-reset-baseline)   cmd_clone_reset_baseline "$@";;
  clone-source-resume)    cmd_clone_source_resume "$@";;
  clone-source-abandon)   cmd_clone_source_abandon "$@";;
  postflight)     cmd_postflight "$@";;
  ledger-status)  cmd_ledger_status "$@";;
  clean-evidence) cmd_clean_evidence "$@";;
  rollback615)    cmd_rollback615 "$@";;
  *) cat >&2 <<EOF
usage: EXPECTED_REF=<ref> $0 <subcommand> [args]
  check-identity [url] | phase616 --yes | dryrun615 | preflight <url> | apply615 --yes |
  resume615 --yes | postflight <url> | ledger-status <url> |
  rollback615 <url> [--clone] | clean-evidence --yes <url>
production audit (READ-ONLY):
  clone-source-inventory <prod_url>          # outbound inventory; mutates nothing
WITHDRAWN (refuses before connecting — see docs/ADR-001):
  clone-source-quiesce                       # extension-table fences are unsupported
RECOVERY ONLY, for a window opened by the withdrawn tooling:
  clone-source-resume  --yes <prod_url>      # ONE atomic tx: unfence + exact restore + unmark
  clone-source-abandon --yes --nonce <n> <prod_url>   # explicit stale-window recovery
supported rehearsal target (empty disposable project + SYNTHETIC scale data):
  clone-verify-empty     <clone_url>             # prove it is empty + outbound-inert
  clone-build-baseline   --yes <clone_url>       # schema from main, schedules off, synthetic rows
  clone-baseline-verify  <clone_url>             # target == recorded pristine baseline
  clone-reset-baseline   --yes [--recover] <clone_url>  # between rehearsals; --recover for a part-built target
clone-only (CLONE_REF=<ref> != EXPECTED_REF, CAP_STMT=<ms>; provenance = the sealed marker):
  clone-push --yes <clone_url>                 # push the MISSING suffix from PR615_SHA
  clone-make-prefix --yes <1|2> <clone_url>    # rehearsal C: real partial apply
  verify-clone <clone_url> --clone             # post-migration battery
EOF
     exit 2;;
esac
