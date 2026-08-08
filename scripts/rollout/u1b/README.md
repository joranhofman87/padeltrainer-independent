# U1b — legacy mapping + checkpointed backfill rehearsal

What U1a produced was a read-only *inventory*: for every academy–Player relationship the live system
can derive today, which canonical row would it become, and which candidates are not deterministically
eligible. U1b turns that into a **plan**, proves a backfill can execute the plan **resumably**, and
makes the drift and anomaly findings **durable artifacts** instead of console output.

Nothing here runs against a remote database. The migration is authored as source; applying it
anywhere remote, and executing a real backfill, are separate owner gates (U1c).

## The pieces

| File | Role |
|---|---|
| `supabase/migrations/20261114100000_u1b_membership_backfill_manifest.sql` | The logbook: `membership_backfill_runs` + `membership_backfill_items`. Empty, inert, default-deny. |
| `scripts/db/u1b-backfill-plan.mjs` | Inventory result → deterministic plan + `plan_hash`. Pure; no I/O. |
| `scripts/db/u1b-backfill-apply.mjs` | Batched, resumable applier. The only thing that writes. |
| `scripts/db/u1b-artifacts.mjs` | Durable, content-addressed drift/anomaly/plan artifacts. |
| `scripts/db/session-lease.mjs` | Exclusive session acquisition with exactly-once release. |
| `scripts/db/u1a-fixture-universe.mjs` | Shared fixtures — one per evidence path and per disposition. |
| `sql/rollback_u1b_backfill_rows.sql` | Data rollback: removes only what a given run inserted. |
| `sql/rollback_u1b_manifest.sql` | Schema rollback: drops the logbook, refuses while populated. |

## The one idea worth knowing

Each batch writes the membership rows **and** their manifest lines in the *same transaction*. So a
crash always leaves those two in agreement — either both landed or neither did. "Done" is therefore
defined by the manifest, and the remaining work is always exactly `plan − items(run)`. There is no
cursor to fall out of step with reality, and a half-finished batch simply reappears as work.

That single property is what delivers the rest:

- **no skipped tail** — remaining is recomputed from the manifest, never from a saved index;
- **no double write** — `UNIQUE (run_id, academy_profile_id, person_id)`, plus `ON CONFLICT` on the
  canonical pair itself;
- **bounded work per hop** — `batchSize` rows per transaction;
- **monotonic progress** — a batch that fails to shrink the remaining set aborts the run rather than
  spinning.

A run also stores the `plan_hash` it started from. Resuming recomputes the plan and **refuses**
unless the hash still matches, so a run interrupted before a data change can never quietly finish
against a different candidate set than it began with.

## Rollback ownership

`academy_player_memberships` may legitimately hold rows from several sources: this run, an earlier
run, or a later unit. So the data rollback deletes exactly the rows whose manifest line says
`outcome = 'inserted'` **for that run** — never everything that looks backfill-shaped, and never
`TRUNCATE`. Pairs recorded `already_present` were put there by someone else and are left alone.

The manifest lines are **retained** after a data rollback and the run is marked `aborted`. The
logbook's value is that it records what happened, including what was undone.

```bash
# data rollback (psql, local only)
SET u1b.run_id = '<uuid>';
\i scripts/rollout/u1b/sql/rollback_u1b_backfill_rows.sql
```

The run id arrives as a session GUC rather than a psql variable so the file executes **verbatim** by
any client — the rehearsal runs these exact bytes. A script whose real form only exists after a
harness rewrites it is a script nothing has actually tested.

## Running the proofs

```bash
node scripts/db/rehearse-u1b-membership-backfill.mjs
```

```bash
npx vitest run src/test/u1bBackfillPlan.test.ts src/test/u1bBackfillManifest.pglite.test.ts
```

The rehearsal seeds the shared U1a fixture universe, so every evidence path and every terminal
disposition is exercised, and covers: the disposition partition, plan determinism, byte-identical
artifacts, unresolved-never-written, crash-at-a-batch-boundary followed by resume (compared against
an uninterrupted run), idempotence, plan-drift refusal, both rollbacks, and the post-seed lockdown.

## What this deliberately does not do

No reader or writer switch. No dual-write. No modification, deletion, repointing or anonymization of
any legacy record — the only writes are INSERTs into the canonical membership table and the logbook.
No production backfill: that is U1c, and it additionally requires the OD-10 membership-aware
merge/repoint command, a membership-aware account-deletion path, the audited academy-deletion flow,
and a reviewed backup/export path for membership rows.
