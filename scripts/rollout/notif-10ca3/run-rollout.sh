#!/usr/bin/env bash
# ===========================================================================
# run-rollout.sh — operator-driven rollout of #616 (maintenance gate) THEN
# #615 (email-delivery migrations). Dispatcher of explicit, individually-gated
# subcommands; there is deliberately NO single auto-run. Every prod-mutating
# step re-asserts the target identity and requires --yes. The digest worker /
# digest event remain DISABLED throughout (this bundle never touches them).
#
# Key safety properties (mutation-tested by verify/guard-mutation-test.sh):
#   * #616 and #615 deploy/push from a DETACHED WORKTREE at the verified merge/
#     head SHA (never the ambient checkout), identity-validated inside it.
#   * #615 uses a real `supabase db push --dry-run` and asserts the pending set
#     is EXACTLY the three 20261006* versions.
#   * apply615 CANNOT reach `db push` without a successful authoritative drain
#     proof (elapsed >= MIN_DRAIN and zero sends past the gate and no straggler).
#   * recovery handles none / prefix / all migration-ledger states.
#
# Subcommands:
#   check-identity [url]     assert EXPECTED_REF format + linked/target identity
#   phase616 --yes           merge #616, deploy from its merge-SHA worktree, verify gate OFF
#   dryrun615                worktree @ #615 PRE-MERGE head SHA; real db push --dry-run;
#                            assert exactly the three 20261006* versions pending
#   preflight  <url>         run sql/preflight.sql (read-only)
#   apply615   --yes         maintenance window: gate ON -> AUTHORITATIVE DRAIN PROOF ->
#                            dry-run==3 -> bounded db push -> baseline+postflight -> gate OFF
#   verify-clone <url>       preflight+fixture+postflight+acl+ledger on a CLONE
#   postflight <url>         postflight.sql + acl_matrix.sql + ledger_verification.sql
#   ledger-status <url>      report none/prefix/all for the three versions
#   rollback615 <url>        recovery matrix (none/prefix/all)
#
# Required env: EXPECTED_REF (20-char). Prod-mutating steps also need
#   SUPABASE_ACCESS_TOKEN (PAT), SUPABASE_DB_PASSWORD, MANAGER_TOKEN.
# ===========================================================================
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_DIR="$HERE/sql"; EVID="$HERE/evidence"
# shellcheck source=lib/common.sh
source "$HERE/lib/common.sh"

: "${EXPECTED_REF:?set EXPECTED_REF to the target project ref (20 chars)}"
assert_ref_format "$EXPECTED_REF"

# the three versions this rollout applies, in order
V1=20261006100000; V2=20261006110000; V3=20261006120000
EXPECTED_VERSIONS="$(printf '%s\n%s\n%s\n' "$V1" "$V2" "$V3")"

WT=""
cleanup() { [[ -n "$WT" && -d "$WT" ]] && { git worktree remove --force "$WT" 2>/dev/null || true; }; }
trap cleanup EXIT
require_yes() { [[ "${1:-}" == "--yes" ]] || die "refusing prod-mutating step without --yes"; }
run_artifact() { run_sql "$1" "$SQL_DIR/$2"; }

# --- gh / worktree ---------------------------------------------------------
pr_merge_sha() { local pr="$1" s st; require_cmd gh
  st="$(gh pr view "$pr" --json state -q .state)"; [[ "$st" == "MERGED" ]] || die "PR #$pr not MERGED (state=$st)"
  s="$(gh pr view "$pr" --json mergeCommit -q .mergeCommit.oid)"; [[ "$s" =~ ^[0-9a-f]{40}$ ]] || die "no merge SHA for #$pr"
  printf '%s' "$s"; }
pr_head_sha() { local pr="$1" s; require_cmd gh
  s="$(gh pr view "$pr" --json headRefOid -q .headRefOid)"; [[ "$s" =~ ^[0-9a-f]{40}$ ]] || die "no head SHA for #$pr"
  printf '%s' "$s"; }

# create a detached worktree at $1 and identity-validate it. The linked target
# is fixed via SUPABASE_PROJECT_ID (set by callers) — precedence beats the
# absent .temp/project-ref — and the worktree's own config is asserted to match.
mk_worktree() {
  local sha="$1"
  git cat-file -e "${sha}^{commit}" 2>/dev/null || die "commit $sha not present locally (git fetch first)"
  WT="$(mktemp -d -t rollout-wt-XXXX)"
  git worktree add --detach "$WT" "$sha" >&2
  ( cd "$WT" && assert_config_project_ref_is "$EXPECTED_REF" )
  ok "rollout worktree @ ${sha:0:12} identity-validated"
}

