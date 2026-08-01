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
| A–F rehearsals (measure / lock-abort / prefix-recovery / full / state-recompute / clone-battery) | `node …/verify/rehearsals.mjs` | [rehearsals.txt](evidence/rehearsals.txt) | 28/28 |
| exact-identity allow-list rejects look-alike hosts / wrong refs | `bash …/verify/identity-selftest.sh` | [identity-selftest.txt](evidence/identity-selftest.txt) | 14/14 |
| critical guards fail when weakened (mutation) | `bash …/verify/guard-mutation-test.sh` | [guard-mutation.txt](evidence/guard-mutation.txt) | 54/54 |
| operator control flow (resume615 / recovery-SHA / no-loss / clean-evidence / full clone-command matrix / secure-delete) | `bash …/verify/operator-flow-test.sh` | [operator-flow.txt](evidence/operator-flow.txt) | 117/117 |
| exit-status integrity (a failure can never report success) | `bash …/verify/exit-status-test.sh` | [exit-status.txt](evidence/exit-status.txt) | 30/30 |
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
sql/manifest.sql            no-loss manifest: salted address/id fingerprints + reader fingerprints
sql/academy_fixture.sql     disposable-clone reader precedence proof (+ rollback proof)
sql/postflight.sql          post-migration delta present + INERT + digest-disabled
sql/acl_matrix.sql          self-contained ACL lockdown assertions
sql/ledger_verification.sql append-only ledger + email-table consistency invariants
logfetch/fetch-edge-logs.sh Management API edge-log retrieval + authoritative drain proof
verify/chain.mjs            shared embedded-PG setup + SHA-pinned migration source
verify/verify-artifacts.mjs SQL-artifact proof (+ mutations)
verify/rehearsals.mjs       executable A–F rehearsals (incl. step-8 clone battery)
verify/identity-selftest.sh identity allow-list proof
verify/guard-mutation-test.sh critical-guard mutation proofs
verify/operator-flow-test.sh  resume615 + clone-command runtime proof (stubbed gh/git/supabase/psql)
verify/exit-status-test.sh    exit-status integrity proof (masked-failure regression)
evidence/                   captured run outputs
```

---

## Rollout order (operator)

`check-identity` and `phase616` are **already DONE** — #616 is merged (`429d35c3`)
and deployed, and the gate is OFF. **Do not run `phase616` again**; re-running it
would attempt a second merge/deploy of an already-shipped PR. The remaining steps
are 6→11 below.

```bash
export EXPECTED_REF=<20-char-project-ref>
export SUPABASE_ACCESS_TOKEN=<PAT>          # Dashboard -> Account -> Access Tokens
export SUPABASE_DB_PASSWORD=<db password>   # consumed by the CLI; never echoed
export MANAGER_TOKEN=<academy-manager JWT>  # freshly minted, short-lived; NOT service_role
# psql auth via PGPASSWORD — keep the password OUT of argv and the connection URL
export PGPASSWORD="$SUPABASE_DB_PASSWORD"
PROD="postgresql://postgres@db.$EXPECTED_REF.supabase.co:5432/postgres?sslmode=require"

# [DONE] identity — refuse to run against the wrong project
run-rollout.sh check-identity

# [DONE] #616: pin-checked merge (--match-head-commit) + deploy from the merge-SHA
#        worktree (--project-ref) + verify gate OFF
run-rollout.sh phase616 --yes

# 6. [PENDING — blocks everything below] production-verify #616 with ONE REAL
#    (non-test) invoice send; see "Step 6" below for the pass/fail contract.

# 7. #615 dry run: pinned head-SHA worktree + real `supabase db push --dry-run`;
#    asserts EXACTLY 20261006100000/110000/120000 pending
run-rollout.sh dryrun615

# 8. rehearsals A–D on a production-scale disposable clone (see "Reproducing A–D on a PRODUCTION-SCALE clone") —
#    clone-make-prefix + clone-push + verify-clone, never against prod

# 9. preflight on prod (read-only): row counts, delta absent, CAP_STMT
#    (this production value is authoritative; the clone's is only an expectation)
run-rollout.sh preflight "$PROD"

