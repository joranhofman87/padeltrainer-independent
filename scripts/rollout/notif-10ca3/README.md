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
| A/B/C/D/E rehearsals (measure / lock-abort / prefix-recovery / full / state-recompute) | `node …/verify/rehearsals.mjs` | [rehearsals.txt](evidence/rehearsals.txt) | 21/21 |
| exact-identity allow-list rejects look-alike hosts / wrong refs | `bash …/verify/identity-selftest.sh` | [identity-selftest.txt](evidence/identity-selftest.txt) | 14/14 |
| critical guards fail when weakened (mutation) | `bash …/verify/guard-mutation-test.sh` | [guard-mutation.txt](evidence/guard-mutation.txt) | 45/45 |
| operator control flow (resume615) with stubbed gh/supabase/psql | `bash …/verify/operator-flow-test.sh` | [operator-flow.txt](evidence/operator-flow.txt) | 14/14 |
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
export SUPABASE_DB_PASSWORD=<db password>   # consumed by the CLI; never echoed
export MANAGER_TOKEN=<academy-manager JWT>  # for the gate probe/canary (NOT service_role)
# psql auth via PGPASSWORD — keep the password OUT of argv and the connection URL
export PGPASSWORD="$SUPABASE_DB_PASSWORD"
PROD="postgresql://postgres@db.$EXPECTED_REF.supabase.co:5432/postgres?sslmode=require"

# 0. identity — refuse to run against the wrong project
run-rollout.sh check-identity

# 1. #616: pin-checked merge (--match-head-commit) + deploy from the merge-SHA
#    worktree (--project-ref) + verify gate OFF
run-rollout.sh phase616 --yes
#    then production-verify #616: send a real invoice email and confirm delivery.

# 2. #615 dry run: pinned head-SHA worktree + real `supabase db push --dry-run`;
#    asserts EXACTLY 20261006100000/110000/120000 pending
run-rollout.sh dryrun615

# 3. preflight on prod (read-only): row counts, delta absent, CAP_STMT
run-rollout.sh preflight "$PROD"

# 4. #615 maintenance window (gate ON -> AUTHORITATIVE DRAIN PROOF -> dry-run==3 ->
#    bounded db push from the worktree -> postflight/acl/ledger + baseline compare -> gate OFF)
CAP_STMT=<ms-from-preflight> PROD_CONN_URL="$PROD" \
  run-rollout.sh apply615 --yes         # MIN_DRAIN_SECONDS defaults to the 520s floor
```

- **The push cannot be reached without an EXACT drain proof.** After the gate is
  ON, `prove_drain`: (a) fires a **safe authenticated non-probe canary that must
  return 503**, and the maintenance body echoes its `invocationId` (see the
  canary-correlation contract below); (b) waits `MIN_DRAIN_SECONDS` (default
  **520s** — the 400s hosted-function wall + margin; a value below the floor is
  rejected); (c) reads **one widened, minute-rounding-padded analytics snapshot**
  `[T_GATE-MIN-60s, now+60s]` and enforces everything **locally**: the canary's
  **exact** `event:blocked` invocationId present, **zero post-gate**
  `provider_send_started` (compared against the gate epoch, not a minute-rounded
  bound), no in-flight straggler, no `record_failed`. Log reads are **fail-closed**
  — an empty/missing `.result`, a truncated page, an unrelated/stale blocked
  event, or a wrong id all abort before `db push`.
- **No SHA drift.** #615/#616 heads are pinned in `PINS.env`; `apply615`/`phase616`
  assert the live head equals the reviewed pin and merge with
  `gh pr merge --match-head-commit`, so only the CI-tested commit ships.
- **Explicit targeting.** every `supabase functions deploy` / `secrets set|unset`
  carries `--project-ref $EXPECTED_REF`; `db push` runs from a detached worktree
  with `SUPABASE_PROJECT_ID=$EXPECTED_REF` and the worktree's own
  `config.toml project_id` asserted to equal `EXPECTED_REF`.
- **Recovery — the executable `resume615 --yes`.** `supabase db push` applies
  each migration file in its own transaction + ledger row, so a mid-way failure
  leaves an ordered PREFIX. `ledger_status` queries
  `supabase_migrations.schema_migrations` (fail-loud on a connection error) and
  accepts **only** `none`, `{V1}`, `{V1,V2}`, or `all`; any impossible subset is
  `invalid` and **stops**. Do **not** re-run `apply615` (it would re-merge and
  re-capture the pre-baseline). Instead `resume615 --yes` asserts the gate is
  still ON, requires the **exact pending suffix** (prefix1→`V2,V3`, prefix2→`V3`),
  retries only the reviewed pin (or an explicitly-reviewed `RECOVERY_SHA`),
  pushes the suffix, requires `ledger=all`, runs postflight/ACL/ledger, compares
  against the **original** pre-baseline (never overwritten), and only then turns
  the gate OFF. See the operator recovery contract below.
- **Baselines.** `baseline.sql` is captured pre/post (`ON_ERROR_STOP`, every key
  validated). Only **true invariants** are equality-checked — email-table row
  counts must be preserved, reader fingerprints must change. `eas_bad_state_rows`
  is recorded as **evidence only**: PR #615 intentionally recomputes historical
  state (e.g. `hard_bounced`/`soft_bounced` → `ok`), so its count may change.

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

## Canary-correlation contract

1. `apply615` sends one authenticated **non-probe** request to `send-invoice-email`
   (a sentinel body; the gate returns before any invoice read/send).
2. With the gate ON the function returns **HTTP 503** with body
   `{"success":false,"error":"invoice_email_maintenance","invocationId":"<uuid>"}`
   (#616 change) and logs `event:blocked {"invocationId":"<uuid>"}`.
3. `prove_drain` captures that exact `<uuid>` and requires **its** `event:blocked`
   line in the analytics window (`--require-invocation`). An unrelated/stale
   blocked event, a wrong id, or an empty result all fail. This proves the gate
   is live, log ingestion is current, and — combined with the local
   `--gate-at-epoch` zero-send check — that no send passed the gate.

## Operator recovery contract (`resume615 --yes`)

Preconditions: the interrupted `apply615` left the gate **ON** and its original
`evidence/baseline-pre.txt`. `resume615`:

| ledger state | action |
|---|---|
| `none` | refuse — use `apply615` (nothing applied) |
| `prefix1` (`{V1}`) | push the exact suffix **`V2,V3`** |
| `prefix2` (`{V1,V2}`) | push the exact suffix **`V3`** |
| `all` | verify only |
| `invalid` (`{V2}`, `{V1,V3}`, …) | refuse — stop, investigate |

It does **not** re-merge #615 and does **not** overwrite the pre-baseline. It
retries the reviewed pin (`PR615_SHA`); a corrected migration requires a
separately reviewed `RECOVERY_SHA`. After push it requires `ledger=all`, runs
postflight/ACL/ledger, compares against the original pre-baseline, then turns the
gate OFF. The whole control flow is proven by `verify/operator-flow-test.sh` with
stubbed `gh`/`supabase`/`psql` (gh is asserted **never** called).

---

## Remaining manual production-only steps

1. Merge + deploy **#616**, verify a real invoice email delivers.
2. Provide `EXPECTED_REF`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`,
   `MANAGER_TOKEN`, `PROD_CONN_URL`, `CAP_STMT`.
3. Run A–D on prod-scale clones (record `A_window`/`CAP_STMT`).
4. Execute `apply615` — the drain proof + dry-run==3 + recovery gates are built in.
5. Turn the gate OFF only after `postflight`/`acl_matrix`/`ledger_verification`
   pass. The digest engine stays disabled the entire time.