# parse `supabase db push --dry-run` pending versions (bullets on stderr)
push_dry_run_pending() {                       # run inside the worktree
  NO_COLOR=1 supabase db push --linked --dry-run 2>&1 1>/dev/null \
    | sed -n 's/.*[[:space:]]\([0-9]\{14\}\)_[A-Za-z0-9_]*\.sql.*/\1/p' | sort -u
}

# --- drain proof (authoritative, blocking) ---------------------------------
prove_drain() {
  local t_gate="$1" min="${MIN_DRAIN_SECONDS:-120}"
  : "${SUPABASE_ACCESS_TOKEN:?PAT required for the drain proof}"
  local g_epoch now_epoch elapsed nowiso lookback
  g_epoch="$(iso_to_epoch "$t_gate")"
  log "draining >= ${min}s (waiting for in-flight sends to finish) before any migration"
  while :; do now_epoch="$(date -u +%s)"; elapsed=$(( now_epoch - g_epoch )); [[ "$elapsed" -ge "$min" ]] && break; sleep 10; done
  nowiso="$(now_iso)"; lookback="$(epoch_to_iso $(( g_epoch - min )))"
  # (1) no gate bypass: ZERO provider_send_started in [t_gate, now]
  "$HERE/logfetch/fetch-edge-logs.sh" --ref "$EXPECTED_REF" --start "$t_gate" --end "$nowiso" \
    || die "DRAIN PROOF FAILED: a send passed the gate in [$t_gate,$nowiso] — NOT pushing"
  # (2) no straggler: every send started in [t_gate-min, now] reached event:finished
  "$HERE/logfetch/fetch-edge-logs.sh" --ref "$EXPECTED_REF" --start "$lookback" --end "$nowiso" --allow-sends --assert-all-finished \
    || die "DRAIN PROOF FAILED: in-flight send(s) not finished in [$lookback,$nowiso] — NOT pushing"
  assert_drain_proven "$elapsed" "$min" 0
}

# --- baseline capture + compare --------------------------------------------
capture_baseline() { # $1 url  $2 tag
  local url="$1" tag="$2"
  require_cmd psql
  psql "$url" --no-psqlrc -q -f "$SQL_DIR/baseline.sql" > "$EVID/baseline-${tag}.txt" \
    || die "baseline capture ($tag) failed"
  ok "baseline captured: $EVID/baseline-${tag}.txt"
}
compare_baseline() {
  local pre="$EVID/baseline-pre.txt" post="$EVID/baseline-post.txt" k vpre vpost
  [[ -f "$pre" && -f "$post" ]] || die "missing baseline files to compare"
  for k in eas_rows ede_rows; do                       # MUST be preserved
    vpre="$(sed -n "s/^${k}=//p" "$pre")"; vpost="$(sed -n "s/^${k}=//p" "$post")"
    [[ "$vpre" == "$vpost" ]] || die "baseline PRESERVE violated: $k $vpre -> $vpost (migration lost rows)"
    ok "baseline preserved: $k = $vpre"
  done
  for k in reader_academy_md5 reader_overview_md5; do   # MUST change (re-emit)
    vpre="$(sed -n "s/^${k}=//p" "$pre")"; vpost="$(sed -n "s/^${k}=//p" "$post")"
    [[ "$vpre" != "$vpost" ]] || die "baseline CHANGE expected: $k unchanged (reader not re-emitted)"
    ok "baseline changed as expected: $k"
  done
}

# --- migration ledger state (none/prefix/all) ------------------------------
ledger_status() { # $1 url ; echoes none | all | prefix:<csv>
  local url="$1" applied n
  require_cmd psql
  applied="$(psql "$url" -Atqc \
    "SELECT coalesce(string_agg(version,','),'') FROM supabase_migrations.schema_migrations
     WHERE version IN ('$V1','$V2','$V3')" 2>/dev/null || echo "")"
  n="$(printf '%s' "$applied" | tr ',' '\n' | sed '/^[[:space:]]*$/d' | grep -c . || true)"
  case "$n" in 0) echo none;; 3) echo all;; *) echo "prefix:$applied";; esac
}

