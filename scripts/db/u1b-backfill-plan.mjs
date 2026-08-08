/**
 * U1b — the deterministic backfill PLAN.
 *
 * Turns a U1a inventory result into the exact set of canonical rows a membership backfill would
 * insert, plus the reconciliation that proves nothing was invented or dropped along the way.
 *
 * ── Why this reads the inventory instead of re-deriving it ────────────────────────────────────
 *
 * The plan is built from `report.dispositions` — the SAME classification U1a already computed —
 * never from a second copy of the candidate SQL. That makes one invariant structural rather than
 * remembered: the unresolved set is DERIVED (every disposition that is not `eligible`), so a
 * disposition added to U1a is inherited here automatically and can never be silently left out of
 * this file's idea of "unresolved". The execution plan requires exactly that: U1c inherits the
 * unresolved set from U1b, "never a fixed list".
 *
 * ── What a plan is ───────────────────────────────────────────────────────────────────────────
 *
 * A total, ordered set of DISTINCT `(academy_profile_id, person_id)` pairs. Distinct, because several
 * eligible legacy subjects (a guest row and a profile row) can resolve to ONE person at one academy,
 * and the canonical table holds one row per pair — `collision_delta` is exactly that gap, reported
 * rather than hidden.
 *
 * The plan carries a `plan_hash`. The applier pins itself to that hash, so a run interrupted and
 * resumed after the underlying data moved REFUSES instead of finishing against a different plan than
 * it started from.
 *
 * This module performs no I/O and touches no database.
 */

import { canonicalize, contentHash, INVENTORY_VERSION } from './u1a-membership-inventory.mjs';

/** Bump when the PLAN's shape changes; comparing hashes across shapes is meaningless. */
export const PLAN_VERSION = 'u1b.1';

/** The one disposition that produces a membership row. Everything else is, by definition, unresolved. */
export const ELIGIBLE_DISPOSITION = 'eligible';

export class BackfillPlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackfillPlanError';
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Builds the plan.
 *
 * Every rejection below is a CONTRACT violation, not a data condition: bad data is supposed to arrive
 * as an unresolved disposition, so if it reaches here as a malformed eligible row the inventory and
 * this module disagree about the contract, and continuing would write rows nobody classified.
 */