# 10. #615 maintenance window (gate ON -> AUTHORITATIVE DRAIN PROOF -> dry-run==3 ->
#     bounded db push from the worktree -> postflight/acl/ledger + baseline compare -> gate OFF)
CAP_STMT=<ms-from-preflight> PROD_CONN_URL="$PROD" \
  run-rollout.sh apply615 --yes         # MIN_DRAIN_SECONDS defaults to the 520s floor

# 11. no-loss comparison, then destroy the retained evidence
run-rollout.sh clean-evidence --yes "$PROD"
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
- **Target identity on every URL-taking command.** `preflight`, `postflight`,
  `ledger-status` and `rollback615` assert the connection URL is `EXPECTED_REF`
  by default. All four are **decision** commands: preflight's `CAP_STMT` bounds
  the production push, postflight authorizes gate-OFF, and ledger-status /
  `rollback615` decide resume-vs-stop. (`rollback615` mutates nothing — it reads
  the ledger and prints the recovery guidance for that state; the guard matters
  because guidance derived from the *wrong* database would be acted on.) So a
  wrong URL must never report green. `--clone` is **not an identity bypass**: it
  swaps the assertion to `CLONE_REF`, which must be set, well-formed,
  **different from `EXPECTED_REF`**, and matched exactly by the URL. The
  write-bearing clone commands (`clone-push`, `clone-make-prefix`,
  `verify-clone`) *require* an explicit clone target and refuse without it.
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
  re-capture the pre-baseline). Instead `resume615 --yes` **re-enables the gate
  (also when it was found OFF) and runs a fresh exact-canary drain**, requires
  the **exact pending suffix** (prefix1→`V2,V3`, prefix2→`V3`), retries only the
  reviewed pin (or a proven-merged `RECOVERY_PR`), pushes the suffix, requires
  `ledger=all`, runs postflight/ACL/ledger, compares against the **original**
  pre-manifest (never overwritten), and only then turns the gate OFF. See the
  operator recovery contract below.
- **Concurrency-safe no-loss manifest.** `manifest.sql` runs all queries in ONE
  `REPEATABLE READ READ ONLY` transaction (so the fingerprint enumeration and the
  `count(*)` share one snapshot), captured **after the drain** (pre) and
  post-migration. `validate_manifest` enforces internal **completeness**: exact
  line grammar, no unknown/duplicate/malformed lines, and unique `EAS`/`EDE`
  fingerprint counts equal to `eas_rows`/`ede_rows` — a vacuous/incomplete
  capture fails. The compare is a **no-loss subset**: every pre-existing address
  key + `email_delivery_events.id` must still exist post-migration; **new rows
  are allowed**. Counts + `eas_bad_state_rows` are **evidence only**; reader
  fingerprints **must** change.
- **Evidence privacy.** Address keys/ids are **salted SHA-256** fingerprints
  (pseudonymous personal data, not anonymous). The manifests + the per-run secret
  salt are written `0600` under `umask 077`; the salt is passed to psql via the
  environment (`\getenv`, psql ≥ 16) so it never appears in process arguments.
  Delete them after the rollout with `run-rollout.sh clean-evidence --yes <url>`
  (`shred` when available; otherwise the bytes are overwritten in place and then
  unlinked, with a warning — note that on SSD/CoW filesystems an overwrite is not
  a guarantee, so the real controls are the `0600` perms and short retention) — the pre-manifest + salt are the ONLY recovery material for
  `resume615`, so cleanup refuses (preserving every file) unless ALL of:
  exact project identity, `ledger=all`, valid pre/post manifests, a passing
  no-loss comparison, passing postflight/ACL/ledger verification, and the
  maintenance gate confirmed OFF. `edge-log-lines.txt` is not deleted.

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

### Reproducing A–D on a PRODUCTION-SCALE clone (step 8, owner-only)

Two things make this non-obvious, and both are enforced by the tooling:

- **The migrations are not on `main`.** Step 8 happens *before* #615 merges, so
  the three `20261006*` files exist **only** at `PR615_SHA`. A `db push` from
  `main` would apply **nothing**. `clone-push` builds a detached worktree at the
  reviewed pin and pushes from there — it never merges #615 and never uses the
  ambient linked project (it passes `--db-url`).
- **Clone commands write.** `academy_fixture.sql` INSERTs before it ROLLBACKs, and
  `clone-push` applies migrations. So every clone command demands `CLONE_REF`,
  proves `CLONE_REF != EXPECTED_REF`, and proves the URL addresses `CLONE_REF`
  exactly. `--clone` alone is not accepted.