# ===========================================================================
cmd_check_identity() {
  ok "EXPECTED_REF format valid: $EXPECTED_REF"
  if [[ -n "${1:-}" ]]; then assert_conn_url_is_ref "$EXPECTED_REF" "$1"; else assert_linked_ref_is "$EXPECTED_REF"; fi
}

cmd_phase616() {
  require_yes "${1:-}"; require_cmd gh; require_cmd supabase; require_cmd curl; require_cmd jq
  : "${MANAGER_TOKEN:?set MANAGER_TOKEN (academy manager JWT) for the probe}"
  log "Phase 1 (#616): merge gate+tracking, deploy from merge-SHA worktree, verify gate OFF"
  gh pr checks 616; gh pr ready 616 || true; gh pr merge 616 --squash --delete-branch=false
  git fetch origin
  local sha; sha="$(pr_merge_sha 616)"
  mk_worktree "$sha"
  ( cd "$WT"; export SUPABASE_PROJECT_ID="$EXPECTED_REF"
    supabase functions deploy send-invoice-email )
  local probe="https://${EXPECTED_REF}.functions.supabase.co/send-invoice-email?probe=1" body
  body="$(curl -sS "$probe" -H "Authorization: Bearer ${MANAGER_TOKEN}")"
  printf '%s' "$body" | jq -e '.maintenance == false' >/dev/null || die "gate not maintenance=false after deploy: $body"
  ok "Phase 1 complete: #616 merged, deployed from ${sha:0:12}; gate OFF"
}

cmd_dryrun615() {
  require_cmd gh; require_cmd supabase
  git fetch origin
  local sha; sha="$(pr_head_sha 615)"; ok "#615 PRE-MERGE head SHA: ${sha:0:12}"
  mk_worktree "$sha"
  ( cd "$WT"; export SUPABASE_PROJECT_ID="$EXPECTED_REF"
    : "${SUPABASE_DB_PASSWORD:?set SUPABASE_DB_PASSWORD for the dry-run connection}"
    local pending; pending="$(push_dry_run_pending)"
    log "db push --dry-run pending versions:"; printf '%s\n' "$pending" >&2
    assert_pending_is_expected "$pending" "$EXPECTED_VERSIONS" )
  ok "dry run verified: exactly $V1,$V2,$V3 pending"
}

cmd_apply615() {
  require_yes "${1:-}"; require_cmd gh; require_cmd supabase; require_cmd curl; require_cmd jq; require_cmd psql
  : "${MANAGER_TOKEN:?set MANAGER_TOKEN}"; : "${CAP_STMT:?set CAP_STMT (ms) from preflight}"
  : "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN (PAT)}"; : "${SUPABASE_DB_PASSWORD:?set SUPABASE_DB_PASSWORD}"
  local CAP_LOCK="${CAP_LOCK:-3000}"
  local prod="${PROD_CONN_URL:?set PROD_CONN_URL (psql) for verification}"
  assert_conn_url_is_ref "$EXPECTED_REF" "$prod"
  local probe="https://${EXPECTED_REF}.functions.supabase.co/send-invoice-email?probe=1"

  # 1) merge #615, stage worktree at its merge SHA, dry-run assert three (pre-gate)
  gh pr checks 615; gh pr ready 615 || true; gh pr merge 615 --squash --delete-branch=false
  git fetch origin
  local sha; sha="$(pr_merge_sha 615)"; mk_worktree "$sha"
  ( cd "$WT"; export SUPABASE_PROJECT_ID="$EXPECTED_REF"
    assert_pending_is_expected "$(push_dry_run_pending)" "$EXPECTED_VERSIONS" )

  # 2) baseline (pre) + gate ON + verify
  capture_baseline "$prod" pre
  log "activating maintenance gate (INVOICE_EMAIL_MAINTENANCE=1)"
  supabase secrets set INVOICE_EMAIL_MAINTENANCE=1
  local body; body="$(curl -sS "$probe" -H "Authorization: Bearer ${MANAGER_TOKEN}")"
  printf '%s' "$body" | jq -e '.maintenance == true' >/dev/null || die "gate not maintenance=true; ABORT before migration"
  local T_GATE; T_GATE="$(now_iso)"; ok "gate ON at $T_GATE; sends now 503"

  # 3) AUTHORITATIVE DRAIN PROOF — the push cannot be reached without this
  prove_drain "$T_GATE"

  # 4) re-assert exactly three pending, then bounded db push from the worktree
  ( cd "$WT"; export SUPABASE_PROJECT_ID="$EXPECTED_REF"
    assert_pending_is_expected "$(push_dry_run_pending)" "$EXPECTED_VERSIONS"
    log "db push (lock_timeout=${CAP_LOCK}ms statement_timeout=${CAP_STMT}ms)"
    PGOPTIONS="-c lock_timeout=${CAP_LOCK} -c statement_timeout=${CAP_STMT}" \
      supabase db push --linked --yes ) || {
        local st; st="$(ledger_status "$prod")"
        die "db push failed. ledger state = ${st}. Gate stays ON. Run 'rollback615 $prod' for the recovery matrix."
      }
  local st; st="$(ledger_status "$prod")"
  [[ "$st" == "all" ]] || die "post-push ledger is '$st', expected 'all'. Gate stays ON; run rollback615."
  ok "all three migrations recorded in the ledger"

  # 5) verification + baseline compare
  run_artifact "$prod" postflight.sql
  run_artifact "$prod" acl_matrix.sql
  run_artifact "$prod" ledger_verification.sql
  capture_baseline "$prod" post
  compare_baseline

  # 6) gate OFF
  log "deactivating maintenance gate"
  supabase secrets unset INVOICE_EMAIL_MAINTENANCE
  body="$(curl -sS "$probe" -H "Authorization: Bearer ${MANAGER_TOKEN}")"
  printf '%s' "$body" | jq -e '.maintenance == false' >/dev/null || die "gate not back to maintenance=false; investigate"
  ok "Phase 2 complete: #615 applied; gate OFF; digest engine still disabled"
}

