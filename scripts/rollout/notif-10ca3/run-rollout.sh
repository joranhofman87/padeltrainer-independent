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
#   preflight <url> | apply615 --yes | verify-clone <url> | postflight <url> |
#   ledger-status <url> | rollback615 <url>
#
# Env: EXPECTED_REF. Prod steps also need SUPABASE_ACCESS_TOKEN (PAT),
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

: "${EXPECTED_REF:?set EXPECTED_REF to the target project ref (20 chars)}"
assert_ref_format "$EXPECTED_REF"
[[ "${PR615_SHA:-}" =~ ^[0-9a-f]{40}$ && "${PR616_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || die "PINS.env missing valid PR615_SHA/PR616_SHA"
MIN_DRAIN_SECONDS="${MIN_DRAIN_SECONDS:-$ROLLOUT_DRAIN_FLOOR}"

V1=20261006100000; V2=20261006110000; V3=20261006120000
EXPECTED_VERSIONS="$(printf '%s\n%s\n%s\n' "$V1" "$V2" "$V3")"

WT=""
# NB: must return 0 — an EXIT trap whose last command is non-zero overrides the
# script's exit status, which would make a successful no-worktree path (e.g.
# resume615 on an already-'all' ledger) exit non-zero.
cleanup() { [[ -n "$WT" && -d "$WT" ]] && git worktree remove --force "$WT" 2>/dev/null; return 0; }
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
push_dry_run_pending() {   # inside worktree; parse the CLI bullets
  NO_COLOR=1 supabase db push --linked --dry-run 2>&1 1>/dev/null \
    | sed -n 's/.*[[:space:]]\([0-9]\{14\}\)_[A-Za-z0-9_]*\.sql.*/\1/p' | sort -u
}

# --- authoritative, blocking drain proof -----------------------------------
prove_drain() {
  local t_gate="$1" min="$MIN_DRAIN_SECONDS"
  : "${SUPABASE_ACCESS_TOKEN:?PAT required}"; : "${MANAGER_TOKEN:?manager JWT required}"
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
  # 2) wait out the drain window (covers the 400s hosted-function wall). The
  #    floor is still enforced (assert_drain_window above); ROLLOUT_TEST_FAST_DRAIN
  #    skips ONLY the wall-clock sleep for the stubbed operator-flow test — never
  #    the proof below. It is never set in production.
  local g_epoch now_epoch elapsed
  g_epoch="$(iso_to_epoch "$t_gate")"
  if [[ "${ROLLOUT_TEST_FAST_DRAIN:-}" == 1 ]]; then
    elapsed="$min"; log "TEST fast-drain: wall-clock wait skipped (proof still enforced)"
  else
    log "draining >= ${min}s before any migration"
    while :; do now_epoch="$(date -u +%s)"; elapsed=$((now_epoch - g_epoch)); [[ "$elapsed" -ge "$min" ]] && break; sleep 15; done
  fi
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
      4) log "canary evidence not ingested yet — retry $attempt/6"; [[ "${ROLLOUT_TEST_FAST_DRAIN:-}" == 1 ]] || sleep 15;;
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
# ROLLOUT_SALT (a per-run secret) is set by apply615 and persisted to
# evidence/manifest-salt.txt so resume615 can reuse the ORIGINAL manifest.
capture_manifest() {
  local url="$1" tag="$2"; local out="$EVID/manifest-${tag}.txt"; require_cmd psql
  : "${ROLLOUT_SALT:?internal: manifest salt not set}"
  psql "$url" -v ON_ERROR_STOP=1 -v salt="$ROLLOUT_SALT" --no-psqlrc -q -f "$SQL_DIR/manifest.sql" > "$out" \
    || die "manifest capture ($tag) failed"
  validate_manifest "$out" "$tag"; ok "manifest captured + validated: $out"
}

# Resolve the commit to build a recovery worktree from. Default = the reviewed
# pin. A DIFFERING recovery requires a fully-reviewed, MERGED RECOVERY_PR whose
# head equals RECOVERY_SHA and whose checks are green; we then deploy from its
# verified MERGE commit. Arbitrary local commits are rejected.
resolve_recovery_sha() {
  if [[ -z "${RECOVERY_PR:-}" && -z "${RECOVERY_SHA:-}" ]]; then printf '%s' "$PR615_SHA"; return 0; fi
  require_cmd gh
  : "${RECOVERY_PR:?a differing recovery requires RECOVERY_PR (the reviewed PR number)}"
  : "${RECOVERY_SHA:?a differing recovery requires RECOVERY_SHA (the reviewed head SHA)}"
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
  : "${MANAGER_TOKEN:?set MANAGER_TOKEN (academy manager JWT)}"
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
  ( cd "$WT"; export SUPABASE_PROJECT_ID="$EXPECTED_REF"
    : "${SUPABASE_DB_PASSWORD:?set SUPABASE_DB_PASSWORD for the dry-run connection}"
    local pending; pending="$(push_dry_run_pending)"
    log "db push --dry-run pending:"; printf '%s\n' "$pending" >&2
    assert_pending_is_expected "$pending" "$EXPECTED_VERSIONS" )
  ok "dry run verified: exactly $V1,$V2,$V3 pending"
}

cmd_apply615() {
  require_yes "${1:-}"; require_cmd gh; require_cmd supabase; require_cmd curl; require_cmd jq; require_cmd psql
  : "${MANAGER_TOKEN:?}"; : "${CAP_STMT:?set CAP_STMT (ms) from preflight}"
  : "${SUPABASE_ACCESS_TOKEN:?}"; : "${SUPABASE_DB_PASSWORD:?}"
  local CAP_LOCK="${CAP_LOCK:-3000}" prod="${PROD_CONN_URL:?set PROD_CONN_URL (password via PGPASSWORD)}"
  assert_conn_url_is_ref "$EXPECTED_REF" "$prod"
  local probe="https://${EXPECTED_REF}.functions.supabase.co/send-invoice-email?probe=1"

  git fetch origin
  assert_sha_matches_pin "$(pr_head_sha 615)" "$PR615_SHA" "#615 head"
  gh pr checks 615; gh pr ready 615 || true
  gh pr merge 615 --squash --match-head-commit "$PR615_SHA" --delete-branch=false
  git fetch origin
  mk_worktree "$(pr_merge_sha 615)"
  ( cd "$WT"; export SUPABASE_PROJECT_ID="$EXPECTED_REF"
    assert_pending_is_expected "$(push_dry_run_pending)" "$EXPECTED_VERSIONS" )

  log "activating maintenance gate"
  supabase secrets set INVOICE_EMAIL_MAINTENANCE=1 --project-ref "$EXPECTED_REF"
  local body; body="$(curl -sS "$probe" -H "Authorization: Bearer ${MANAGER_TOKEN}")"
  printf '%s' "$body" | jq -e '.maintenance == true' >/dev/null || die "gate not maintenance=true; ABORT"
  local T_GATE; T_GATE="$(now_iso)"; ok "gate ON at $T_GATE"

  prove_drain "$T_GATE"       # cannot reach db push without this

  # capture the pre-migration manifest AFTER the drain (reflects the gated,
  # drained state); a fresh per-run salt is persisted so resume615 can reuse it.
  ROLLOUT_SALT="$(gen_salt)"; printf '%s' "$ROLLOUT_SALT" > "$EVID/manifest-salt.txt"
  capture_manifest "$prod" pre

  ( cd "$WT"; export SUPABASE_PROJECT_ID="$EXPECTED_REF"
    assert_pending_is_expected "$(push_dry_run_pending)" "$EXPECTED_VERSIONS"
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

cmd_verify_clone() { local url="${1:?usage: verify-clone <clone_conn_url>}"
  run_artifact "$url" preflight.sql; run_artifact "$url" academy_fixture.sql
  run_artifact "$url" postflight.sql; run_artifact "$url" acl_matrix.sql; run_artifact "$url" ledger_verification.sql
  ok "clone verification battery passed"; }
cmd_preflight()  { run_artifact "${1:?usage: preflight <conn_url>}"  preflight.sql; }
cmd_postflight() { local url="${1:?usage: postflight <conn_url>}"
  run_artifact "$url" postflight.sql; run_artifact "$url" acl_matrix.sql; run_artifact "$url" ledger_verification.sql; }
cmd_ledger_status() { local url="${1:?usage: ledger-status <conn_url>}"; echo "ledger state: $(ledger_status "$url")"; }

cmd_rollback615() {
  local url="${1:?usage: rollback615 <conn_url>}" st; st="$(ledger_status "$url")"
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
  : "${MANAGER_TOKEN:?}"; : "${CAP_STMT:?set CAP_STMT (ms)}"; : "${SUPABASE_DB_PASSWORD:?}"; : "${SUPABASE_ACCESS_TOKEN:?}"
  local CAP_LOCK="${CAP_LOCK:-3000}" prod="${PROD_CONN_URL:?set PROD_CONN_URL (password via PGPASSWORD)}"
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
      ( cd "$WT"; export SUPABASE_PROJECT_ID="$EXPECTED_REF"
        assert_pending_is_expected "$(push_dry_run_pending)" "$suffix"
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
  postflight)     cmd_postflight "$@";;
  ledger-status)  cmd_ledger_status "$@";;
  rollback615)    cmd_rollback615 "$@";;
  *) cat >&2 <<EOF
usage: EXPECTED_REF=<ref> $0 <subcommand> [args]
  check-identity [url] | phase616 --yes | dryrun615 | preflight <url> | apply615 --yes |
  resume615 --yes | verify-clone <url> | postflight <url> | ledger-status <url> | rollback615 <url>
EOF
     exit 2;;
esac
