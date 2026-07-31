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
SQL_DIR="$HERE/sql"; EVID="$HERE/evidence"
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
cleanup() { [[ -n "$WT" && -d "$WT" ]] && { git worktree remove --force "$WT" 2>/dev/null || true; }; }
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
  local fn="https://${EXPECTED_REF}.functions.supabase.co/send-invoice-email" code
  # 1) safe authenticated NON-probe canary MUST 503 (proves the gate is active + emits event:blocked)
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$fn" \
    -H "Authorization: Bearer ${MANAGER_TOKEN}" -H 'Content-Type: application/json' \
    --data "{\"invoiceId\":\"canary-$(now_iso)\",\"previewOnly\":true}")" || die "canary request failed"
  [[ "$code" == 503 ]] || die "canary did not return 503 (gate not active? http=$code)"
  ok "canary returned 503 — gate active"
  # 2) wait out the drain window (covers the 400s function wall)
  local g_epoch now_epoch elapsed
  g_epoch="$(iso_to_epoch "$t_gate")"
  log "draining >= ${min}s before any migration"
  while :; do now_epoch="$(date -u +%s)"; elapsed=$((now_epoch - g_epoch)); [[ "$elapsed" -ge "$min" ]] && break; sleep 15; done
  # windows padded ±60s for the analytics minute-rounding
  local wA_start wB_start w_end rc attempt
  wA_start="$t_gate"; wB_start="$(epoch_to_iso $(( g_epoch - min - 60 )))"
  # 3) ingestion evidence + zero-send in [t_gate, now]; retry ingestion lag (4), abort on bypass (3)
  for attempt in 1 2 3 4 5 6; do
    w_end="$(epoch_to_iso $(( $(date -u +%s) + 60 )))"; rc=0
    "$HERE/logfetch/fetch-edge-logs.sh" --ref "$EXPECTED_REF" --start "$wA_start" --end "$w_end" --require-blocked || rc=$?
    case "$rc" in
      0) break;;
      4) log "ingestion lag (no event:blocked yet) — retry $attempt/6"; sleep 15;;
      3) die "DRAIN PROOF FAILED: gate BYPASS in [$wA_start,$w_end]";;
      *) die "drain fetch failed (rc=$rc)";;
    esac
  done
  [[ "$rc" == 0 ]] || die "DRAIN PROOF FAILED: no ingestion evidence (event:blocked) after retries"
  # 4) no straggler + no record_failed over [t_gate-min-60, now]
  rc=0
  "$HERE/logfetch/fetch-edge-logs.sh" --ref "$EXPECTED_REF" --start "$wB_start" --end "$w_end" \
    --allow-sends --assert-all-finished --fail-on-record-failed || rc=$?
  [[ "$rc" == 0 ]] || die "DRAIN PROOF FAILED: straggler/record_failed in [$wB_start,$w_end] (rc=$rc)"
  assert_drain_proven "$elapsed" "$min" 0
}

# --- baselines (fail-closed; validate_baseline_keys lives in common.sh) -----
capture_baseline() {
  local url="$1" tag="$2" out="$EVID/baseline-${tag}.txt"; require_cmd psql
  psql "$url" -v ON_ERROR_STOP=1 --no-psqlrc -q -f "$SQL_DIR/baseline.sql" > "$out" || die "baseline capture ($tag) failed"
  validate_baseline_keys "$out" "$tag"; ok "baseline captured + validated: $out"
}
compare_baseline() {
  local pre="$EVID/baseline-pre.txt" post="$EVID/baseline-post.txt" k vpre vpost
  [[ -f "$pre" && -f "$post" ]] || die "missing baseline files"
  validate_baseline_keys "$pre" pre; validate_baseline_keys "$post" post
  for k in eas_rows ede_rows eas_bad_state_rows; do            # MUST be preserved
    vpre="$(sed -n "s/^${k}=//p" "$pre")"; vpost="$(sed -n "s/^${k}=//p" "$post")"
    [[ "$vpre" == "$vpost" ]] || die "baseline PRESERVE violated: $k $vpre -> $vpost (data corrupted/lost)"
    ok "baseline preserved: $k = $vpre"
  done
  for k in reader_academy_md5 reader_overview_md5; do          # MUST change (re-emit)
    vpre="$(sed -n "s/^${k}=//p" "$pre")"; vpost="$(sed -n "s/^${k}=//p" "$post")"
    [[ "$vpre" != "$vpost" ]] || die "baseline CHANGE expected: $k unchanged (reader not re-emitted)"
    ok "baseline changed as expected: $k"
  done
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

  capture_baseline "$prod" pre
  log "activating maintenance gate"
  supabase secrets set INVOICE_EMAIL_MAINTENANCE=1 --project-ref "$EXPECTED_REF"
  local body; body="$(curl -sS "$probe" -H "Authorization: Bearer ${MANAGER_TOKEN}")"
  printf '%s' "$body" | jq -e '.maintenance == true' >/dev/null || die "gate not maintenance=true; ABORT"
  local T_GATE; T_GATE="$(now_iso)"; ok "gate ON at $T_GATE"

  prove_drain "$T_GATE"       # cannot reach db push without this

  ( cd "$WT"; export SUPABASE_PROJECT_ID="$EXPECTED_REF"
    assert_pending_is_expected "$(push_dry_run_pending)" "$EXPECTED_VERSIONS"
    log "db push (lock_timeout=${CAP_LOCK}ms statement_timeout=${CAP_STMT}ms)"
    PGOPTIONS="-c lock_timeout=${CAP_LOCK} -c statement_timeout=${CAP_STMT}" supabase db push --linked --yes ) || {
      die "db push failed. ledger=$(ledger_status "$prod"). Gate stays ON. Run 'rollback615 $prod'."
    }
  local st; st="$(ledger_status "$prod")"
  case "$st" in
    all) ok "all three migrations recorded";;
    invalid) die "INVALID ledger state after push — STOP, investigate. Gate stays ON.";;
    *) die "post-push ledger='$st' (expected all). Gate stays ON; run 'rollback615 $prod'.";;
  esac

  run_artifact "$prod" postflight.sql
  run_artifact "$prod" acl_matrix.sql
  run_artifact "$prod" ledger_verification.sql
  capture_baseline "$prod" post
  compare_baseline

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
  prefix1  -> only $V1 applied. Fix the failing later file; re-run apply615 (push
              resumes from $V2). Keep the gate ON.
  prefix2  -> $V1,$V2 applied. Re-run apply615 (push resumes from $V3).
  all      -> every file applied. Run 'postflight $url'; gate may go OFF once it passes.
  invalid  -> the ledger holds an IMPOSSIBLE subset (e.g. {$V2} or {$V1,$V3}).
              STOP. This is not a normal prefix — investigate manually; do NOT
              re-run apply615 and do NOT turn the gate OFF.

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