export function buildBackfillPlan(inventory) {
  if (inventory === null || typeof inventory !== 'object') {
    throw new BackfillPlanError('INVALID_INVENTORY', 'buildBackfillPlan: inventory must be an object.');
  }

  const {
    inventory_version: inventoryVersion,
    as_of: asOf,
    content_hash: inventoryContentHash,
    total_candidates: totalCandidates,
    disposition_counts: dispositionCounts,
    mutation_free: mutationFree,
    report,
  } = inventory;

  if (typeof inventoryVersion !== 'string' || inventoryVersion === '') {
    throw new BackfillPlanError('INVALID_INVENTORY', 'buildBackfillPlan: inventory_version missing.');
  }
  if (typeof inventoryContentHash !== 'string' || inventoryContentHash === '') {
    throw new BackfillPlanError('INVALID_INVENTORY', 'buildBackfillPlan: content_hash missing.');
  }
  if (typeof asOf !== 'string' || asOf === '') {
    throw new BackfillPlanError('INVALID_INVENTORY', 'buildBackfillPlan: as_of missing.');
  }
  // A run whose read phase mutated a source table is not a basis for writing anything.
  if (mutationFree !== true) {
    throw new BackfillPlanError(
      'INVENTORY_NOT_MUTATION_FREE',
      'buildBackfillPlan: the inventory reported source mutation (mutation_free !== true); a plan '
      + 'derived from a snapshot that moved under the reader is not a plan.',
    );
  }
  if (report === null || typeof report !== 'object' || !Array.isArray(report.dispositions)) {
    throw new BackfillPlanError('INVALID_INVENTORY', 'buildBackfillPlan: report.dispositions missing.');
  }
  if (dispositionCounts === null || typeof dispositionCounts !== 'object') {
    throw new BackfillPlanError('INVALID_INVENTORY', 'buildBackfillPlan: disposition_counts missing.');
  }

  const dispositions = report.dispositions;

  // ── The partition assertion (I1) ────────────────────────────────────────────────────────────
  // Checked HERE, before a single row is planned. The disposition histogram must account for every
  // candidate exactly once; if it does not, some candidate was double-counted or dropped and the
  // "eligible" subset is not trustworthy either.
  if (typeof totalCandidates !== 'number' || totalCandidates !== dispositions.length) {
    throw new BackfillPlanError(
      'PARTITION_VIOLATION',
      `buildBackfillPlan: total_candidates (${totalCandidates}) does not match the disposition row `
      + `count (${dispositions.length}).`,
    );
  }
  const countSum = Object.values(dispositionCounts).reduce((a, b) => a + b, 0);
  if (countSum !== totalCandidates) {
    throw new BackfillPlanError(
      'PARTITION_VIOLATION',
      `buildBackfillPlan: disposition counts sum to ${countSum} but there are ${totalCandidates} `
      + 'candidates — the terminal dispositions do not partition the candidate universe.',
    );
  }

  // The histogram must match the rows CLASS BY CLASS, not merely in total. A correct sum is easy to
  // achieve while individual classes are wrong (one stolen from `eligible`, one added elsewhere), and
  // `eligible` is the class this module then acts on.
  const recountedByClass = {};
  for (const row of dispositions) {
    if (row === null || typeof row !== 'object' || typeof row.disposition !== 'string') continue;
    recountedByClass[row.disposition] = (recountedByClass[row.disposition] ?? 0) + 1;
  }
  if (canonicalize(recountedByClass) !== canonicalize(dispositionCounts)) {
    throw new BackfillPlanError(
      'PARTITION_VIOLATION',
      'buildBackfillPlan: disposition_counts disagrees with the disposition rows class by class '
      + `(rows: ${canonicalize(recountedByClass)}; reported: ${canonicalize(dispositionCounts)}).`,
    );
  }

  // ── Provenance (I: the plan came from a real inventory run) ─────────────────────────────────
  // `content_hash` is RECOMPUTED from the inventory's own body rather than trusted. Without this a
  // hand-assembled object could hand over an arbitrary eligible set together with a hash that merely
  // agrees with itself, and every downstream check — including the applier's plan pinning — would
  // pass while the plan had no relationship to anything the inventory actually saw.
  const recomputedInventoryHash = contentHash({
    inventory_version: inventoryVersion,
    as_of: asOf,
    disposition_counts: dispositionCounts,
    total_candidates: totalCandidates,
    report,
  });
  if (recomputedInventoryHash !== inventoryContentHash) {
    throw new BackfillPlanError(
      'INVENTORY_HASH_MISMATCH',
      `buildBackfillPlan: the inventory's content_hash (${inventoryContentHash}) does not match its `
      + `contents (${recomputedInventoryHash}) — it was modified after the inventory produced it.`,
    );
  }
  // A shape this planner has never seen cannot be reasoned about: the disposition semantics it maps
  // are those of the inventory version it was written against.
  if (inventoryVersion !== INVENTORY_VERSION) {
    throw new BackfillPlanError(
      'INVENTORY_VERSION_UNSUPPORTED',
      `buildBackfillPlan: inventory_version '${inventoryVersion}' is not the supported `
      + `'${INVENTORY_VERSION}'. Output shapes are not comparable across versions.`,
    );
  }

  // ── Eligible → canonical pairs ──────────────────────────────────────────────────────────────
  const pairs = new Map();          // "academy|person" → { academy_profile_id, person_id }
  let eligibleCandidates = 0;

  for (const row of dispositions) {
    if (row === null || typeof row !== 'object') {
      throw new BackfillPlanError('INVALID_INVENTORY', 'buildBackfillPlan: a disposition row is not an object.');
    }
    if (typeof row.disposition !== 'string' || row.disposition === '') {
      throw new BackfillPlanError('INVALID_INVENTORY', 'buildBackfillPlan: a disposition row has no disposition.');
    }
    if (row.disposition !== ELIGIBLE_DISPOSITION) continue;   // unresolved: never planned, never written

    eligibleCandidates += 1;

    // `unresolved_missing_person_link` precedes `eligible` in U1a's precedence, so an eligible row
    // WITHOUT a person is impossible by construction. If one appears, the two modules disagree about
    // the precedence contract — refuse rather than plan a row with a null key.
    if (typeof row.person_id !== 'string' || !UUID_RE.test(row.person_id)) {
      throw new BackfillPlanError(
        'ELIGIBLE_WITHOUT_PERSON',
        'buildBackfillPlan: an eligible candidate carries no valid person_id '
        + `(academy=${String(row.academy_profile_id)}, subject=${String(row.subject_id)}). The `
        + 'inventory must classify such a candidate unresolved_missing_person_link.',
      );
    }
    if (typeof row.academy_profile_id !== 'string' || !UUID_RE.test(row.academy_profile_id)) {
      throw new BackfillPlanError(
        'ELIGIBLE_WITHOUT_ACADEMY',
        'buildBackfillPlan: an eligible candidate carries no valid academy_profile_id.',
      );
    }

    const key = `${row.academy_profile_id}|${row.person_id}`;
    if (!pairs.has(key)) {
      pairs.set(key, { academy_profile_id: row.academy_profile_id, person_id: row.person_id });
    }
  }

  // Total order on the plan: the applier's batches are slices of THIS array, so the ordering is part
  // of the resumability contract, not presentation. String compare on UUID text is total and stable.
  const rows = [...pairs.values()].sort((a, b) => (
    a.academy_profile_id < b.academy_profile_id ? -1
      : a.academy_profile_id > b.academy_profile_id ? 1
        : a.person_id < b.person_id ? -1
          : a.person_id > b.person_id ? 1 : 0
  ));

  // Unresolved classes are read off the inventory's own histogram — never enumerated here.
  const unresolvedByClass = {};
  for (const [disposition, n] of Object.entries(dispositionCounts)) {
    if (disposition !== ELIGIBLE_DISPOSITION) unresolvedByClass[disposition] = n;
  }
  const unresolvedCandidates = Object.values(unresolvedByClass).reduce((a, b) => a + b, 0);

  if (eligibleCandidates + unresolvedCandidates !== totalCandidates) {
    throw new BackfillPlanError(
      'PARTITION_VIOLATION',
      `buildBackfillPlan: ${eligibleCandidates} eligible + ${unresolvedCandidates} unresolved does not `
      + `equal ${totalCandidates} candidates.`,
    );
  }

  const body = {
    plan_version: PLAN_VERSION,
    inventory_version: inventoryVersion,
    as_of: asOf,
    rows,
    reconciliation: {
      total_candidates: totalCandidates,
      eligible_candidates: eligibleCandidates,
      unresolved_candidates: unresolvedCandidates,
      planned_rows: rows.length,
      // Eligible candidates that collapse onto an already-planned pair. Reported, never silently
      // absorbed: it is the difference between "how many legacy relationships were eligible" and
      // "how many canonical rows that becomes".
      collision_delta: eligibleCandidates - rows.length,
      unresolved_by_class: unresolvedByClass,
    },
  };

  return {
    ...body,
    // Carried for provenance/reporting, but DELIBERATELY OUTSIDE the hashed body — see planHashOf.
    inventory_content_hash: inventoryContentHash,
    planned_row_count: rows.length,
    plan_hash: contentHash(body),
  };
}

