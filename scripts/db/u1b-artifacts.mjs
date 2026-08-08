/**
 * U1b — durable, hashed artifacts.
 *
 * The U1a inventory computes drift and anomaly facts but returns them in memory, where they die with
 * the process. U1b's contract is that they become artifacts: written out, content-addressed, and
 * reproducible byte-for-byte from the same snapshot, so a later backfill can be checked against what
 * was actually seen rather than against a re-run that may no longer agree.
 *
 * Everything here is DERIVED from the inventory result and the plan. Nothing re-queries the database
 * and nothing re-derives a classification — a second opinion about which rows are drifted is exactly
 * the kind of divergence these artifacts exist to detect.
 *
 * Two families, kept apart because they mean different things to an operator:
 *
 *   DRIFT     — the legacy stamps and the identity map disagree. These are not broken rows; they are
 *               rows where two shipped resolutions of "who is this?" give different answers. They are
 *               never eligible, and the backfill must leave them alone until a human decides.
 *
 *   ANOMALIES — structural damage: a reference that points nowhere, a reference that points at the
 *               WRONG table, a relationship that crosses a tenant boundary. Independent of identity.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalize } from './u1a-membership-inventory.mjs';

export const ARTIFACTS_VERSION = 'u1b.artifacts.1';

/** Dispositions whose meaning is "the stamps disagree with the identity map". */
export const DRIFT_DISPOSITIONS = [
  'unresolved_stale_person_stamp',
  'unresolved_bridge_divergent',
  'unresolved_divergent_dual_key',
  'unresolved_auto_merged_email_pair',
];

/** Dispositions whose meaning is "the reference itself is structurally wrong". */
export const ANOMALY_DISPOSITIONS = [
  'unresolved_wrong_target_academy_fk',
  'unresolved_orphan_reference',
];

const sortRows = (rows, keys) => [...rows].sort((a, b) => {
  for (const k of keys) {
    const av = a[k] ?? '';
    const bv = b[k] ?? '';
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
});

export function buildArtifacts(inventory, plan) {
  if (inventory === null || typeof inventory !== 'object' || typeof inventory.report !== 'object') {
    throw new Error('buildArtifacts: an inventory result is required.');
  }
  if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.rows)) {
    throw new Error('buildArtifacts: a plan is required.');
  }
  const { report } = inventory;
  const dispositions = report.dispositions ?? [];

  const byDisposition = (wanted) => sortRows(
    dispositions
      .filter((r) => wanted.includes(r.disposition))
      .map((r) => ({
        academy_profile_id: r.academy_profile_id,
        subject_kind: r.subject_kind,
        subject_id: r.subject_id,
        person_id: r.person_id,
        disposition: r.disposition,
      })),
    ['academy_profile_id', 'subject_kind', 'subject_id'],
  );

  const drift = {
    artifacts_version: ARTIFACTS_VERSION,
    inventory_version: inventory.inventory_version,
    as_of: inventory.as_of,
    inventory_content_hash: inventory.content_hash,
    // Candidates quarantined because two shipped resolutions disagree.
    drifted_candidates: byDisposition(DRIFT_DISPOSITIONS),
    // The per-booking evidence behind unresolved_divergent_dual_key: the overview reader resolves by
    // player_id, the FAM-02 stamp resolves guest-first. Both answers are recorded; neither is chosen.
    divergent_dual_key_bookings: sortRows(report.divergent_dual_key ?? [], ['academy_profile_id', 'booking_id']),
    // Legacy rows that never got a person stamp at all.
    unstamped_source_rows: sortRows(report.missing_person_stamp_rows ?? [], ['source', 'row_id']),
    // Metadata owned by a trainer: the owner CHECK is XOR, so these rows carry no academy and cannot
    // be scoped to one. Reported here rather than folded into any academy's candidates.
    trainer_owned_metadata_rows: sortRows(report.trainer_owned_metadata_rows ?? [], ['row_id']),
  };

  const anomalies = {
    artifacts_version: ARTIFACTS_VERSION,
    inventory_version: inventory.inventory_version,
    as_of: inventory.as_of,
    inventory_content_hash: inventory.content_hash,
    structurally_broken_candidates: byDisposition(ANOMALY_DISPOSITIONS),
    // Dangling academy references from the two legacy overlay tables.
    orphans: sortRows(report.orphans ?? [], ['kind', 'row_id']),
    // A preferred location that belongs to another academy; a guest whose trainer is not a trainer of
    // the owning academy. Both cross a tenant boundary.
    cross_tenant: sortRows(report.cross_tenant_anomalies ?? [], ['kind', 'row_id']),
    // The four duplicate measures, kept distinct exactly as the inventory reports them.
    duplicates: {
      raw_multiplicity: report.duplicates_raw_multiplicity ?? [],
      normalized_per_source: report.duplicates_normalized_per_source ?? [],
      cross_source_overlap: report.duplicates_cross_source_overlap ?? [],
      canonical_pair_collision: report.duplicates_canonical_pair_collision ?? [],
    },
    field_conflicts: report.field_conflicts ?? [],
  };

  return { plan, drift, anomalies };
}