- **`clone-push` applies the MISSING suffix, not "all three".** It classifies the
  clone's ledger exactly as production recovery does and requires the matching
  pending set — `none`→V1,V2,V3 · `prefix1`→V2,V3 · `prefix2`→V3 · `all`→no-op ·
  `invalid`→refuse. Demanding all three would make rehearsal C impossible to run,
  which is why that behaviour is now mutation-pinned as a failure.

```bash
export EXPECTED_REF=<prod ref>     # never the clone
export CLONE_REF=<clone ref>       # must differ from EXPECTED_REF
export PGPASSWORD='<clone password>'
CLONE="postgresql://postgres@db.$CLONE_REF.supabase.co:5432/postgres?sslmode=require"
```

Each rehearsal needs its **own pristine snapshot** — B and C leave the clone in a
deliberately broken state. Restore/recreate the clone between them.

**A — measure the real rewrite window.** On a fresh prod-scale clone:
```bash
run-rollout.sh preflight "$CLONE" --clone          # emits rows/bytes + CAP_LOCK/CAP_STMT expectations
CAP_STMT=<from preflight> run-rollout.sh clone-push --yes "$CLONE"   # time this
```
*Evidence:* `preflight` output (row count, MiB, CAP values) + wall-clock duration of the push → `evidence/cloneA-<date>.txt`.
*Pass:* push completes inside `CAP_STMT`. *Fail:* statement timeout → CAP is too low for prod scale; re-derive before step 9.

**B — bounded lock abort.** Fresh snapshot. In psql session 1:
```sql
BEGIN; LOCK TABLE public.email_address_state IN ACCESS EXCLUSIVE MODE;  -- hold it
```
Then, in session 2, run the same `clone-push`. *Pass:* it aborts on `lock_timeout`
(**SQLSTATE 55P03**) and `run-rollout.sh preflight "$CLONE" --clone` still passes
— i.e. the delta is **absent**, nothing partial landed. Release the lock
(`ROLLBACK`). *Fail:* the push blocks past `CAP_LOCK`, or preflight now fails.

**C — prefix recovery.** Fresh snapshot. The prefix is *created on purpose*, by
the real CLI: `clone-make-prefix` hands `supabase db push` a detached worktree at
`PR615_SHA` with the later migration files **pruned**, so the CLI applies exactly
the first file and writes exactly that ledger row. No hand-written INSERT into
`supabase_migrations`, and the prune touches only the disposable worktree.

```bash
run-rollout.sh ledger-status "$CLONE" --clone                          # expect: none
CAP_STMT=<from A> run-rollout.sh clone-make-prefix --yes 1 "$CLONE"    # apply V1 only
run-rollout.sh ledger-status "$CLONE" --clone                          # expect: prefix1
CAP_STMT=<from A> run-rollout.sh clone-push --yes "$CLONE"             # applies the V2,V3 suffix
run-rollout.sh ledger-status "$CLONE" --clone                          # expect: all
run-rollout.sh verify-clone "$CLONE" --clone
```
`clone-make-prefix` needs a **pristine** clone (`ledger=none`) — you cannot
manufacture a prefix over existing state — and accepts depth `1` or `2` only.
*Pass:* `none` → `prefix1` → `all`, and `verify-clone` passes. *Fail:* any
`invalid` ledger state — stop and investigate; do not carry it into step 9.
*Evidence:* the three `ledger-status` lines → `evidence/cloneC-<date>.txt`.

**D — clean full apply + verification.** Fresh snapshot:
```bash
run-rollout.sh preflight "$CLONE" --clone                  # phase 1: delta ABSENT
CAP_STMT=<from A> run-rollout.sh clone-push --yes "$CLONE"
run-rollout.sh verify-clone "$CLONE" --clone               # phase 2: fixture+postflight+ACL+ledger
```
*Pass:* all four artifacts green. Capture the output as `evidence/cloneD-<date>.txt`.

**Cleanup:** destroy every clone/snapshot afterwards — they hold production data.

The battery is **two-phase** by construction: `preflight.sql` asserts the delta is
**ABSENT** while `postflight.sql`/`academy_fixture.sql` require it **PRESENT**, so
`verify-clone` contains **no** `preflight.sql`. Rehearsal F pins that by reading
the artifact list out of `run-rollout.sh`, so re-adding a contradictory artifact
fails locally and in CI before a clone cycle is wasted.

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

