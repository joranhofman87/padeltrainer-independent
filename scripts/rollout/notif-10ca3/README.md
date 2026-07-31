# 10c-a3 rollout bundle — executable artifacts

Executable, checked-in artifacts for rolling out **#616 (send-invoice-email
maintenance gate + observable tracking)** and then **#615 (the three
`20261006*` email-delivery migrations)**. This replaces the prose runbook: every
check is a script or a `\set ON_ERROR_STOP on` SQL file that **fails loudly**
when an expected row is absent or a boolean is false.

Nothing here merges, deploys, enables a digest event, or mutates production on
its own. The digest worker / digest event stay **disabled throughout** — this
bundle never touches `notification_event_types.digest_engine_enabled` or the
worker's `DIGEST_SEND_ENABLED`.

---

## What is proven locally vs. owner-only

**Proven locally (in this repo, no Docker, no prod)** — reproduce any time:

| proof | command | evidence |
|---|---|---|
| every SQL artifact executes on a real full-chain Postgres, and every assertion is load-bearing (mutation-pinned) | `node scripts/rollout/notif-10ca3/verify/verify-artifacts.mjs` | [evidence/verify-run.txt](evidence/verify-run.txt) |
| the exact-identity allow-list rejects substring/look-alike hosts and wrong refs | `bash scripts/rollout/notif-10ca3/verify/identity-selftest.sh` | [evidence/identity-selftest.txt](evidence/identity-selftest.txt) |
| the log-retrieval request is well-formed and window-bounded (token redacted) | `bash scripts/rollout/notif-10ca3/logs/fetch-edge-logs.sh --dry-run …` | [evidence/logfetch-dryrun.txt](evidence/logfetch-dryrun.txt) |

`verify-artifacts.mjs` boots an embedded Postgres, reproduces the Supabase
default-privilege footgun, applies the **real** chain (base email tables +
on-main digest chain from disk, then the three `20261006*` migrations via
`git show feat/notif-10ca3-pr1-email-reliability:…`), runs each artifact in the
un-migrated (PRE) and migrated (POST) states, and then applies a targeted
mutation to prove each artifact FAILS when it should. Latest run: **13/13
groups, 0 failed** (129 in-SQL assertions).

**Owner-only (needs the real Supabase project / a prod-scale clone)** — this
environment has no production access or Supabase project, so these are scripted
but not executed here:

- The four disposable-snapshot rehearsals **A/B/C/D** (`supabase db push`
  against pristine prod-scale clones) — see *Rehearsals* below.
- The live edge-log retrieval (`logs/fetch-edge-logs.sh` without `--dry-run`) —
  needs a Personal Access Token and a deployed project.
- The prod-mutating rollout steps in `run-rollout.sh` (`gh pr merge`,
  `supabase functions deploy`, `supabase secrets set`, `supabase db push`).

---

## Files

```
run-rollout.sh              operator dispatcher (#616 then #615; per-step gated)
lib/common.sh               logging, EXACT-identity allow-list, safe URL build, psql runner
sql/_assert.sql             portable assertion helpers (pg_temp.assert / assert_eq / note)
sql/preflight.sql           pre-migration reads + delta-absent + A_window/CAP  (also the post-abort check)
sql/academy_fixture.sql     disposable-clone reader precedence proof (+ rollback proof)
sql/postflight.sql          post-migration delta present + INERT + digest-disabled
sql/acl_matrix.sql          self-contained ACL lockdown assertions
sql/ledger_verification.sql append-only ledger + email-table consistency invariants
logs/fetch-edge-logs.sh     Management API edge-log retrieval + zero-send proof
verify/verify-artifacts.mjs LOCAL embedded-Postgres proof of every SQL artifact (+ mutations)
verify/identity-selftest.sh LOCAL proof of the exact-identity allow-list
evidence/                   captured run outputs
```

---

## Rollout order (operator)

All prod-mutating subcommands re-assert `EXPECTED_REF` and require `--yes`.

```bash
export EXPECTED_REF=<20-char-project-ref>

# 0. identity — refuse to run against the wrong project
EXPECTED_REF=$EXPECTED_REF scripts/rollout/notif-10ca3/run-rollout.sh check-identity

# 1. #616 first: merge the gate+tracking, deploy, verify the gate is OFF
MANAGER_TOKEN=<academy-manager-jwt> \
EXPECTED_REF=$EXPECTED_REF scripts/rollout/notif-10ca3/run-rollout.sh phase616 --yes
#    -> production verification of #616: probe returns maintenance=false; send a
#       real invoice email and confirm delivery before proceeding to #615.

# 2. #615 dry run: prove exactly the three 20261006* migrations are pending
EXPECTED_REF=$EXPECTED_REF scripts/rollout/notif-10ca3/run-rollout.sh dryrun615

# 3. preflight on prod (read-only): row counts, delta absent, CAP_STMT
PROD="postgresql://postgres:$PGPW@db.$EXPECTED_REF.supabase.co:5432/postgres?sslmode=require"
EXPECTED_REF=$EXPECTED_REF scripts/rollout/notif-10ca3/run-rollout.sh preflight "$PROD"

# 4. #615 maintenance window: gate ON -> prove zero sends -> bounded db push ->
#    postflight/acl/ledger -> gate OFF. CAP_STMT from preflight.
CAP_STMT=<ms-from-preflight> PROD_CONN_URL="$PROD" MANAGER_TOKEN=<jwt> \
EXPECTED_REF=$EXPECTED_REF scripts/rollout/notif-10ca3/run-rollout.sh apply615 --yes
```

