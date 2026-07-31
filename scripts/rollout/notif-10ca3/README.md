# 10c-a3 rollout bundle — executable artifacts

Executable, checked-in, CI-verified artifacts for rolling out **#616 (send-invoice-email
maintenance gate + observable tracking)** then **#615 (the three `20261006*`
email-delivery migrations)**. This replaces the prose runbook: every check is a
script or a `\set ON_ERROR_STOP on` SQL file that **fails loudly**.

Nothing here merges, deploys, enables a digest event, or mutates production on
its own. The digest worker / digest event stay **disabled throughout**.

---

## What is proven locally + in CI vs. owner-only

**Proven here (no Docker, no prod)** — also run by CI on every change to this
directory (`.github/workflows/rollout-tooling.yml`), and all at once via
`npm run verify:rollout`:

| proof | command | evidence | result |
|---|---|---|---|
| SQL artifacts execute on the real chain; every assertion mutation-pinned | `node …/verify/verify-artifacts.mjs` | [verify-run.txt](evidence/verify-run.txt) | 13/13 |
| A/B/C/D rehearsals (measure / lock-abort / prefix-recovery / full) | `node …/verify/rehearsals.mjs` | [rehearsals.txt](evidence/rehearsals.txt) | 14/14 |
| exact-identity allow-list rejects look-alike hosts / wrong refs | `bash …/verify/identity-selftest.sh` | [identity-selftest.txt](evidence/identity-selftest.txt) | 14/14 |
| critical guards fail when weakened (mutation) | `bash …/verify/guard-mutation-test.sh` | [guard-mutation.txt](evidence/guard-mutation.txt) | 15/15 |
| log-retrieval request well-formed + window-bounded | `bash …/logfetch/fetch-edge-logs.sh --dry-run` | [logfetch-dryrun.txt](evidence/logfetch-dryrun.txt) | OK |

The harnesses boot an embedded Postgres, reproduce the Supabase default-privilege
footgun, and apply the **real** chain: base email + on-main digest from the tree,
then the three PR #615 migrations read at a **pinned SHA** (`verify/chain.mjs`
`PR615_SHA`), so the proof is deterministic and reproducible in CI.

**Owner-only (needs the real Supabase project):** the live `run-rollout.sh`
prod-mutating steps (`gh pr merge`, `supabase functions deploy`,
`supabase secrets set`, `supabase db push`) and the live edge-log fetch. The
executable rehearsals above prove the SQL / lock-timeout / atomicity / recovery
behaviour those steps depend on.

---

## Files

```
run-rollout.sh              operator dispatcher (#616 then #615; per-step gated)
lib/common.sh               logging; EXACT-identity allow-list; drain/pending guards; psql runner
sql/_assert.sql             portable assertion helpers (pg_temp.assert / assert_eq / note)
sql/preflight.sql           pre-migration reads + delta-absent + A_window/CAP (also post-abort check)
sql/baseline.sql            machine-readable snapshot: preserve-keys + reader fingerprints
sql/academy_fixture.sql     disposable-clone reader precedence proof (+ rollback proof)
sql/postflight.sql          post-migration delta present + INERT + digest-disabled
sql/acl_matrix.sql          self-contained ACL lockdown assertions
sql/ledger_verification.sql append-only ledger + email-table consistency invariants
logfetch/fetch-edge-logs.sh Management API edge-log retrieval + authoritative drain proof
verify/chain.mjs            shared embedded-PG setup + SHA-pinned migration source
verify/verify-artifacts.mjs SQL-artifact proof (+ mutations)
verify/rehearsals.mjs       executable A/B/C/D rehearsals
verify/identity-selftest.sh identity allow-list proof
verify/guard-mutation-test.sh critical-guard mutation proofs
evidence/                   captured run outputs
```

---

## Rollout order (operator)

```bash
export EXPECTED_REF=<20-char-project-ref>
export SUPABASE_ACCESS_TOKEN=<PAT>          # Dashboard -> Account -> Access Tokens
export SUPABASE_DB_PASSWORD=<db password>   # never echoed
export MANAGER_TOKEN=<academy-manager JWT>  # for the gate probe (NOT service_role)

# 0. identity — refuse to run against the wrong project
run-rollout.sh check-identity

# 1. #616: merge + deploy FROM ITS MERGE-SHA WORKTREE + verify gate OFF
run-rollout.sh phase616 --yes
#    then production-verify #616: send a real invoice email and confirm delivery.

# 2. #615 dry run: PRE-MERGE head-SHA worktree + real `supabase db push --dry-run`;
#    asserts EXACTLY 20261006100000/110000/120000 pending
run-rollout.sh dryrun615

# 3. preflight on prod (read-only): row counts, delta absent, CAP_STMT
PROD="postgresql://postgres:$SUPABASE_DB_PASSWORD@db.$EXPECTED_REF.supabase.co:5432/postgres?sslmode=require"
run-rollout.sh preflight "$PROD"

# 4. #615 maintenance window (gate ON -> AUTHORITATIVE DRAIN PROOF -> dry-run==3 ->
#    bounded db push from the worktree -> postflight/acl/ledger + baseline compare -> gate OFF)
CAP_STMT=<ms-from-preflight> PROD_CONN_URL="$PROD" MIN_DRAIN_SECONDS=180 \
  run-rollout.sh apply615 --yes
```