Preconditions: the interrupted `apply615` left its original
`evidence/manifest-pre.txt` + `manifest-salt.txt` (reused, never re-captured).
`resume615`:

| ledger state | action |
|---|---|
| `none` | refuse — use `apply615` (nothing applied) |
| `prefix1` (`{V1}`) | **re-enable gate + FRESH exact-canary drain**, then push the exact suffix **`V2,V3`** |
| `prefix2` (`{V1,V2}`) | same fresh drain, then push the exact suffix **`V3`** |
| `all` | verify only (no drain) |
| `invalid` (`{V2}`, `{V1,V3}`, …) | refuse — stop, investigate |

**Fresh drain:** current maintenance state does not prove *uninterrupted* gating,
so for prefix states `resume615` re-activates the gate, sets a fresh `T_GATE`,
and runs the same `prove_drain` (exact-canary correlation, 520s coverage, zero
post-gate starts, no straggler, no `record_failed`) **before** the suffix push —
even if the probe already reports `maintenance=true`.

**Reviewed-recovery-SHA trust:** the default retries the reviewed `PR615_SHA`. A
*differing* recovery is accepted **only** with a fully-reviewed `RECOVERY_PR` +
`RECOVERY_SHA` where the PR head equals `RECOVERY_SHA`, its checks are green, and
it is MERGED — then the push deploys from its **verified merge commit**. Arbitrary
local commits, head mismatches, pending/failed CI, and unmerged PRs are rejected.
`resume615` still never re-merges #615.

## No-loss baseline contract

The migration must not lose data. `resume615`/`apply615` prove, against the
manifest captured after the drain, that **every** pre-existing address key and
event id still exists post-migration; **new** rows (a pre-gate send finishing, a
Resend webhook callback) are allowed. Deleting any pre-existing address/event
fails. This replaces the earlier unsafe exact-count equality.

It does **not** re-merge #615 and does **not** overwrite the pre-baseline. It
retries the reviewed pin (`PR615_SHA`); a corrected migration requires a
separately reviewed `RECOVERY_SHA`. After push it requires `ledger=all`, runs
postflight/ACL/ledger, compares against the original pre-baseline, then turns the
gate OFF. The whole control flow is proven by `verify/operator-flow-test.sh` with
stubbed `gh`/`supabase`/`psql` (`gh` is asserted unused on the **default
reviewed-pin path**; the `RECOVERY_PR` path does call `gh` to prove the recovery
PR is merged, checks-green, and head-matched).

---

## Current status + remaining production-only steps

**#616 is MERGED and DEPLOYED** (merge commit `429d35c3`); `send-invoice-email`
runs from that exact SHA and the maintenance gate is **OFF**. **#615 remains
OPEN, draft, and pinned** at `PR615_SHA` — none of its migrations are deployed,
and it is merged **only** by `apply615`, never by hand. The digest engine is
disabled throughout.

**PENDING — step 6:** one real (non-test) invoice send, verified end to end.
Everything after it is blocked on it.

### Step 6 — real-invoice delivery verification (owner performs)

**It MUST be a real, non-test send.** A `testEmail` send cannot prove step 6:
`recordInvoiceEmailEvent` returns early for test sends (no `record_email_event`,
so no delivery tracking) and the invoice-status stamp is skipped. A test send
proves only that the provider accepted a message — useful as an optional
provider smoke check, **never** as step-6 evidence.

*Setup.* Pick a real invoice whose **resolved recipient is an address you
control**. `get_invoice_recipient_identity` resolves the recipient as: the
academy-scoped override `academy_player_metadata.billing_email` → the linked
profile's email → the guest's own email. Redirecting one to yourself means
temporarily changing **production routing**, so capture the old value first and
restore it afterwards — an "ephemeral" override that is never put back keeps
sending that player's invoices to the wrong inbox forever:

```sql
-- BEFORE: record the current value verbatim (NULL and 'absent row' are different states)
SELECT academy_profile_id, profile_id, guest_player_id, billing_email
  FROM public.academy_player_metadata
 WHERE academy_profile_id = '<academy uuid>' AND removed_at IS NULL
   AND (profile_id = '<player uuid>' OR guest_player_id = '<guest uuid>');
-- redirect for the test (same WHERE clause)
UPDATE public.academy_player_metadata SET billing_email = '<address you control>'
 WHERE academy_profile_id = '<academy uuid>' AND removed_at IS NULL
   AND (profile_id = '<player uuid>' OR guest_player_id = '<guest uuid>');
```
Confirm the gate probe reads `{"status":"active","maintenance":false}` first.