**No-customer-send verification.** During step 4, after the gate is ON, capture
`T_GATE` and prove zero sends passed it over the window:

```bash
SUPABASE_ACCESS_TOKEN=<PAT> scripts/rollout/notif-10ca3/logs/fetch-edge-logs.sh \
  --ref $EXPECTED_REF --start <T_GATE> --end <now>
# exits non-zero if any event:provider_send_started appears in the window.
```

**Rollback / fix-forward.** `run-rollout.sh rollback615` prints the policy: the
three migrations are additive and the failed push aborts atomically (verify with
`preflight`, which asserts the delta is absent); keep the gate ON until
`postflight` passes. Never hand-write a down migration that re-enables a
half-migrated sender.

---

## Rehearsals A/B/C/D (owner-only, prod-scale clone)

Create a pristine clone (prod schema + data) per rehearsal, e.g. dump/restore to
a scratch database, and target it with `supabase db push --db-url`:

```bash
CLONE="postgresql://…scratch clone with prod-scale data…"
# from the detached #615 worktree (see run-rollout.sh dryrun615 for the SHA/worktree):
PGOPTIONS="-c lock_timeout=3000 -c statement_timeout=$CAP_STMT" \
  supabase db push --db-url "$CLONE"
```

- **A — measure `A_window`.** `run-rollout.sh preflight "$CLONE"` (emits row
  count + `CAP_STMT`), then time the bounded `db push`; the ACCESS EXCLUSIVE
  section is the `email_address_state` rewrite from the STORED generated column.
- **B — lock-timeout abort under contention.** In a second session
  `BEGIN; LOCK TABLE public.email_address_state IN ACCESS EXCLUSIVE MODE;` then
  run the bounded push: it must abort on `lock_timeout`. Re-run
  `preflight "$CLONE"` → the delta must still be **absent** (clean abort).
- **C — trailing-failure atomicity.** Append a deliberately failing statement to
  the end of a migration on a clone-only branch, push, confirm the whole
  transaction rolled back → `preflight "$CLONE"` shows the delta absent and the
  reconcile ledger tables absent.
- **D — full rehearsal.** Bounded push succeeds, then
  `run-rollout.sh verify-clone "$CLONE"` runs preflight → academy_fixture →
  postflight → acl_matrix → ledger_verification. (`academy_fixture.sql` is
  clone-only: it seeds a production-shaped graph and always `ROLLBACK`s.)

The **SQL** each rehearsal relies on is already proven here by
`verify-artifacts.mjs` (fixture precedence, postflight delta, ACL lockdown,
ledger consistency, and the delta-absent/rollback checks) with mutation
evidence. What the owner adds is the real `db push` timing and the
lock-contention/trailing-failure behaviour against prod-scale data.

---

## Log retrieval (why not `supabase functions logs`)

The installed Supabase CLI (v2.107.0) has **no** `functions logs` subcommand
(only `list/delete/download/deploy/new/serve`), and `supabase inspect` covers
Postgres only. Deployed edge logs are retrieved via the Management API analytics
endpoint used by the Dashboard Logs Explorer:

```
GET https://api.supabase.com/v1/projects/{ref}/analytics/endpoints/logs.all
    ?sql=…&iso_timestamp_start=…&iso_timestamp_end=…
Authorization: Bearer <Personal Access Token>   # Dashboard → Account → Access Tokens
```

Our console lines live in `event_message` on both analytics backends (ClickHouse
for projects created after ~June 2026, legacy BigQuery before), so
`fetch-edge-logs.sh` filters `event_message like '%[SEND-INVOICE-EMAIL]%'` and is
dialect-agnostic (`--dialect auto` falls back legacy→… on error). It counts the
four lifecycle markers the code emits — `event:blocked`,
`event:provider_send_started`, `event:finished`, `record_failed` — prints the
`invocationId`s, and **exits non-zero if any `provider_send_started` appears**
while the gate is on. Keep the window well under 24h (the analytics endpoint
silently returns empty near ~48h). Log retention: Free 1d / Pro 7d / Team 28d.

---

## Remaining manual production-only steps

1. Merge + deploy **#616**, then verify a real invoice email is delivered.
2. Provide a `PROD_CONN_URL` (asserted to `EXPECTED_REF`), a `MANAGER_TOKEN`
   (academy-manager JWT, **not** the service_role key), and a
   `SUPABASE_ACCESS_TOKEN` (PAT) for the log proof.
3. Run rehearsals A–D on prod-scale clones; record `A_window` and `CAP_STMT`.
4. Execute the maintenance window (`apply615`), capturing the zero-send log proof.
5. Turn the gate OFF only after `postflight`/`acl_matrix`/`ledger_verification`
   pass on prod. The digest engine stays disabled the entire time.
