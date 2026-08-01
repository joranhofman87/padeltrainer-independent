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
REVIEWED_JOBS="$HERE/clone-safety/reviewed-cron-jobs.tsv"
SRC_MANIFEST="$EVID/clone-source-manifest.txt"

# Parse the inventory artifact into safe fields. Never echoes a command, URL,
# header, body or secret — the SQL only ever emits names, counts and md5s.
read_source_inventory() {   # $1 = prod url -> writes $2 (raw safe lines)
  run_sql "$1" "$SQL_DIR/clone_source_inventory.sql" > "$2" 2>&1 \
    || die "clone-source inventory FAILED to read (connection/permissions?) — refusing to classify blind"
  grep -qE '^(NETQUEUE|RUNNING) ' "$2" || die "clone-source inventory produced no counts — refusing to proceed on a partial read"
}

# FAIL CLOSED on anything not in the reviewed set, and on any outbound mechanism
# the review did not classify.
assert_inventory_is_reviewed() {   # $1 = inventory file
  local inv="$1" name unknown=0 n
  [[ -f "$REVIEWED_JOBS" ]] || die "missing reviewed job list: $REVIEWED_JOBS"
  while read -r name; do
    [[ -n "$name" ]] || continue
    awk -F'\t' -v j="$name" '!/^#/ && $1==j {found=1} END{exit !found}' "$REVIEWED_JOBS" \
      || { warn "UNREVIEWED cron job present: ${name}"; unknown=$((unknown+1)); }
  done < <(awk '$1=="CRONJOB"{print $2}' "$inv")
  [[ "$unknown" -eq 0 ]] \
    || die "${unknown} cron job(s) are not in the reviewed inventory — a job may have been added at runtime (schedule_*_job); review it before quiescing"
  for n in HOOKTRIG OUTTRIG FDWSRV; do
    local v; v="$(awk -v k="$n" '$1==k{print $2}' "$inv")"
    [[ -n "$v" ]] || die "inventory is missing the ${n} count — refusing to proceed on an incomplete read"
    [[ "$v" -eq 0 ]] || die "${v} unclassified outbound mechanism(s) of type ${n} — a clone would fire them; classify before cloning"
  done
  ok "inventory reviewed: $(awk '$1=="CRONJOB"{n++} END{print n+0}' "$inv") cron job(s), all known; no webhooks/outbound triggers/FDWs"
}

cmd_clone_source_inventory() {   # READ-ONLY; safe to run against production
  local url="${1:-}"; require_arg "$url" "usage: clone-source-inventory <prod_conn_url>"
  require_cmd psql; assert_conn_url_is_ref "$EXPECTED_REF" "$url"
  mkdir -p "$EVID"
  local inv="$EVID/clone-source-inventory.txt"
  read_source_inventory "$url" "$inv"
  assert_inventory_is_reviewed "$inv"
  awk '$1=="CRONJOB"{printf "  %-38s active=%-5s outbound=%s\n",$2,$3,$4}
       $1=="RUNNING"{printf "  running cron executions: %s\n",$2}
       $1=="NETQUEUE"{printf "  pg_net queued requests : %s\n",$2}
       $1=="VAULTCOUNT"{printf "  vault secrets (count)  : %s\n",$2}
       $1=="OUTFN"{printf "  outbound-capable fn    : %s\n",$2}' "$inv" >&2
  ok "clone-source inventory complete (read-only, no commands/URLs/secrets displayed) -> ${inv##*/}"
}