*Action.* Send that one invoice from the academy/trainer invoice UI. Not a
preview, not a test send. Note the **invoice id** and the wall-clock minute.

*Retrieving the `invocationId` (it is NOT in the response or the UI).* The 200
response body is `{"success":true,"email":"<recipient>"}` — no correlation id,
and it contains the recipient address, so do not paste it anywhere. The id lives
only in the function log line, alongside the invoice id:

```bash
scripts/rollout/notif-10ca3/logfetch/fetch-edge-logs.sh --ref "$EXPECTED_REF" \
  --start <ISO minute before the send> --end <ISO minute after> \
  --allow-sends --assert-all-finished --fail-on-record-failed
grep '<invoice uuid>' scripts/rollout/notif-10ca3/evidence/edge-log-lines.txt
```
The matching `event:provider_send_started` line carries
`{"invocationId":"…","invoiceId":"…"}` — that uuid is your correlation id for
everything below. (`--allow-sends` is required here: unlike the drain proof, a
send in this window is the expected outcome. The fetch overwrites the checked-in
sample `evidence/edge-log-lines.txt`; do not commit the production copy.)

*Pass — all four:*
1. the email **arrives** at the controlled recipient, correct branding/reply-to;
2. logs for that one `invocationId` show `event:provider_send_started` →
   `event:finished {"outcome":"sent"}`, with **no** `event:blocked` and **no**
   `record_failed` (the `--fail-on-record-failed` run above exits 6 if there is);
3. **delivery tracking** recorded it: `get_invoices_delivery_status` reports
   `sent` for that invoice (later `delivered` when the Resend webhook lands), and
   the invoice shows as sent in the UI;
4. no Slack alert fired.

*Stop (any one = FAIL, do not advance):* `503 invoice_email_maintenance` (gate
unexpectedly ON); `500 email_not_configured`; `{"success":false,"error":"no_email"}`;
**`record_failed`** in logs (the send worked but tracking did not — exactly what
#615 exists to fix; report it); `finished {"outcome":"send_failed"}`.

*Evidence to retain (PII-safe):* the `invocationId`, event names + timestamps,
the invoice id, and the resulting delivery status. **Never** paste recipient
addresses, response bodies, message bodies, or any token.

*Cleanup.* The send itself needs none — it is a normal business email. But if you
changed `billing_email` (or any other routing field) for the test, **restore the
captured value and verify the restore**, pass or fail:

```sql
UPDATE public.academy_player_metadata SET billing_email = <the BEFORE value, or NULL>
 WHERE academy_profile_id = '<academy uuid>' AND removed_at IS NULL
   AND (profile_id = '<player uuid>' OR guest_player_id = '<guest uuid>');
-- verify: this must return exactly the BEFORE row
SELECT academy_profile_id, profile_id, guest_player_id, billing_email
  FROM public.academy_player_metadata
 WHERE academy_profile_id = '<academy uuid>' AND removed_at IS NULL
   AND (profile_id = '<player uuid>' OR guest_player_id = '<guest uuid>');
```
Step 6 is not complete until that SELECT matches what you recorded. If you
created a metadata row that did not exist before, delete it rather than leaving
it with a NULL override.

Then:
1. Provide `EXPECTED_REF`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`,
   `PROD_CONN_URL`, and a **freshly minted** `MANAGER_TOKEN` (short-lived; mint it
   immediately before the step that needs it — never reuse an exposed one).
2. Run rehearsals **A–D on a production-scale clone** (see "Reproducing A–D on a PRODUCTION-SCALE clone" above) and record the
   clone's `A_window` / CAP expectations.
3. `preflight "$PROD"` immediately before the window — the **production-derived**
   `CAP_STMT` is authoritative; the clone's value is only an expectation. Stop on
   an unexplained divergence.
4. `apply615 --yes` — pin check, merge, drain proof, bounded push, verification.
5. Turn the gate OFF only after `postflight`/`acl_matrix`/`ledger_verification`
   pass, then `clean-evidence --yes "$PROD"`.
