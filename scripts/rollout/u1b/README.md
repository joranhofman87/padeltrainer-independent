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
| `scripts/db/u1b-backfill-apply.mjs` | `runMembershipBackfill` (the ordinary entry point) + the batched, resumable applier. The only thing that writes. |
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

Two things make "done = manifest" true rather than merely intended:

- Every manifest line **must** name a real membership row (`membership_id` is `NOT NULL`). A line
  recording a pair as done with nothing to point at is the one way this design could lose a planned
  row — the pair leaves the remaining set and no row exists. The applier therefore resolves ids under
  `FOR KEY SHARE`, because `ON CONFLICT DO NOTHING` only proves a row existed *at that instant* and
  the follow-up lookup takes a new snapshot under READ COMMITTED.
- Every batch **re-asserts the run** inside its own transaction, holding the run row `FOR UPDATE`.
  The pre-loop check is not enough: an operator can roll the run back while a resume is mid-loop, and
  without the re-assert the tail would be written straight back in and reported as success.

A run also stores the `plan_hash` it started from. Resuming recomputes the plan and **refuses**
unless the hash still matches, so a run interrupted before a data change can never quietly finish
against a different candidate set than it began with. A plan with **no** hash is refused too —
treating absence as "nothing to check" would let a hand-built object reach the write path with no
provenance at all. And the planner recomputes the *inventory's* own content hash rather than trusting
it, so an inventory object tampered with after the fact is rejected.

**What hashes cannot do.** They are computed with a public function over public data, so they prove a
plan is internally *consistent* — never that it came from a real inventory run. Use
`runMembershipBackfill(sessionSource, { asOf, batchSize })`: it runs the inventory itself and applies
what that implies, so the ordinary path never accepts a caller-supplied plan. `applyBackfillPlan`
remains exported for two legitimate uses only — resuming a run whose plan must be re-supplied, and
tests that drive a specific plan. Authenticating a plan artifact that must travel between processes
needs a MAC over the inventory output with a server-held key; that requires a managed secret, so it
belongs to the unit that gains one.

A run records **one** hop size. Resuming at a different `batchSize` is refused rather than
overwriting a value that was true for the checkpoints already committed — a different hop size means
a new run, which is safe because the plan is deterministic and pairs already written come back as
`already_present`.

The plan hash deliberately covers the eligible rows and the legacy-derived reconciliation, and
**excludes** the inventory's `inventory_content_hash`. That hash spans the whole inventory report,
including `membership_table_state` — the row count of the table this backfill writes into. Folding it
in would make the plan hash change as a direct result of the backfill's own success, so an operator
rebuilding a plan to resume a half-finished run would be told it had "drifted" every time and the
refusal would become noise to work around. The hash answers one question: *has the candidate set
moved?*

## Point-in-time, and what is done about it

A plan describes the sources as they were at `asOf`. Between the read and the writes the legacy
sources can move, and a resumable multi-transaction backfill cannot promise otherwise without
freezing every legacy table for its whole duration — not something a live system can offer. Plan
pinning catches drift on **resume**; it cannot catch drift before a new run's first write.

So `runMembershipBackfill` re-reads afterwards and **reports** it, in `reconciliation`:

- `sources_unchanged` — the candidate set is identical before and after;
- `written_no_longer_eligible` — pairs this run wrote that the sources no longer justify;
- `newly_eligible_not_written` — pairs that became eligible after the plan was taken (a later run
  picks them up, which is why this is reported rather than treated as a failure).

Nothing is auto-corrected. Silently deleting a membership row because the sources moved is exactly
the destruction this programme rules out; deciding what to do about a stale pair belongs to the
owner-gated unit.

## Cross-run dependencies

Two runs can touch one pair: the first creates it (`inserted`, and therefore owns it), a later one
finds it already there (`already_present`, and therefore depends on it). Rolling back the **owner**
would delete a row the later run's manifest accounts for, leaving a `completed` run short of
memberships. The data rollback refuses in that case and names the dependent runs, so a human decides
which to unwind first.

Artifacts are written atomically: everything is staged in a sibling directory and moved into place
with a single `rename`, so an interrupted write leaves the previous set intact rather than new
payloads beside a stale manifest. `verifyArtifacts(dir)` re-checks every payload against the
manifest's hashes — a manifest nobody verifies is decoration.

## Rollback ownership

`academy_player_memberships` may legitimately hold rows from several sources: this run, an earlier
run, or a later unit. So the data rollback deletes exactly the rows whose manifest line says
`outcome = 'inserted'` **for that run** — never everything that looks backfill-shaped, and never
`TRUNCATE`. Pairs recorded `already_present` were put there by someone else and are left alone.

The manifest lines are **retained** after a data rollback and the run is marked `aborted`. The
logbook's value is that it records what happened, including what was undone. For the same reason
`membership_backfill_items.run_id` is `ON DELETE RESTRICT`, not `CASCADE`: deleting a run must not be
a quiet way to erase the provenance of membership rows that still exist, so discarding a run's
evidence has to be explicit — items first, deliberately.

Both rollback scripts lock `membership_backfill_runs` **before** `membership_backfill_items`. The
schema rollback still *drops* items first (it is the referencing table), but locking in the opposite
order from the data rollback would give two concurrent rollbacks a lock cycle.

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