# Pause every reviewed job, prove the source is inert, then record the PITR
# instant. Reversible by construction: cron.alter_job(active := false) only —
# NEVER cron.unschedule, which would destroy the schedule.
cmd_clone_source_quiesce() {
  require_yes "${1:-}"
  local url="${2:-}"; require_arg "$url" "usage: clone-source-quiesce --yes <prod_conn_url>"
  require_cmd psql; assert_conn_url_is_ref "$EXPECTED_REF" "$url"
  mkdir -p "$EVID"
  local inv="$EVID/clone-source-inventory.txt"
  read_source_inventory "$url" "$inv"
  assert_inventory_is_reviewed "$inv"

  # 1) capture the EXACT prior active state first: this manifest is the only way
  #    back, so it is written before anything is paused.
  psql "$url" -v ON_ERROR_STOP=1 -Atqc \
    "SELECT format('JOB\t%s\t%s\t%s', jobid, jobname, active) FROM cron.job ORDER BY jobid" > "$SRC_MANIFEST" \
    || die "could not capture the prior cron active-state manifest — nothing was paused"
  [[ -s "$SRC_MANIFEST" ]] || die "prior-state manifest is empty — refusing to pause without a way back"
  chmod 600 "$SRC_MANIFEST" 2>/dev/null || true
  ok "prior cron active-state manifest captured ($(wc -l < "$SRC_MANIFEST" | tr -d ' ') job(s))"

  # 2) pause. Any failure from here on MUST restore, never leave prod paused.
  local paused_ok=1
  psql "$url" -v ON_ERROR_STOP=1 -Atqc \
    "SELECT cron.alter_job(jobid, active := false) FROM cron.job WHERE active" >/dev/null || paused_ok=0
  if [[ "$paused_ok" -ne 1 ]]; then
    warn "pausing FAILED part-way — restoring the prior state now"
    clone_source_restore "$url" || warn "AUTOMATIC RESTORE ALSO FAILED — run 'clone-source-resume --yes <url>' IMMEDIATELY"
    die "clone-source quiesce aborted during pause (production state restored, or restore attempted and reported above)"
  fi

  # 3..5) prove inert: zero active, zero running, empty pg_net queue.
  local guard_rc=0
  quiesce_guards "$url" || guard_rc=$?
  if [[ "$guard_rc" -ne 0 ]]; then
    warn "the source did not reach a quiescent state — restoring production now"
    clone_source_restore "$url" || warn "AUTOMATIC RESTORE ALSO FAILED — run 'clone-source-resume --yes <url>' IMMEDIATELY"
    die "clone-source quiesce aborted (production state restored, or restore attempted and reported above)"
  fi

  # 6) only now is a snapshot instant meaningful
  local ts; ts="$(psql "$url" -v ON_ERROR_STOP=1 -Atqc "SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')")" \
    || { warn "could not read the snapshot instant — restoring"; clone_source_restore "$url" || true; die "quiesce aborted"; }
  printf '%s\n' "$ts" > "$EVID/clone-source-timestamp.txt"
  ok "SOURCE IS INERT. Approved PITR restore point (UTC): ${ts}"
  warn "PRODUCTION CRON IS NOW PAUSED. Take the PITR restore at/after that instant, then run:"
  warn "    run-rollout.sh clone-source-resume --yes <prod_conn_url>"
}

quiesce_guards() {   # $1 url ; 0 = inert
  local url="$1" n i
  n="$(psql "$url" -v ON_ERROR_STOP=1 -Atqc "SELECT count(*) FROM cron.job WHERE active")" || return 1
  [[ "$n" == 0 ]] || { warn "still ${n} ACTIVE cron job(s) after the pause"; return 1; }
  ok "every cron job is inactive"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    n="$(psql "$url" -v ON_ERROR_STOP=1 -Atqc "SELECT count(*) FROM cron.job_run_details WHERE status = 'running'")" || return 1
    [[ "$n" == 0 ]] && break
    log "waiting for ${n} running cron execution(s) to finish (${i}/10)"; sleep 15
  done
  [[ "$n" == 0 ]] || { warn "cron executions still running after the wait"; return 1; }
  ok "zero running cron executions"
  n="$(psql "$url" -v ON_ERROR_STOP=1 -Atqc "SELECT count(*) FROM net.http_request_queue")" || return 1
  [[ "$n" == 0 ]] || { warn "pg_net request queue is NOT empty (${n} queued) — a restore would fire them"; return 1; }
  ok "pg_net request queue is empty"
  return 0
}

