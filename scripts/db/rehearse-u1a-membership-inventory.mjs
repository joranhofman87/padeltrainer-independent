/**
 * U1a GUARDRAIL — the membership inventory must be complete, deterministic and mutation-free.
 *
 * Drives `u1a-membership-inventory.mjs` against a PGlite database seeded with one fixture per
 * TERMINAL DISPOSITION, and proves the four properties the U1a design demands:
 *
 *   1. COMPLETE   — every disposition in DISPOSITION_PRECEDENCE is actually reachable. A class that
 *                   no fixture can produce is dead code pretending to be coverage.
 *   2. PARTITION  — dispositions sum to the candidate total: no candidate counted twice, none dropped.
 *                   (Evidence PATHS may overlap — that is by design and asserted separately.)
 *   3. DETERMINISTIC — two runs over unchanged data are byte-identical (same content hash), and the
 *                   engine source contains no now()/current_date.
 *   4. MUTATION-FREE — source-table fingerprints are identical before and after the read set.
 *
 * Also rehearses the U1a ROLLBACK: it must REFUSE while rows exist and succeed once empty, leaving
 * the parents and the shared update_updated_at_column() function intact.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { pgliteSessionSource } from './u1a-pglite-session.mjs';
import {
  runMembershipInventory,
  buildQueries,
  DISPOSITION_PRECEDENCE,
  EVIDENCE_PATHS,
} from './u1a-membership-inventory.mjs';
// Schema stubs, fixtures and identifiers live in a shared module so the U1b rehearsal seeds from the
// SAME universe; two hand-maintained copies would drift, and the drift would read as coverage.
import { SCHEMA_STUB_SQL, FIXTURE_SQL, AS_OF, A1, P, G, PE, B, M } from './u1a-fixture-universe.mjs';

const db = new PGlite();
let fail = 0;
const ok = (m, c, x) => {
  if (c) console.log('PASS', m);
  else { fail++; console.error('FAIL', m, JSON.stringify(x ?? '')); }
};

// The inventory owns its session through an explicit single-session adapter (executor contract);
// `query` remains only for the rehearsal's own setup/assertion SQL, never for the inventory.
const query = (sql, params = []) => db.query(sql, params);
const sessions = pgliteSessionSource(db);

await db.exec(SCHEMA_STUB_SQL);

// The REAL U1a migration — the inventory reads academy_player_memberships for its state probe.
await db.exec(readFileSync('supabase/migrations/20261113100000_u1a_academy_player_memberships.sql', 'utf8'));

// ── fixtures: one per terminal disposition (shared with the U1b rehearsal) ────────────────────
await db.exec(FIXTURE_SQL);

// ── run 1 ──────────────────────────────────────────────────────────────────────────────────────
const first = await runMembershipInventory(sessions, { asOf: AS_OF });

// 1. COMPLETE — every disposition reachable
const missing = DISPOSITION_PRECEDENCE.filter((d) => (first.disposition_counts[d] ?? 0) === 0);
ok('every terminal disposition has at least one fixture', missing.length === 0, { missing });

// 2. PARTITION — dispositions sum to the total, each candidate exactly once
const summed = Object.values(first.disposition_counts).reduce((a, b) => a + b, 0);
ok('dispositions partition the candidate universe', summed === first.total_candidates,
  { summed, total: first.total_candidates });

const seen = new Set();
let dupes = 0;
for (const r of first.report.dispositions) {
  const key = `${r.academy_profile_id}|${r.subject_kind}|${r.subject_id}`;
  if (seen.has(key)) dupes++;
  seen.add(key);
}
ok('no candidate appears twice in the disposition list', dupes === 0, { dupes });

// evidence paths MAY overlap — assert they do, so nobody "fixes" the partition by merging paths
const pathCounts = Object.fromEntries(first.report.evidence_path_counts.map((r) => [r.path, r.relationship_count]));
const pathTotal = Object.values(pathCounts).reduce((a, b) => a + b, 0);
ok('evidence paths overlap (they are NOT a partition)', pathTotal > first.total_candidates,
  { pathTotal, candidates: first.total_candidates });
ok('every declared evidence path is exercised',
  EVIDENCE_PATHS.every(([name]) => (pathCounts[name] ?? 0) > 0),
  { pathCounts });

// 3. DETERMINISTIC — a second run is byte-identical
const second = await runMembershipInventory(sessions, { asOf: AS_OF });
ok('two runs over unchanged data are byte-identical', first.content_hash === second.content_hash,
  { first: first.content_hash, second: second.content_hash });

// Asserted against the SQL that actually RUNS (not the file's prose): a wall-clock call would make
// two runs over unchanged data diverge, so the whole determinism contract rests on its absence.
const executedSql = Object.values(buildQueries(AS_OF))
  .map((q) => q.sql.replace(/--[^\n]*/g, ''))   // strip SQL line comments
  .join('\n');
