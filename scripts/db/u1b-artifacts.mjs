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
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** The payload files an artifact set must contain — exactly these, no more and no fewer. */
export const REQUIRED_PAYLOADS = ['anomalies.json', 'drift.json', 'plan.json'];

/**
 * ── WRITE-ONCE ARTIFACT SETS ───────────────────────────────────────────────────────────────────
 *
 * This replaces an earlier design that staged directories, swapped a pointer file, and content-
 * addressed sets so they could be republished in place. Three review rounds each found another hole
 * in that protocol — a delete-then-rename window, a fail-open verifier, an unvalidated race winner —
 * which is the signal that the model was wrong rather than that the patches were.
 *
 * Nothing in U1b needs republication or concurrent writers. So the protocol is gone, and with it the
 * whole class of defect:
 *
 *   A1  A set directory is written ONCE and never modified afterwards.
 *   A2  `writeArtifacts` REFUSES if the target already exists. It never overwrites and never deletes,
 *       so no prior evidence can be lost — by construction, not by careful ordering.
 *   A3  Identical inputs produce byte-identical payloads (canonical JSON, sorted keys at every depth).
 *   A4  `verifyArtifacts` fails CLOSED: wrong version, wrong file set, missing payload, hash or
 *       byte-length mismatch, or manifest metadata disagreeing with the payloads it describes.
 *   A5  A partial write leaves an incomplete directory, which A4 rejects. There is no state a reader
 *       can mistake for a complete set.
 *
 * "Which set is current?" is deliberately not answered here. That is a question about a run, and the
 * run's identity lives in the database logbook.
 */

/**
 * Writes an artifact set into `dir`, which must NOT already exist.
 *
 * @returns the manifest that was written.
 * @throws if the target exists — deliberately. Refusing is what makes "nothing prior is ever
 *         destroyed" true by construction rather than by careful sequencing.
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

  // `recursive: false` — mkdir fails with EEXIST if anything is already there. That single flag is
  // the whole write-once guarantee, and it is enforced by the OS rather than by a check we could
  // race against.
  mkdirSync(dir, { recursive: false });

  for (const name of Object.keys(payloads)) writeFileSync(join(dir, name), payloads[name]);
  // Manifest last: an interrupted write leaves a directory with no manifest, which verifyArtifacts
  // rejects outright. There is no ordering that makes an incomplete set look complete.
  writeFileSync(join(dir, 'manifest.json'), canonicalize(manifest));

  return manifest;
}

/**
 * Verifies an artifact set. FAILS CLOSED.
 *
 * A manifest nobody checks is decoration, and a verifier that trusts the manifest's own file list is
 * barely better — `{"files":{}}` would sail through with nothing checked. So the required payload set
 * is fixed HERE, and the manifest's headline metadata is cross-checked against the payloads it claims
 * to describe: a set whose manifest says one thing and whose plan says another is not evidence.
 */
export function verifyArtifacts(dir) {
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  } catch (err) {
    return { ok: false, problems: [`manifest.json unreadable or not JSON: ${err.message}`], manifest: null };
  }

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, problems: ['manifest.json is not an object'], manifest: null };
  }
  if (manifest.artifacts_version !== ARTIFACTS_VERSION) {
    problems.push(`artifacts_version ${JSON.stringify(manifest.artifacts_version)} != ${ARTIFACTS_VERSION}`);
  }
  if (manifest.files === null || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    return { ok: false, problems: [...problems, 'manifest.files is missing'], manifest };
  }

  // The manifest does not get to decide what must be present: a stripped list would otherwise mean
  // "nothing to verify" instead of "the set is incomplete".
  const listed = Object.keys(manifest.files).sort();
  if (canonicalize(listed) !== canonicalize(REQUIRED_PAYLOADS)) {
    problems.push(`manifest lists ${JSON.stringify(listed)}, required ${JSON.stringify(REQUIRED_PAYLOADS)}`);
  }

  const parsed = {};
  for (const name of REQUIRED_PAYLOADS) {
    const entry = manifest.files[name];
    if (entry === null || typeof entry !== 'object'
      || typeof entry.sha256 !== 'string' || typeof entry.bytes !== 'number') {
      problems.push(`${name}: manifest entry malformed`);
      continue;
    }
    let bytes;
    try { bytes = readFileSync(join(dir, name), 'utf8'); } catch { problems.push(`${name}: missing`); continue; }
    if (Buffer.byteLength(bytes) !== entry.bytes) {
      problems.push(`${name}: ${Buffer.byteLength(bytes)} bytes, manifest says ${entry.bytes}`);
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== entry.sha256) problems.push(`${name}: sha256 ${actual} != ${entry.sha256}`);
    try { parsed[name] = JSON.parse(bytes); } catch { problems.push(`${name}: not JSON`); }
  }

  // Cross-check the headline metadata. Hashing the payloads proves the BYTES are intact; it says
  // nothing about whether the manifest's own summary of them is honest, and that summary is what a
  // reader looks at first.
  if (parsed['plan.json'] && manifest.plan_hash !== parsed['plan.json'].plan_hash) {
    problems.push(`manifest.plan_hash ${manifest.plan_hash} != plan.json ${parsed['plan.json'].plan_hash}`);
  }
  for (const name of ['drift.json', 'anomalies.json']) {
    if (!parsed[name]) continue;
    if (manifest.inventory_content_hash !== parsed[name].inventory_content_hash) {
      problems.push(`manifest.inventory_content_hash != ${name} inventory_content_hash`);
    }
    if (manifest.as_of !== parsed[name].as_of) problems.push(`manifest.as_of != ${name} as_of`);
  }

  return { ok: problems.length === 0, problems, manifest };
}
