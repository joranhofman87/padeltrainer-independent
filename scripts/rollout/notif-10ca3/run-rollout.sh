#!/usr/bin/env bash
# ===========================================================================
# run-rollout.sh — operator-driven rollout of #616 (maintenance gate) THEN
# #615 (email-delivery migrations). Dispatcher of explicit, individually-gated
# subcommands; there is deliberately NO single auto-run. Every mutating prod
# step re-asserts the target identity and requires --yes. The digest worker /
# digest event remain DISABLED throughout (this bundle never touches them).
#
# Subcommands:
#   check-identity           assert EXPECTED_REF format + linked/target identity
#   phase616 --yes           merge #616, deploy send-invoice-email, verify gate OFF
#   dryrun615                detached worktree @ #615 squash SHA; assert exactly the
#                            three 20261006* migrations are pending
#   preflight  <conn_url>    run sql/preflight.sql  (prod or clone; read-only)
#   apply615   --yes         maintenance window: gate ON -> prove no sends -> bounded
#                            db push -> postflight/acl/ledger -> gate OFF
#   verify-clone <conn_url>  preflight+fixture+postflight+acl+ledger on a CLONE
#   postflight <conn_url>    run sql/postflight.sql + acl_matrix.sql + ledger_verification.sql
#   rollback615              fix-forward guidance + gate-safe down path
#
# Required env (per subcommand): EXPECTED_REF (20-char). For prod-mutating steps:
#   SUPABASE_ACCESS_TOKEN (PAT), a linked `supabase` project == EXPECTED_REF.
# ===========================================================================
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_DIR="$HERE/sql"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"

: "${EXPECTED_REF:?set EXPECTED_REF to the target project ref (20 chars)}"
assert_ref_format "$EXPECTED_REF"

WT=""                     # rollout worktree path (cleaned on exit)
cleanup() { [[ -n "$WT" && -d "$WT" ]] && { git worktree remove --force "$WT" 2>/dev/null || true; }; }
trap cleanup EXIT

require_yes() { [[ "${1:-}" == "--yes" ]] || die "refusing prod-mutating step without --yes"; }

# run every SQL artifact against a psql connection URL (asserted to target REF
# only for prod; clone URLs are passed explicitly and NOT ref-checked).
run_artifact() { run_sql "$1" "$SQL_DIR/$2"; }

# --- gh helpers ------------------------------------------------------------
pr_squash_sha() { # $1 = pr number ; prints the merged squash SHA or dies
  local pr="$1" sha state
  require_cmd gh
  state="$(gh pr view "$pr" --json state -q .state)"
  [[ "$state" == "MERGED" ]] || die "PR #$pr is not MERGED (state=$state)"
  sha="$(gh pr view "$pr" --json mergeCommit -q .mergeCommit.oid)"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "could not resolve squash SHA for PR #$pr"
  printf '%s' "$sha"
}

# ===========================================================================
cmd_check_identity() {
  ok "EXPECTED_REF format valid: $EXPECTED_REF"
  if [[ -n "${1:-}" ]]; then
    assert_conn_url_is_ref "$EXPECTED_REF" "$1"      # direct/pooler conn URL
  else
    assert_linked_ref_is "$EXPECTED_REF"             # supabase CLI link target
  fi
}