/**
 * Writes the artifacts and a manifest naming the sha256 of each file.
 *
 * Files are canonical JSON (sorted keys at every depth), so identical inputs produce identical BYTES,
 * not merely equivalent objects — that is what makes the hashes comparable across runs and machines.
 *
 * ATOMIC. Everything is written into a sibling staging directory and moved into place with a single
 * `rename`. Writing the payloads in place and the manifest last would let an interrupted run leave
 * new payloads beside an old manifest — a directory that still LOOKS like evidence but whose hashes
 * describe different bytes. A partial write must leave the previous artifact set untouched instead.
 */
export function writeArtifacts(dir, artifacts) {
  const files = {
    'plan.json': artifacts.plan,
    'drift.json': artifacts.drift,
    'anomalies.json': artifacts.anomalies,
  };

  const entries = {};
  const payloads = {};
  for (const name of Object.keys(files).sort()) {
    const bytes = canonicalize(files[name]);
    payloads[name] = bytes;
    entries[name] = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: Buffer.byteLength(bytes),
    };
  }

  const manifest = {
    artifacts_version: ARTIFACTS_VERSION,
    plan_hash: artifacts.plan.plan_hash,
    inventory_content_hash: artifacts.drift.inventory_content_hash,
    as_of: artifacts.drift.as_of,
    files: entries,
  };

  // Staged beside the target, so the rename is same-filesystem and therefore atomic. The name is
  // derived from the plan hash rather than a clock or a random value: repeated runs of the same plan
  // reuse it deterministically instead of littering.
  const staging = join(dirname(dir), `.${manifest.plan_hash.slice(0, 16)}.staging`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    for (const name of Object.keys(payloads)) writeFileSync(join(staging, name), payloads[name]);
    writeFileSync(join(staging, 'manifest.json'), canonicalize(manifest));

    // `rename` cannot replace a non-empty directory, so any existing set is removed first. That is
    // the only destructive moment, it is deliberate (the caller asked to write here), and it happens
    // AFTER the new set is fully staged — so a failure while staging leaves the old set intact.
    mkdirSync(dirname(dir), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return manifest;
}

/**
 * Re-reads an artifact directory and verifies every payload against the manifest's hashes.
 *
 * A manifest nobody ever checks is decoration. This is what makes the directory evidence: it proves
 * the bytes on disk are the bytes that were hashed, and it is what a later unit should call before
 * trusting an artifact set it did not produce.
 */
export function verifyArtifacts(dir) {
  const readFile = (p) => readFileSync(p, 'utf8');
  const manifest = JSON.parse(readFile(join(dir, 'manifest.json')));
  const problems = [];
  for (const [name, entry] of Object.entries(manifest.files)) {
    let bytes;
    try { bytes = readFile(join(dir, name)); } catch { problems.push(`${name}: missing`); continue; }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== entry.sha256) problems.push(`${name}: sha256 ${actual} != ${entry.sha256}`);
  }
  return { ok: problems.length === 0, problems, manifest };
}