// NB: no trailing \b after `now()` — `)` is a non-word char, so /\bnow\(\)\b/ never matches a call
// followed by a space. That defect made an earlier version of this guard silently vacuous.
const WALL_CLOCK = /(now\s*\(|current_date|current_timestamp|localtimestamp|clock_timestamp\s*\(|statement_timestamp\s*\(|transaction_timestamp\s*\()/i;
ok('executed inventory SQL contains no wall-clock call (asOf only)',
  !WALL_CLOCK.test(executedSql), { match: executedSql.match(WALL_CLOCK)?.[0] });
// mutation-check the guard itself: it must FAIL on SQL that does contain a wall-clock call
ok('the wall-clock guard actually catches now()', WALL_CLOCK.test('SELECT now() AS x'));

// `asOf` must be an absolute instant — 'now'/'today' are valid timestamptz inputs and would reintroduce
// wall-clock behaviour through the parameter itself.
for (const bad of ['now', 'today', 'yesterday', '', undefined]) {
  let rejected = false;
  try { await runMembershipInventory(sessions, { asOf: bad }); } catch { rejected = true; }
  ok(`asOf rejects relative/empty input ${JSON.stringify(bad)}`, rejected);
}

// 4. MUTATION-FREE — fingerprints unchanged, and the read set really is read-only
ok('source fingerprints identical before/after', first.mutation_free === true);
ok('fingerprints stable across runs',
  JSON.stringify(first.source_fingerprint_after) === JSON.stringify(second.source_fingerprint_before));

// the membership table is untouched and still empty
ok('membership table still empty after inventory',
  first.report.membership_table_state[0].existing_membership_rows === 0);

// specific classifications a reviewer would want pinned by name
const dispOf = (kind, subject) =>
  first.report.dispositions.find((r) => r.subject_kind === kind && r.subject_id === subject)?.disposition;
ok('academy-owned clean guest is eligible', dispOf('guest', G(1)) === 'eligible', { got: dispOf('guest', G(1)) });
ok('split-frozen guest is quarantined', dispOf('guest', G(5)) === 'unresolved_split_frozen', { got: dispOf('guest', G(5)) });
ok('divergent dual-key is quarantined', dispOf('guest', G(6)) === 'unresolved_divergent_dual_key', { got: dispOf('guest', G(6)) });
ok('auto-merged email pair is quarantined', dispOf('guest', G(9)) === 'unresolved_auto_merged_email_pair', { got: dispOf('guest', G(9)) });
ok('visibility-only profile is quarantined', dispOf('profile', P(11)) === 'unresolved_visibility_only', { got: dispOf('profile', P(11)) });

// the divergent report records BOTH resolutions and picks neither
const dk = first.report.divergent_dual_key.find((r) => r.booking_id === B(6));
ok('divergent report keeps both resolutions', dk && dk.overview_person_id === PE(55) && dk.fam02_person_id === PE(6), dk);

// reachable only through the academy's CYCLE scope — must still be caught
ok('cycle-only divergent dual-key is reported',
  first.report.divergent_dual_key.some((r) => r.booking_id === B(31)),
  first.report.divergent_dual_key.map((r) => r.booking_id));

// PER ROW: two bookings sharing one key pair are two facts
const samePair = first.report.divergent_dual_key.filter(
  (r) => r.player_id === P(31) && r.guest_player_id === G(31));
ok('divergent report is per-booking, not per key pair', samePair.length === 2, samePair);

// SCOPE BOUNDARY: a slot that merely SHARES the academy's cycle is cycle evidence (E4/E5) but is
// NOT booking-participant evidence (E6/E7), which the shipped reader restricts to academy-stamped slots
const cycleOnly = first.report.dispositions.find(
  (r) => r.subject_kind === 'guest' && r.subject_id === G(31) && r.academy_profile_id === A1);
ok('a cycle-shared non-academy slot yields BOTH E4 and E5 but never E6/E7',
  cycleOnly !== undefined
    && cycleOnly.paths.includes('E4_academy_owned_cycle')
    && cycleOnly.paths.includes('E5_cycle_label_booking')   // the booking is confirmed, not cancelled
    && !cycleOnly.paths.includes('E6_booking_participant')
    && !cycleOnly.paths.includes('E7_cycle_group_booking'),
  cycleOnly?.paths);

// FAM-02 fallback: guest unlinked, profile linked → the shipped stamp COALESCEs to the profile, so
// the two resolutions AGREE and the booking must be absent from the divergence report.
ok('a dual-key booking with an unlinked guest is NOT reported divergent',
  !first.report.divergent_dual_key.some((r) => r.booking_id === B(60)),
  first.report.divergent_dual_key.map((r) => r.booking_id));

// E10 suppression: soft-removed AT THIS ACADEMY drops the E10 path (the candidate survives via S1/E3)
const removedGuest = first.report.dispositions.find(
  (r) => r.subject_id === G(61) && r.academy_profile_id === A1);
ok('soft-removed academy metadata suppresses the E10 path (S1/E3 still carry the candidate)',
  removedGuest !== undefined
    && !removedGuest.paths.includes('E10_overview_guest_scope')
    && removedGuest.paths.includes('S1_metadata_row')
    && removedGuest.paths.includes('E3_guest_scope_any_status'),
  removedGuest?.paths);

// E8 counts as DIRECT academy evidence: a trainer-owned guest with academy intake is not trainer-only
const intakeGuest = first.report.dispositions.find(
  (r) => r.subject_id === G(62) && r.academy_profile_id === A1);
ok('an E8-only trainer-owned guest is not quarantined as trainer-only',
  intakeGuest !== undefined
    && intakeGuest.paths.includes('E8_intake_participant')
    && intakeGuest.disposition !== 'unresolved_trainer_only',
  intakeGuest);

// SCOPE BOUNDARY: a trainer's personal slot must not pull a subject into the academy
ok('a personal slot of an academy trainer does not create an academy candidate',
  !first.report.dispositions.some((r) => r.subject_id === G(30) && r.academy_profile_id === A1),
  first.report.dispositions.filter((r) => r.subject_id === G(30)));

// E9 guest bridge establishes a PROFILE subject (not the guest)
const bridged = first.report.dispositions.find((r) => r.subject_kind === 'profile' && r.subject_id === P(34));
ok('E9 guest bridge surfaces the PROFILE at the academy',
  bridged !== undefined && bridged.paths.includes('E9_visibility_helper'), bridged);

// cross-source overlap requires BOTH legacy sources for the same canonical pair
const overlap = first.report.duplicates_cross_source_overlap;
ok('cross-source overlap lists a person evidenced by metadata AND locations',
  overlap.some((r) => r.person_id === PE(33) && r.academy_profile_id === A1), overlap);
ok('cross-source overlap excludes metadata-only persons',
  !overlap.some((r) => r.person_id === PE(1)), overlap);

// trainer-owned metadata is reported WITH its resolution, and never taints an academy's candidate
const tom = first.report.trainer_owned_metadata_rows.find((r) => r.row_id === M(50));
ok('trainer-owned metadata is reported with subject, person and classification',
  tom !== undefined && tom.subject_id === G(1) && tom.person_id === PE(1)
    && tom.classification === 'unresolved_trainer_owned_metadata', tom);
ok('trainer-owned metadata does NOT taint the same subject at a real academy',
  dispOf('guest', G(1)) === 'eligible', { got: dispOf('guest', G(1)) });

// E4 vs E5: the cancelled-booking distinction is a real behaviour, not just a comment
const g14 = first.report.dispositions.find((r) => r.subject_id === G(14) && r.academy_profile_id === A1);
ok('E4 counts a cancelled cycle booking and E5 does not',
  g14 !== undefined && g14.paths.includes('E4_academy_owned_cycle')
    && !g14.paths.includes('E5_cycle_label_booking'), g14?.paths);

// all FOUR duplicate measures are distinct and each is exercised
ok('duplicate measure 1/4 — raw per-source multiplicity',
  first.report.duplicates_raw_multiplicity.some(
    (r) => r.source === 'academy_player_locations' && r.subject_id === G(33) && r.row_count === 2),
  first.report.duplicates_raw_multiplicity);
ok('duplicate measure 2/4 — normalized per-source evidence (exact row)',
  first.report.duplicates_normalized_per_source.some(
    (r) => r.source === 'academy_player_metadata' && r.academy_profile_id === A1
      && r.person_id === PE(13) && r.subject_count === 2),
  first.report.duplicates_normalized_per_source);
ok('duplicate measure 3/4 — cross-source overlap', overlap.length > 0);
ok('duplicate measure 4/4 — canonical pair collision',
  first.report.duplicates_canonical_pair_collision.length > 0);

// per-academy reconciliation exposes what a backfill would actually INSERT
const a1recon = first.report.per_academy_reconciliation.find((r) => r.academy_profile_id === A1);
ok('per-academy reconciliation reports eligible membership rows + collision delta',
  a1recon !== undefined && typeof a1recon.eligible_memberships === 'number'
    && typeof a1recon.collision_delta === 'number' && a1recon.collision_delta >= 0, a1recon);

// per-academy dispositions reconcile with the per-academy candidate totals
const perAcademyTotals = {};
for (const r of first.report.per_academy_dispositions) {
  perAcademyTotals[r.academy_profile_id] = (perAcademyTotals[r.academy_profile_id] ?? 0) + r.n;
}
const reconciles = first.report.per_academy_reconciliation.every(
  (r) => perAcademyTotals[r.academy_profile_id] === r.candidates);
ok('per-academy dispositions reconcile with per-academy candidate counts', reconciles,
  { perAcademyTotals, recon: first.report.per_academy_reconciliation });

// two academies, one person, independent relationships — not a duplicate
const collisions = first.report.duplicates_canonical_pair_collision;
ok('two academies sharing one Player is not a collision',
  !collisions.some((c) => c.person_id === PE(1)), collisions);
ok('one person twice at ONE academy IS a collision',
  collisions.some((c) => c.person_id === PE(13) && c.academy_profile_id === A1), collisions);

// ── rollback rehearsal ─────────────────────────────────────────────────────────────────────────
const ROLLBACK = readFileSync('scripts/rollout/u1a/sql/rollback_u1a_membership.sql', 'utf8');

await db.exec(`INSERT INTO public.academy_player_memberships (academy_profile_id, person_id)
               VALUES ('${A1}','${PE(1)}')`);
let refused = false;
try { await db.exec(ROLLBACK); } catch (e) { refused = /REFUSING to roll back U1a/.test(String(e?.message ?? e)); }
ok('rollback REFUSES while membership rows exist', refused);

await db.exec(`DELETE FROM public.academy_player_memberships`);
await db.exec(ROLLBACK);
const gone = await db.query(`SELECT to_regclass('public.academy_player_memberships') AS t`);
ok('rollback drops the table once empty', gone.rows[0].t === null, gone.rows[0]);

const survivors = await db.query(`
  SELECT to_regclass('public.academy_profiles') AS ap,
         to_regclass('public.persons') AS pe,
         (SELECT count(*)::int FROM pg_proc WHERE proname = 'update_updated_at_column') AS fn`);
ok('rollback leaves parents and the shared updated_at function intact',
  survivors.rows[0].ap !== null && survivors.rows[0].pe !== null && survivors.rows[0].fn === 1,
  survivors.rows[0]);

// re-running the rollback is a no-op, not an error (a reset after rollback must still work)
await db.exec(ROLLBACK);
ok('rollback is idempotent when the table is already absent', true);

// The emptiness guard is only sound if the lock is taken BEFORE the count and held through the DROP;
// otherwise a concurrent INSERT could land between them and be destroyed. PGlite is single-session so
// the race cannot be driven here — pin the ordering statically instead.
const lockAt = ROLLBACK.indexOf('LOCK TABLE public.academy_player_memberships IN ACCESS EXCLUSIVE MODE');
const countAt = ROLLBACK.indexOf('SELECT count(*) FROM public.academy_player_memberships');
ok('rollback locks ACCESS EXCLUSIVE before counting (no TOCTOU)',
  lockAt !== -1 && countAt !== -1 && lockAt < countAt, { lockAt, countAt });

// the COMPLETE seed (blanket grants + default privileges + deny-list) must run against the
// rolled-back schema — the deny-list is existence-guarded precisely for this
const SEED = readFileSync('supabase/seed.sql', 'utf8');
await db.exec(SEED);
ok('the FULL seed runs clean against the rolled-back (absent) table', true);

// ROLL FORWARD: re-apply the migration, then the full seed, and prove shape AND final ACL
await db.exec(readFileSync('supabase/migrations/20261113100000_u1a_academy_player_memberships.sql', 'utf8'));
await db.exec(SEED);
const restored = await db.query(`
  SELECT (SELECT count(*)::int FROM information_schema.columns
          WHERE table_name = 'academy_player_memberships') AS cols,
         (SELECT count(*)::int FROM academy_player_memberships) AS rows,
         (SELECT count(*)::int FROM pg_indexes
          WHERE tablename = 'academy_player_memberships'
            AND indexname = 'idx_academy_player_memberships_person') AS idx,
         (SELECT count(*)::int FROM pg_policies
          WHERE tablename = 'academy_player_memberships') AS policies`);
ok('roll-forward restores the exact empty shape',
  restored.rows[0].cols === 5 && restored.rows[0].rows === 0
    && restored.rows[0].idx === 1 && restored.rows[0].policies === 0,
  restored.rows[0]);

const heldAfterRollForward = await db.query(`
  SELECT r.rolname || ':' || p.priv AS held
  FROM (VALUES ('anon'),('authenticated'),('service_role'),('public')) r(rolname)
  CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
  WHERE has_table_privilege(r.rolname, 'public.academy_player_memberships', p.priv)`);
ok('roll-forward + full seed leaves the table default-deny for all four roles',
  heldAfterRollForward.rows.length === 0, heldAfterRollForward.rows);

console.log(fail === 0 ? '\n✅ U1a inventory + rollback rehearsal passed' : `\n❌ ${fail} check(s) failed`);
process.exit(fail === 0 ? 0 : 1);