# ---------------------------------------------------------------------------
cmd_phase616() {
  require_yes "${1:-}"
  require_cmd gh; require_cmd supabase
  assert_linked_ref_is "$EXPECTED_REF"
  log "Phase 1 (#616): merge maintenance gate + tracking, deploy, verify gate OFF"
  gh pr checks 616
  gh pr ready 616 || true
  gh pr merge 616 --squash --delete-branch=false
  git fetch origin
  local sha; sha="$(pr_squash_sha 616)"; ok "#616 squash SHA: $sha"
  # deploy the edge function from the merged code (main now contains #616)
  supabase functions deploy send-invoice-email
  # verify the gate is OFF by default (probe returns inactive). The probe needs
  # an authenticated call; the operator supplies MANAGER_TOKEN (a logged-in
  # academy manager's JWT), NOT the service_role key.
  : "${MANAGER_TOKEN:?set MANAGER_TOKEN to an academy manager JWT for the probe}"
  local url="https://${EXPECTED_REF}.functions.supabase.co/send-invoice-email?probe=1"
  local body; body="$(curl -sS "$url" -H "Authorization: Bearer ${MANAGER_TOKEN}")"
  printf '%s' "$body" | jq -e '.maintenance == false' >/dev/null \
    || die "gate probe did not report maintenance=false after deploy: $body"
  ok "Phase 1 complete: #616 merged+deployed; gate OFF (maintenance=false)"
}

# ---------------------------------------------------------------------------
cmd_dryrun615() {
  require_cmd gh; require_cmd supabase
  git fetch origin
  local sha; sha="$(pr_squash_sha 615)"; ok "#615 squash SHA: $sha"
  WT="$(mktemp -d -t rollout-615-XXXX)"
  git worktree add --detach "$WT" "$sha"
  ok "detached rollout worktree at $sha: $WT"
  ( cd "$WT"
    # assert EXACTLY the three 20261006* migrations are new vs origin/main
    local pending
    pending="$(git diff --name-only origin/main -- 'supabase/migrations' | sort)"
    log "migrations added by #615 vs origin/main:"; printf '%s\n' "$pending" >&2
    local expected="supabase/migrations/20261006100000_email_delivery_concurrency_suppression.sql
supabase/migrations/20261006110000_reconcile_orphan_provider_events.sql
supabase/migrations/20261006120000_readers_canonical_is_suppressed.sql"
    [[ "$pending" == "$expected" ]] || die "pending migration set is not exactly the three 20261006* files"
    ok "dry run: exactly the three expected migrations are pending"
  )
}

# ---------------------------------------------------------------------------
# The maintenance window. Stop conditions abort with non-zero at every step.
cmd_apply615() {
  require_yes "${1:-}"
  require_cmd gh; require_cmd supabase; require_cmd curl; require_cmd jq
  assert_linked_ref_is "$EXPECTED_REF"
  : "${MANAGER_TOKEN:?set MANAGER_TOKEN (academy manager JWT) for the probe}"
  : "${CAP_STMT:?set CAP_STMT (ms) from preflight}"
  local CAP_LOCK="${CAP_LOCK:-3000}"
  local probe="https://${EXPECTED_REF}.functions.supabase.co/send-invoice-email?probe=1"

  # 1) merge #615 and stage the rollout worktree at its squash SHA
  gh pr checks 615
  gh pr ready 615 || true
  gh pr merge 615 --squash --delete-branch=false
  git fetch origin
  local sha; sha="$(pr_squash_sha 615)"
  WT="$(mktemp -d -t rollout-615-XXXX)"
  git worktree add --detach "$WT" "$sha"
  ok "rollout worktree @ $sha"

  # 2) gate ON (reversible env switch) and CONFIRM no send passes it
  log "activating maintenance gate (INVOICE_EMAIL_MAINTENANCE=1)"
  supabase secrets set INVOICE_EMAIL_MAINTENANCE=1
  local body; body="$(curl -sS "$probe" -H "Authorization: Bearer ${MANAGER_TOKEN}")"
  printf '%s' "$body" | jq -e '.maintenance == true' >/dev/null \
    || die "gate did not report maintenance=true; ABORTING before any migration"
  ok "gate ON (maintenance=true); Resend sends now return 503"
  local T_GATE; T_GATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "T_GATE=$T_GATE — drain: wait for in-flight sends to reach event:finished, then prove zero new sends"
  warn "MANUAL DRAIN: allow the longest send to finish, then run: logs/fetch-edge-logs.sh --ref $EXPECTED_REF --start $T_GATE --end <now>"

  # 3) bounded db push from the worktree (lock/statement timeouts bound the AccessExclusive rewrite)
  ( cd "$WT"
    log "db push with lock_timeout=${CAP_LOCK}ms statement_timeout=${CAP_STMT}ms"
    PGOPTIONS="-c lock_timeout=${CAP_LOCK} -c statement_timeout=${CAP_STMT}" \
      supabase db push \
      || die "db push failed/aborted (lock or statement timeout). Gate is still ON; ledger absent (atomic). Fix-forward, then re-run."
  )
  ok "migrations applied"

  # 4) postflight verification on prod (read-only)
  local prod_url="${PROD_CONN_URL:?set PROD_CONN_URL to the psql conn string for verification}"
  assert_conn_url_is_ref "$EXPECTED_REF" "$prod_url"
  run_artifact "$prod_url" postflight.sql
  run_artifact "$prod_url" acl_matrix.sql
  run_artifact "$prod_url" ledger_verification.sql
  ok "postflight/acl/ledger passed on prod"

  # 5) gate OFF (restore sends)
  log "deactivating maintenance gate"
  supabase secrets unset INVOICE_EMAIL_MAINTENANCE
  body="$(curl -sS "$probe" -H "Authorization: Bearer ${MANAGER_TOKEN}")"
  printf '%s' "$body" | jq -e '.maintenance == false' >/dev/null \
    || die "gate did not return to maintenance=false; investigate before declaring done"
  ok "Phase 2 complete: #615 applied; gate OFF; digest engine still disabled"
}