- **The push cannot be reached without the drain proof.** `apply615` flips the
  gate ON, then `prove_drain` waits `MIN_DRAIN_SECONDS` and calls
  `fetch-edge-logs.sh` twice: **zero** `provider_send_started` in `[T_GATE, now]`
  (no bypass) **and** every send started in `[T_GATE-MIN, now]` reached
  `event:finished` (no straggler). Any failure aborts before `db push`.
- **Worktree targeting.** `db push`/`deploy` run from a detached worktree at the
  verified SHA with `SUPABASE_PROJECT_ID=$EXPECTED_REF` (beats the absent
  `.temp/project-ref`); the worktree's own `supabase/config.toml` `project_id`
  is asserted to equal `EXPECTED_REF` before any operation.
- **Recovery (none/prefix/all).** `supabase db push` applies each migration file
  in its own transaction + ledger row, so a mid-way failure leaves a PREFIX.
  On failure `apply615` reports `ledger-status`; `rollback615 <url>` prints the
  matrix. Re-running `apply615` resumes from the first un-recorded version. The
  gate stays ON until `postflight` passes.
- **Baselines.** `apply615` captures `baseline.sql` pre/post to
  `evidence/baseline-{pre,post}.txt` and asserts the email-table row counts are
  preserved and the reader fingerprints changed (re-emit landed).

---

## Rehearsals A/B/C/D — executed here

`node …/verify/rehearsals.mjs` runs each on its own fresh database and produces
[evidence/rehearsals.txt](evidence/rehearsals.txt):

- **A — A_window.** Seeds 20k rows, times the `ADD COLUMN … STORED` rewrite,
  derives `CAP_STMT` (measured + 50% headroom).
- **B — lock abort.** A second session holds `ACCESS EXCLUSIVE`; the migration
  under `lock_timeout` aborts with **55P03** and leaves the column **absent**.
- **C — none → PREFIX → all + recovery.** Uses the real
  `supabase_migrations.schema_migrations` ledger; a mid-push failure leaves
  `{file1}`; re-pushing the pending files reaches `all` and postflight passes.
- **D — full.** Applies all three, asserts the baseline row counts are preserved,
  and runs academy_fixture + postflight + acl + ledger on the full clone.

The owner reproduces A/B/C/D against prod-scale snapshots by pointing
`supabase db push --db-url "$CLONE"` (or `--linked` in a clone project) at a
disposable clone and running `run-rollout.sh verify-clone "$CLONE"`.

---

## Log retrieval (no `supabase functions logs`)

The installed CLI (v2.107.0) has no `functions logs`; `supabase inspect` covers
Postgres only. Deployed edge logs come from the Management API analytics endpoint
the Dashboard uses:

```
GET https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/logs.all
    ?sql=…&iso_timestamp_start=…&iso_timestamp_end=…
Authorization: Bearer <Personal Access Token>
```

`fetch-edge-logs.sh` filters `event_message like '%[SEND-INVOICE-EMAIL]%'`
(dialect-agnostic across the ClickHouse/legacy backends), counts
`event:blocked / provider_send_started / finished / record_failed`, correlates
`invocationId`s, and exits non-zero on a gate bypass or an in-flight straggler.
Keep the window well under 24h (the endpoint silently returns empty near ~48h).

---

## Remaining manual production-only steps

1. Merge + deploy **#616**, verify a real invoice email delivers.
2. Provide `EXPECTED_REF`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`,
   `MANAGER_TOKEN`, `PROD_CONN_URL`, `CAP_STMT`.
3. Run A–D on prod-scale clones (record `A_window`/`CAP_STMT`).
4. Execute `apply615` — the drain proof + dry-run==3 + recovery gates are built in.
5. Turn the gate OFF only after `postflight`/`acl_matrix`/`ledger_verification`
   pass. The digest engine stays disabled the entire time.
