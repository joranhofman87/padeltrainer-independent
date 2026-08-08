/**
 * U1b — the checkpointed, resumable backfill APPLIER.
 *
 * Writes the canonical membership rows a plan calls for, in bounded batches, recording every pair it
 * touches in the U1b logbook (`membership_backfill_runs` / `membership_backfill_items`).
 *
 * ── The one idea that makes this resumable ────────────────────────────────────────────────────
 *
 * Each batch writes the membership rows AND their manifest lines in the SAME transaction. So a crash
 * anywhere leaves those two in agreement: either both landed, or neither did. "Done" is therefore
 * defined by the manifest, and the remaining work is always exactly `plan − items(run)`. There is no
 * cursor to get out of step with reality, and a half-finished batch simply reappears as work.
 *
 *   * no skipped tail    — remaining is recomputed from the manifest, not from a saved index;
 *   * no double write    — UNIQUE (run_id, academy, person) on the manifest, plus ON CONFLICT on the
 *                          membership pair itself;
 *   * bounded per hop    — batchSize rows per transaction;
 *   * monotonic progress — a batch that fails to shrink `remaining` aborts the run rather than
 *                          spinning (a silent infinite loop is the worst possible outcome here).
 *
 * ── Plan pinning ─────────────────────────────────────────────────────────────────────────────
 *
 * A run stores the `plan_hash` it started from. Resuming recomputes the plan and REFUSES unless the
 * hash still matches, so a run interrupted before a data change can never finish against a different
 * candidate set than it began with. That refusal is terminal and explicit — never a silent merge of
 * two plans.
 *
 * ── What this never does ─────────────────────────────────────────────────────────────────────
 *
 * It never writes a row for an unresolved candidate: the plan contains eligible pairs only, and the
 * plan is built from the inventory's own classification. It never modifies, deletes or repoints any
 * legacy record — the only writes are INSERTs into the canonical membership table and the logbook.
 * It never TRUNCATEs. Rows the run did not insert are recorded as `already_present` and are not
 * owned by it.
 */

import { acquireLease } from './session-lease.mjs';
import { buildBackfillPlan, planHashOf } from './u1b-backfill-plan.mjs';
import { runMembershipInventory } from './u1a-membership-inventory.mjs';

export const APPLIER_VERSION = 'u1b.apply.1';

export const DEFAULT_BATCH_SIZE = 500;

export class BackfillApplyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackfillApplyError';
    this.code = code;
  }
}

const pairKey = (r) => `${r.academy_profile_id}|${r.person_id}`;

/**
 * THE ORDINARY ENTRY POINT: read the inventory and apply what it implies, in one call.
 *
 * Prefer this over calling `applyBackfillPlan` with a plan you assembled yourself. The hashes in a
 * plan are computed with a PUBLIC function over PUBLIC data, so they prove a plan is internally
 * consistent — they cannot prove it came from a real inventory run. A caller could build an arbitrary
 * eligible set and a hash that agrees with it. This function removes the opportunity: the plan comes
 * from an inventory executed here, moments earlier, against the same database.
 *
 * (Cryptographically authenticating a plan artifact — a MAC over the inventory output with a
 * server-held key — would close the remaining gap for a plan that must travel between processes. That
 * needs a managed secret, so it is deliberately left to the unit that gains one; it is not something
 * U1b can hold.)
 *
 * `applyBackfillPlan` stays exported for exactly two legitimate uses: resuming a run whose plan must
 * be re-supplied, and tests that need to drive a specific plan.
 */