cmd_verify_clone() {
  local url="${1:?usage: verify-clone <clone_conn_url>}"
  run_artifact "$url" preflight.sql
  run_artifact "$url" academy_fixture.sql
  run_artifact "$url" postflight.sql
  run_artifact "$url" acl_matrix.sql
  run_artifact "$url" ledger_verification.sql
  ok "clone verification battery passed"
}
cmd_preflight()  { run_artifact "${1:?usage: preflight <conn_url>}"  preflight.sql; }
cmd_postflight() { local url="${1:?usage: postflight <conn_url>}"
  run_artifact "$url" postflight.sql; run_artifact "$url" acl_matrix.sql; run_artifact "$url" ledger_verification.sql; }
cmd_ledger_status() { local url="${1:?usage: ledger-status <conn_url>}"; echo "ledger state: $(ledger_status "$url")"; }

cmd_rollback615() {
  local url="${1:?usage: rollback615 <conn_url>}" st; st="$(ledger_status "$url")"
  cat >&2 <<EOF
[recovery] migration-ledger state = ${st}

The three 20261006* migrations are additive (ADD COLUMN / CREATE TABLE|FUNCTION,
all transactional — no CONCURRENTLY / explicit BEGIN), so \`supabase db push\`
applies each file in its own transaction and records it in
supabase_migrations.schema_migrations only on success (PREFIX possible).

  none    -> clean abort, nothing applied. Fix the migration; re-run dryrun615
             then apply615 --yes. Keep the gate ON meanwhile.
  prefix  -> some files applied+recorded, a later file failed. Do NOT hand-write
             a down migration. Fix the failing file; re-run apply615 (db push
             resumes from the first un-recorded version). Keep the gate ON;
             verify with 'ledger-status $url' until it reads 'all'.
  all     -> every file applied. Run 'postflight $url'; if it passes, the gate
             may be turned OFF. If postflight fails, investigate before OFF.

Never turn the maintenance gate OFF until 'postflight $url' passes.
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
  ledger-status)  cmd_ledger_status "$@";;
  rollback615)    cmd_rollback615 "$@";;
  *) cat >&2 <<EOF
usage: EXPECTED_REF=<ref> $0 <subcommand> [args]
  check-identity [url] | phase616 --yes | dryrun615 | preflight <url> |
  apply615 --yes | verify-clone <url> | postflight <url> | ledger-status <url> | rollback615 <url>
EOF
     exit 2;;
esac