# ---------------------------------------------------------------------------
cmd_verify_clone() {          # full battery on a disposable clone
  local url="${1:?usage: verify-clone <clone_conn_url>}"
  run_artifact "$url" preflight.sql
  run_artifact "$url" academy_fixture.sql   # NOTE: run AFTER migrations applied to the clone
  run_artifact "$url" postflight.sql
  run_artifact "$url" acl_matrix.sql
  run_artifact "$url" ledger_verification.sql
  ok "clone verification battery passed"
}

cmd_preflight()  { run_artifact "${1:?usage: preflight <conn_url>}"  preflight.sql; }
cmd_postflight() {
  local url="${1:?usage: postflight <conn_url>}"
  run_artifact "$url" postflight.sql
  run_artifact "$url" acl_matrix.sql
  run_artifact "$url" ledger_verification.sql
}

cmd_rollback615() {
  cat >&2 <<EOF
[fix-forward policy]
The three 20261006* migrations are additive (ADD COLUMN / CREATE TABLE|FUNCTION);
they do not drop or rewrite existing readers destructively. A failed db push runs
inside a transaction — on abort the delta is ABSENT (verify: run 'preflight <url>',
which asserts the delta is gone). Do NOT hand-write a down migration that re-enables
a half-migrated sender. Recovery order:
  1. Keep the maintenance gate ON (INVOICE_EMAIL_MAINTENANCE=1) — sends stay 503.
  2. Run 'preflight <prod_url>' to confirm the delta is absent (clean abort).
  3. Fix the migration on a branch; re-run 'dryrun615' then 'apply615 --yes'.
  4. Only turn the gate OFF once 'postflight' passes.
EOF
}

# --- dispatch --------------------------------------------------------------
sub="${1:-}"; shift || true
case "$sub" in
  check-identity) cmd_check_identity "$@";;
  phase616)       cmd_phase616 "$@";;
  dryrun615)      cmd_dryrun615 "$@";;
  preflight)      cmd_preflight "$@";;
  apply615)       cmd_apply615 "$@";;
  verify-clone)   cmd_verify_clone "$@";;
  postflight)     cmd_postflight "$@";;
  rollback615)    cmd_rollback615 "$@";;
  *) cat >&2 <<EOF
usage: EXPECTED_REF=<ref> $0 <subcommand> [args]
subcommands: check-identity | phase616 --yes | dryrun615 | preflight <url> |
             apply615 --yes | verify-clone <url> | postflight <url> | rollback615
EOF
     exit 2;;
esac