# Restore EXACTLY the recorded prior active states, then verify each one.
clone_source_restore() {   # $1 url
  local url="$1" jobid name prior bad=0
  [[ -f "$SRC_MANIFEST" ]] || { warn "no prior-state manifest at $SRC_MANIFEST — cannot restore automatically"; return 1; }
  while IFS=$'\t' read -r tag jobid name prior; do
    [[ "$tag" == JOB ]] || continue
    psql "$url" -v ON_ERROR_STOP=1 -Atqc \
      "SELECT cron.alter_job(${jobid}, active := ${prior})" >/dev/null || { warn "restore FAILED for job ${name}"; bad=$((bad+1)); }
  done < "$SRC_MANIFEST"
  local drift
  drift="$(psql "$url" -v ON_ERROR_STOP=1 -Atqc \
    "SELECT count(*) FROM cron.job j JOIN (VALUES $(awk -F'\t' '$1=="JOB"{printf "%s(%s,%s)", sep, $2, $4; sep=","}' "$SRC_MANIFEST")) AS m(jobid, want) ON m.jobid = j.jobid WHERE j.active IS DISTINCT FROM m.want")" \
    || { warn "could not VERIFY the restored state"; return 1; }
  [[ "$drift" == 0 ]] || { warn "${drift} job(s) do not match their recorded prior state"; bad=$((bad+1)); }
  [[ "$bad" -eq 0 ]] || return 1
  ok "production cron restored to its exact recorded prior state and verified"
}

cmd_clone_source_resume() {
  require_yes "${1:-}"
  local url="${2:-}"; require_arg "$url" "usage: clone-source-resume --yes <prod_conn_url>"
  require_cmd psql; assert_conn_url_is_ref "$EXPECTED_REF" "$url"
  clone_source_restore "$url" || die "RESTORE FAILED — production cron may still be paused; investigate immediately"
}

# CLONE-SIDE GATE. No rehearsal command may touch a clone until this passes.
# CLONE_SOURCE_TS ties the clone to the approved inert snapshot: without it we
# cannot tell a quiesced restore from a live one.
assert_clone_isolated() {   # $1 = clone url
  local url="$1" approved
  [[ -f "$EVID/clone-source-timestamp.txt" ]] \
    || die "no approved inert-snapshot timestamp on file — run clone-source-quiesce first; a clone from a live snapshot would contact real customers"
  approved="$(cat "$EVID/clone-source-timestamp.txt")"
  require_env CLONE_SOURCE_TS "set CLONE_SOURCE_TS to the PITR instant this clone was restored from"
  [[ "$CLONE_SOURCE_TS" == "$approved" ]] \
    || die "CLONE_SOURCE_TS '${CLONE_SOURCE_TS}' != the approved inert snapshot '${approved}' — refusing: this clone may carry live cron state"
  run_artifact "$url" clone_isolation.sql
  ok "clone verified INERT and restored from the approved inert snapshot"
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
  clone-source-resume)    cmd_clone_source_resume "$@";;
  postflight)     cmd_postflight "$@";;
  ledger-status)  cmd_ledger_status "$@";;
  clean-evidence) cmd_clean_evidence "$@";;
  rollback615)    cmd_rollback615 "$@";;
  *) cat >&2 <<EOF
usage: EXPECTED_REF=<ref> $0 <subcommand> [args]
  check-identity [url] | phase616 --yes | dryrun615 | preflight <url> | apply615 --yes |
  resume615 --yes | postflight <url> | ledger-status <url> |
  rollback615 <url> [--clone] | clean-evidence --yes <url>
clone SAFETY (production, before any clone exists):
  clone-source-inventory <prod_url>          # READ-ONLY outbound inventory
  clone-source-quiesce --yes <prod_url>      # pause cron, prove inert, record the PITR instant
  clone-source-resume  --yes <prod_url>      # restore the exact prior cron state
clone-only (CLONE_REF=<ref> != EXPECTED_REF, CLONE_SOURCE_TS=<approved instant>, CAP_STMT=<ms>):
  clone-push --yes <clone_url>                 # push the MISSING suffix from PR615_SHA
  clone-make-prefix --yes <1|2> <clone_url>    # rehearsal C: real partial apply
  verify-clone <clone_url> --clone             # post-migration battery
EOF
     exit 2;;
esac