/**
 * Recomputes the hash of a plan object as it would have been produced by buildBackfillPlan.
 * Used by the applier to re-verify a plan handed to it, and by the resume path to detect drift.
 *
 * WHY `inventory_content_hash` IS NOT IN HERE. The inventory's content hash covers its whole report,
 * including `membership_table_state` — the row count of the very table this backfill writes into. So
 * folding it in would make the plan hash change as a direct result of the backfill's own success:
 * an operator who rebuilt a plan to resume a half-finished run would be told the plan had "drifted"
 * every single time, and the drift refusal would become noise that has to be worked around.
 *
 * The hash must answer one question — has the CANDIDATE SET moved? — so it covers the eligible rows
 * and the reconciliation derived from the legacy sources, and nothing that this unit itself mutates.
 * Provenance is checked separately, at build time, by recomputing the inventory's own hash.
 */
export function planHashOf(plan) {
  if (plan === null || typeof plan !== 'object') {
    throw new BackfillPlanError('INVALID_PLAN', 'planHashOf: plan must be an object.');
  }
  const { plan_version, inventory_version, as_of, rows, reconciliation } = plan;
  return contentHash({ plan_version, inventory_version, as_of, rows, reconciliation });
}

/** Exported for tests that assert canonical serialization is shared with the inventory. */
export { canonicalize, contentHash };