export async function runMembershipBackfill(sessionSource, { asOf, batchSize = DEFAULT_BATCH_SIZE } = {}) {
  // The inventory takes its own READ ONLY snapshot and releases its lease before we write; it must,
  // because a READ ONLY transaction cannot host the applier's INSERTs.
  //
  // POINT-IN-TIME. That means a plan describes the sources as they were at `asOf`, and the legacy
  // sources can move between the read and the writes — a resumable, multi-transaction backfill cannot
  // promise otherwise without freezing every legacy table for its whole duration, which is not
  // something a live system can offer. Plan pinning catches drift on RESUME; it cannot catch drift
  // before a new run's first write. So instead of pretending, the reconciliation below RE-READS after
  // the fact and REPORTS any pair that is no longer eligible. Reported, never auto-corrected:
  // silently deleting a membership row because the sources moved is exactly the destruction this
  // programme rules out. Deciding what to do about a stale pair belongs to the owner-gated unit.
  const inventory = await runMembershipInventory(sessionSource, { asOf });
  const plan = buildBackfillPlan(inventory);
  const summary = await applyBackfillPlan(sessionSource, { plan, batchSize });

  const after = await runMembershipInventory(sessionSource, { asOf });
  const afterPlan = buildBackfillPlan(after);
  const stillEligible = new Set(afterPlan.rows.map(pairKey));
  const wroteKeys = plan.rows.map(pairKey);

  const reconciliation = {
    plan_hash_before: plan.plan_hash,
    plan_hash_after: afterPlan.plan_hash,
    sources_unchanged: plan.plan_hash === afterPlan.plan_hash,
    // Pairs this run wrote that the sources no longer justify. Non-empty means the legacy data moved
    // mid-flight; the rows stand and are listed for review.
    written_no_longer_eligible: wroteKeys.filter((k) => !stillEligible.has(k)),
    // Pairs that became eligible after the plan was taken. They were NOT written — a later run picks
    // them up, which is why this is reported rather than treated as a failure.
    newly_eligible_not_written: afterPlan.rows.map(pairKey).filter((k) => !wroteKeys.includes(k)),
  };

  return { inventory, plan, summary, reconciliation };
}

/**
 * Applies (or resumes) a plan.
 *
 * @param sessionSource        object exposing connect() -> { query, release }
 * @param plan                 the object returned by buildBackfillPlan()
 * @param batchSize            rows per transaction (bounded work per hop)
 * @param resumeRunId          when set, continue that run instead of starting a new one
 * @param maxBatches           hard backstop against a runaway loop
 * @param onBatchCommitted     optional hook, called after each committed batch; a test uses it to
 *                             kill the run at a batch boundary and prove resume equivalence
 */
export async function applyBackfillPlan(sessionSource, {
  plan,
  batchSize = DEFAULT_BATCH_SIZE,
  resumeRunId = null,
  maxBatches = 100000,
  onBatchCommitted = null,
} = {}) {
  if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.rows)) {
    throw new BackfillApplyError('INVALID_PLAN', 'applyBackfillPlan: plan.rows must be an array.');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new BackfillApplyError('INVALID_BATCH_SIZE', 'applyBackfillPlan: batchSize must be a positive integer.');
  }
  if (!Number.isInteger(maxBatches) || maxBatches < 1) {
    throw new BackfillApplyError('INVALID_MAX_BATCHES', 'applyBackfillPlan: maxBatches must be a positive integer.');
  }

  // The hash travels with the plan, but is RECOMPUTED here: a caller that hand-edited `rows` after
  // the plan was built would otherwise pin the run to a hash its own contents no longer produce.
  //
  // A MISSING hash is rejected too, not waved through. Treating absence as "nothing to check" is a
  // fail-open: it let a hand-built object reach the write path with no provenance at all.
  const recomputed = planHashOf(plan);
  if (typeof plan.plan_hash !== 'string' || plan.plan_hash === '') {
    throw new BackfillApplyError(
      'PLAN_HASH_MISSING',
      'applyBackfillPlan: the plan carries no plan_hash. Build it with buildBackfillPlan() — an '
      + 'unhashed object has no provenance and must not reach the write path.',
    );
  }
  if (plan.plan_hash !== recomputed) {
    throw new BackfillApplyError(
      'PLAN_HASH_MISMATCH',
      `applyBackfillPlan: the plan's stored hash (${plan.plan_hash}) does not match its contents `
      + `(${recomputed}) — the plan was modified after it was built.`,
    );
  }

  // Duplicate pairs inside one plan would make `planned_row_count` a lie and let the manifest's
  // UNIQUE constraint fire on our own input rather than on real contention.
  const planKeys = new Set();
  for (const row of plan.rows) {
    if (row === null || typeof row !== 'object'
      || typeof row.academy_profile_id !== 'string' || typeof row.person_id !== 'string') {
      throw new BackfillApplyError('INVALID_PLAN', 'applyBackfillPlan: a plan row is malformed.');
    }
    const k = pairKey(row);
    if (planKeys.has(k)) {
      throw new BackfillApplyError('DUPLICATE_PLAN_ROW', `applyBackfillPlan: plan contains ${k} twice.`);
    }
    planKeys.add(k);
  }

  const lease = await acquireLease(sessionSource);
  let leaseReleased = false;
  const releaseOnce = async (err) => {
    if (leaseReleased) return;
    leaseReleased = true;
    try { await lease.release(err); } catch { /* never mask the operation error */ }
  };

  try {
    // ── run identity ────────────────────────────────────────────────────────────────────────
    let runId = resumeRunId;

    if (runId === null) {
      const { rows } = await lease.query(
        `INSERT INTO public.membership_backfill_runs
           (plan_hash, inventory_version, as_of, planned_row_count, batch_size)
         VALUES ($1, $2, $3::timestamptz, $4, $5)
         RETURNING id`,
        [recomputed, plan.inventory_version, plan.as_of, plan.rows.length, batchSize],
      );
      runId = rows[0].id;
    } else {
      const { rows } = await lease.query(
        `SELECT id, plan_hash, status, planned_row_count, batch_size
         FROM public.membership_backfill_runs WHERE id = $1`,
        [runId],
      );
      if (rows.length === 0) {
        throw new BackfillApplyError('UNKNOWN_RUN', `applyBackfillPlan: no run ${runId}.`);
      }
      const run = rows[0];
      if (run.status !== 'in_progress') {
        throw new BackfillApplyError(
          'RUN_NOT_RESUMABLE',
          `applyBackfillPlan: run ${runId} is '${run.status}', not 'in_progress'.`,
        );
      }
      // THE drift refusal. Terminal on purpose: silently continuing would mix two candidate sets.
      if (run.plan_hash !== recomputed) {
        throw new BackfillApplyError(
          'PLAN_DRIFT',
          `applyBackfillPlan: run ${runId} was pinned to plan ${run.plan_hash} but the plan supplied `
          + `now hashes to ${recomputed}. The candidate set changed; start a new run rather than `
          + 'finishing this one against different data.',
        );
      }
      // The run records ONE hop size, so a resume at a different size would make that record false
      // for part of the run's own history. Overwriting it is no better — earlier checkpoints were
      // genuinely committed at the old size. So this refuses instead: a different hop size means a
      // new run (the plan is deterministic, and pairs already written come back as already_present).
      if (run.batch_size !== batchSize) {
        throw new BackfillApplyError(
          'BATCH_SIZE_CHANGED',
          `applyBackfillPlan: run ${runId} recorded batch_size ${run.batch_size} but this resume asks `
          + `for ${batchSize}. One run records one hop size; start a new run for a different size.`,
        );
      }
    }

    // Checkpoint numbering continues from what is already recorded. Restarting at 0 on every
    // invocation would make several hops share a batch_seq, so the log would no longer say in which
    // order the work actually happened.
    const { rows: seqRows } = await lease.query(
      `SELECT COALESCE(max(batch_seq) + 1, 0)::int AS next_seq
       FROM public.membership_backfill_items WHERE run_id = $1`,
      [runId],
    );
    const firstBatchSeq = seqRows[0].next_seq;

    // ── remaining = plan − items(run) ────────────────────────────────────────────────────────
    const { rows: doneRows } = await lease.query(
      `SELECT academy_profile_id, person_id
       FROM public.membership_backfill_items WHERE run_id = $1`,
      [runId],
    );
    const done = new Set(doneRows.map(pairKey));

    // A manifest line whose pair is not in the plan means this run_id belongs to a different plan
    // than the hash claims — refuse rather than "reconcile" it away.
    for (const k of done) {
      if (!planKeys.has(k)) {
        throw new BackfillApplyError(
          'MANIFEST_FOREIGN_PAIR',
          `applyBackfillPlan: run ${runId} already recorded ${k}, which is not in this plan.`,
        );
      }
    }

    let remaining = plan.rows.filter((r) => !done.has(pairKey(r)));

    const summary = {
      applier_version: APPLIER_VERSION,
      run_id: runId,
      plan_hash: recomputed,
      planned_rows: plan.rows.length,
      already_done_on_entry: done.size,
      inserted: 0,
      already_present: 0,
      batches: 0,
    };

    // ── batch loop ──────────────────────────────────────────────────────────────────────────
    while (remaining.length > 0) {
      if (summary.batches >= maxBatches) {
        throw new BackfillApplyError(
          'MAX_BATCHES_EXCEEDED',
          `applyBackfillPlan: stopped after ${maxBatches} batches with ${remaining.length} rows left.`,
        );
      }

      const batch = remaining.slice(0, batchSize);
      const batchSeq = firstBatchSeq + summary.batches;
      const before = remaining.length;

      await lease.query('BEGIN');
      try {
        // RE-ASSERT the run INSIDE the batch transaction, holding a row lock.
        //
        // The pre-loop check is not enough on its own: a data rollback can mark this run 'aborted'
        // and delete its rows while we are mid-loop, and without this we would happily insert the
        // tail back in afterwards and report success. Taking the run row FOR UPDATE also serialises
        // us against the rollback script, which locks the same row first.
        const { rows: guard } = await lease.query(
          `SELECT status, plan_hash FROM public.membership_backfill_runs
           WHERE id = $1 FOR UPDATE`,
          [runId],
        );
        if (guard.length === 0) {
          throw new BackfillApplyError('UNKNOWN_RUN', `applyBackfillPlan: run ${runId} vanished mid-run.`);
        }
        if (guard[0].status !== 'in_progress') {
          throw new BackfillApplyError(
            'RUN_NO_LONGER_IN_PROGRESS',
            `applyBackfillPlan: run ${runId} became '${guard[0].status}' while it was executing `
            + '(most likely a rollback). Refusing to write any further rows into it.',
          );
        }
        if (guard[0].plan_hash !== recomputed) {
          throw new BackfillApplyError(
            'PLAN_DRIFT',
            `applyBackfillPlan: run ${runId} was re-pinned to ${guard[0].plan_hash} mid-run.`,
          );
        }

        const academyIds = batch.map((r) => r.academy_profile_id);
        const personIds = batch.map((r) => r.person_id);

        // ON CONFLICT DO NOTHING, so a pair another unit already owns is not an error. RETURNING
        // tells us which rows THIS statement created — that, and only that, is what this run owns.
        const { rows: insertedRows } = await lease.query(
          `INSERT INTO public.academy_player_memberships (academy_profile_id, person_id)
           SELECT * FROM unnest($1::uuid[], $2::uuid[])
           ON CONFLICT (academy_profile_id, person_id) DO NOTHING
           RETURNING id, academy_profile_id, person_id`,
          [academyIds, personIds],
        );
        const insertedById = new Map(insertedRows.map((r) => [pairKey(r), r.id]));

        // Whatever did not come back already existed; fetch its id so the log names a real row.
        //
        // FOR KEY SHARE, not a bare SELECT. `ON CONFLICT DO NOTHING` above only tells us a row was
        // there at that instant; under READ COMMITTED this statement takes a NEW snapshot, so a
        // concurrent committed DELETE in between would make the row disappear and we would record
        // the pair as "done" with nothing to point at — the pair would then never be retried and no
        // membership row would exist. The lock pins every row we resolve for the rest of the
        // transaction, and the completeness check below turns any remaining gap into a failed batch
        // (which rolls back and leaves the pair as work) rather than a silent hole.
        const { rows: existingRows } = await lease.query(
          `SELECT m.id, m.academy_profile_id, m.person_id
           FROM public.academy_player_memberships m
           JOIN unnest($1::uuid[], $2::uuid[]) AS w(academy_profile_id, person_id)
             ON w.academy_profile_id = m.academy_profile_id AND w.person_id = m.person_id
           FOR KEY SHARE OF m`,
          [academyIds, personIds],
        );
        const existingById = new Map(existingRows.map((r) => [pairKey(r), r.id]));

        const itemAcademies = [];
        const itemPersons = [];
        const itemMembershipIds = [];
        const itemOutcomes = [];
        let insertedInBatch = 0;
        let presentInBatch = 0;

        for (const row of batch) {
          const k = pairKey(row);
          const wasInserted = insertedById.has(k);
          const membershipId = wasInserted ? insertedById.get(k) : (existingById.get(k) ?? null);

          if (wasInserted) insertedInBatch += 1; else presentInBatch += 1;

          // EVERY line must name a real membership row, whichever outcome it records. A "done" line
          // with nothing to point at is the one way this design can lose a planned row: the pair
          // leaves the remaining set and no row exists. The column is NOT NULL for the same reason —
          // this check just turns the constraint into a legible failure.
          if (membershipId === null || membershipId === undefined) {
            throw new BackfillApplyError(
              'MEMBERSHIP_UNRESOLVED',
              `applyBackfillPlan: could not resolve a membership row for ${k} `
              + `(outcome would have been ${wasInserted ? 'inserted' : 'already_present'}). Most `
              + 'likely it was deleted concurrently; the batch is rolled back so the pair stays work.',
            );
          }

          itemAcademies.push(row.academy_profile_id);
          itemPersons.push(row.person_id);
          itemMembershipIds.push(membershipId);
          itemOutcomes.push(wasInserted ? 'inserted' : 'already_present');
        }

        // Same transaction as the membership INSERT above: this is the atomicity the whole resume
        // model rests on. No ON CONFLICT here — a duplicate manifest line means the remaining-set
        // computation is wrong, and that must surface loudly, not be absorbed.
        await lease.query(
          `INSERT INTO public.membership_backfill_items
             (run_id, academy_profile_id, person_id, membership_id, batch_seq, outcome)
           SELECT $1, w.academy_profile_id, w.person_id, w.membership_id, $2, w.outcome
           FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::text[])
                AS w(academy_profile_id, person_id, membership_id, outcome)`,
          [runId, batchSeq, itemAcademies, itemPersons, itemMembershipIds, itemOutcomes],
        );

        await lease.query('COMMIT');

        summary.inserted += insertedInBatch;
        summary.already_present += presentInBatch;
        summary.batches += 1;
        remaining = remaining.slice(batch.length);

        // Monotonic progress or stop. `remaining` is recomputed by slicing, so this can only trip if
        // a future edit breaks the loop's shape — which is exactly when a spin would go unnoticed.
        if (remaining.length >= before) {
          throw new BackfillApplyError(
            'NO_PROGRESS',
            `applyBackfillPlan: batch ${batchSeq} did not reduce the remaining set (${before} → ${remaining.length}).`,
          );
        }

        if (onBatchCommitted) {
          // Deliberately AFTER commit and outside the transaction: a test that throws from here
          // simulates a crash at a clean batch boundary, which is the case resume must survive.
          await onBatchCommitted({ batchSeq, remaining: remaining.length, runId });
        }
      } catch (err) {
        // The batch is void; the pairs stay unrecorded and therefore stay in `remaining` for the
        // next attempt. The run stays 'in_progress' ON PURPOSE — marking it aborted here would
        // destroy the resumability this design exists to provide.
        try { await lease.query('ROLLBACK'); } catch { /* connection may be gone */ }
        throw err;
      }
    }

    // ── completion ──────────────────────────────────────────────────────────────────────────
    // One transaction, run row locked: reconcile and flip to 'completed' atomically. Doing the count
    // outside a lock would let a rollback land between the two and leave us asserting a state that no
    // longer holds.
    let finalCounts;
    await lease.query('BEGIN');
    try {
      const { rows: guard } = await lease.query(
        `SELECT status FROM public.membership_backfill_runs WHERE id = $1 FOR UPDATE`, [runId]);
      if (guard.length === 0 || guard[0].status !== 'in_progress') {
        throw new BackfillApplyError(
          'RUN_NO_LONGER_IN_PROGRESS',
          `applyBackfillPlan: run ${runId} is '${guard[0]?.status ?? 'gone'}' at completion; refusing `
          + 'to report success for a run something else has already terminated.',
        );
      }

      const counted = await lease.query(
        `SELECT count(*)::int AS items,
                count(*) FILTER (WHERE outcome = 'inserted')::int AS inserted
         FROM public.membership_backfill_items WHERE run_id = $1`,
        [runId],
      );
      finalCounts = counted.rows;
      if (finalCounts[0].items !== plan.rows.length) {
        throw new BackfillApplyError(
          'RECONCILIATION_FAILED',
          `applyBackfillPlan: run ${runId} recorded ${finalCounts[0].items} manifest lines for a plan `
          + `of ${plan.rows.length} rows.`,
        );
      }

      // RETURNING, and the result is checked: a guarded UPDATE that matches nothing used to leave the
      // run untouched while this function still reported 'completed'.
      const { rows: done } = await lease.query(
        `UPDATE public.membership_backfill_runs
         SET status = 'completed', completed_at = now()
         WHERE id = $1 AND status = 'in_progress'
         RETURNING id`,
        [runId],
      );
      if (done.length !== 1) {
        throw new BackfillApplyError(
          'RUN_NOT_COMPLETABLE',
          `applyBackfillPlan: run ${runId} could not be marked completed.`,
        );
      }
      await lease.query('COMMIT');
    } catch (err) {
      try { await lease.query('ROLLBACK'); } catch { /* connection may be gone */ }
      throw err;
    }

    summary.manifest_lines = finalCounts[0].items;
    summary.manifest_inserted = finalCounts[0].inserted;
    summary.status = 'completed';

    await releaseOnce();
    return summary;
  } catch (err) {
    await releaseOnce();
    throw err;
  }
}
