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
import {
  runMembershipInventory,
  buildQueries,
  DISPOSITION_PRECEDENCE,
  EVIDENCE_PATHS,
} from './u1a-membership-inventory.mjs';

const db = new PGlite();
let fail = 0;
const ok = (m, c, x) => {
  if (c) console.log('PASS', m);
  else { fail++; console.error('FAIL', m, JSON.stringify(x ?? '')); }
};

const query = (sql, params = []) => db.query(sql, params);

// Fixed identifiers — deterministic fixtures, no random UUIDs.
const id = (tag, n) => `${tag}${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`.slice(0, 36);
const A1 = id('aaaa', 1);           // academy 1
const A2 = id('aaaa', 2);           // academy 2 (isolation)
const A_MISSING = id('aaaa', 9);    // referenced but absent → orphan
const T1 = id('7777', 1);           // trainer with a DIRECT academy slot
const T2 = id('7777', 2);           // active academy trainer with NO direct academy slot
const P = (n) => id('bbbb', n);     // profiles
const G = (n) => id('cccc', n);     // guests
const PE = (n) => id('dddd', n);    // persons
const S = (n) => id('5555', n);     // slots
const B = (n) => id('6666', n);     // bookings
const M = (n) => id('8888', n);     // metadata rows
const L = (n) => id('9999', n);     // location rows

await db.exec(`
  CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY);
  CREATE TABLE public.persons (id uuid PRIMARY KEY);
  CREATE TABLE public.guest_players (
    id uuid PRIMARY KEY, academy_profile_id uuid, trainer_id uuid,
    twin_of_profile_id uuid, linked_profile_id uuid);
  CREATE TABLE public.person_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid NOT NULL,
    profile_id uuid UNIQUE, guest_player_id uuid UNIQUE);
  CREATE TABLE public.person_merge_review (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guest_player_id uuid, kind text, status text);
  CREATE TABLE public.academy_player_metadata (
    id uuid PRIMARY KEY, academy_profile_id uuid, trainer_profile_id uuid,
    guest_player_id uuid, profile_id uuid, person_id uuid,
    notes text, tag_ids uuid[] DEFAULT '{}', billing_email text,
    removed_at timestamptz, preferred_location_id uuid);
  CREATE TABLE public.academy_player_locations (
    id uuid PRIMARY KEY, academy_profile_id uuid NOT NULL, guest_player_id uuid, profile_id uuid,
    person_id uuid, location_id uuid, dismissed boolean NOT NULL DEFAULT false);
  CREATE TABLE public.availability_slots (
    id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid, cyclus_id uuid);
  CREATE TABLE public.bookings (
    id uuid PRIMARY KEY, slot_id uuid, player_id uuid, guest_player_id uuid,
    person_id uuid, status text);
  CREATE TABLE public.academy_trainers (
    academy_profile_id uuid, trainer_profile_id uuid, status text);
  CREATE TABLE public.cycles (id uuid PRIMARY KEY, owner_type text, owner_id uuid, type text);
  CREATE TABLE public.intake_requests (
    id uuid PRIMARY KEY, cycle_id uuid, player_id uuid, guest_player_id uuid, status text);
  CREATE TABLE public.academy_locations (academy_profile_id uuid, location_id uuid);
  CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
`);

// The REAL U1a migration — the inventory reads academy_player_memberships for its state probe.
await db.exec(readFileSync('supabase/migrations/20261113100000_u1a_academy_player_memberships.sql', 'utf8')
  .replace(/^(REVOKE|GRANT)[^;]*;$/gm, '')); // PGlite has no Supabase roles; ACL is proven in the pglite test

// ── fixtures: one per terminal disposition ────────────────────────────────────────────────────
await db.exec(`
  INSERT INTO public.academy_profiles VALUES ('${A1}'), ('${A2}');
  INSERT INTO public.academy_trainers VALUES ('${A1}','${T1}','active'), ('${A1}','${T2}','active');
  INSERT INTO public.profiles  SELECT * FROM (VALUES ${[5, 7, 11, 12].map((n) => `('${P(n)}'::uuid)`).join(',')}) v;
  INSERT INTO public.persons   SELECT * FROM (VALUES ${[1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((n) => `('${PE(n)}'::uuid)`).concat([`('${PE(55)}'::uuid)`, `('${PE(77)}'::uuid)`, `('${PE(99)}'::uuid)`]).join(',')}) v;

  -- 1 eligible: academy-owned guest with one clean metadata row
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(1)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(1)}','${G(1)}');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id, notes)
    VALUES ('${M(1)}','${A1}','${G(1)}','${PE(1)}','clean');

  -- 2 wrong-target academy FK: a location row whose "academy" is really a profiles row
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(2)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(99)}','${G(2)}');
  INSERT INTO public.academy_player_locations (id, academy_profile_id, guest_player_id, person_id)
    VALUES ('${L(2)}','${P(12)}','${G(2)}','${PE(99)}');

  -- 3 orphan reference: metadata row pointing at an academy that does not exist
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(3)}','${A_MISSING}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(3)}','${G(3)}');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id)
    VALUES ('${M(3)}','${A_MISSING}','${G(3)}','${PE(3)}');

  -- 4 missing person link: academy-owned guest with NO person_links row
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(4)}','${A1}');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id)
    VALUES ('${M(4)}','${A1}','${G(4)}');

  -- 5 split-frozen: pending twin_detached_needs_split
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(5)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(5)}','${G(5)}');
  INSERT INTO public.person_merge_review (guest_player_id, kind, status)
    VALUES ('${G(5)}','twin_detached_needs_split','pending');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id)
    VALUES ('${M(5)}','${A1}','${G(5)}','${PE(5)}');

  -- 6 divergent dual-key: overview resolves by player_id, FAM-02 guest-first → different persons
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(6)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(6)}','${G(6)}');
  INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PE(55)}','${P(5)}');
  INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id) VALUES ('${S(6)}','${T1}','${A1}');
  INSERT INTO public.bookings (id, slot_id, player_id, guest_player_id, status)
    VALUES ('${B(6)}','${S(6)}','${P(5)}','${G(6)}','confirmed');

  -- 7 stale person stamp: metadata.person_id disagrees with person_links
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(7)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(7)}','${G(7)}');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id)
    VALUES ('${M(7)}','${A1}','${G(7)}','${PE(77)}');

  -- 8 bridge divergent: twin_of_profile_id resolves to a different person than the guest link
  INSERT INTO public.guest_players (id, academy_profile_id, twin_of_profile_id)
    VALUES ('${G(8)}','${A1}','${P(7)}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(8)}','${G(8)}');
  INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PE(77)}','${P(7)}');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id)
    VALUES ('${M(8)}','${A1}','${G(8)}','${PE(8)}');

  -- 9 historical unique-email auto-merge (OD-09: reviewable, never newly-verified evidence)
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(9)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(9)}','${G(9)}');
  INSERT INTO public.person_merge_review (guest_player_id, kind, status)
    VALUES ('${G(9)}','auto_merged_email_pair','applied');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id)
    VALUES ('${M(9)}','${A1}','${G(9)}','${PE(9)}');

  -- 10 both-owner guest: academy AND trainer set
  INSERT INTO public.guest_players (id, academy_profile_id, trainer_id)
    VALUES ('${G(10)}','${A1}','${T1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(10)}','${G(10)}');

  -- 11 trainer-only: trainer-owned guest, no academy owner and no direct academy evidence
  INSERT INTO public.guest_players (id, trainer_id) VALUES ('${G(11)}','${T1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(11)}','${G(11)}');

  -- 12 visibility-only: reachable ONLY through the unguarded visibility arm (E9)
  --    pending booking, trainer T2 is active for A1 but owns no DIRECT academy slot
  INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PE(12)}','${P(11)}');
  INSERT INTO public.availability_slots (id, trainer_id) VALUES ('${S(12)}','${T2}');
  INSERT INTO public.bookings (id, slot_id, player_id, status)
    VALUES ('${B(12)}','${S(12)}','${P(11)}','pending');

  -- 13 field conflict: ONE person, two metadata rows at one academy (the soft-removal split),
  --    disagreeing on notes. Also produces a canonical-pair collision (2 candidates → 1 person).
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(13)}','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(13)}','${G(13)}');
  INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PE(13)}','${P(12)}');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id, notes)
    VALUES ('${M(13)}','${A1}','${G(13)}','${PE(13)}','left wing');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, profile_id, person_id, notes)
    VALUES ('${M(14)}','${A1}','${P(12)}','${PE(13)}','right wing');

  -- 14 academy-owned cyclus cycle (E4 any status / E5 status <> cancelled) and intake (E8).
  --    The CANCELLED booking separates E4 from E5: E4 counts it, E5 must not.
  INSERT INTO public.cycles (id, owner_type, owner_id, type) VALUES ('${S(90)}','academy','${A1}','cyclus');
  INSERT INTO public.availability_slots (id, trainer_id, cyclus_id) VALUES ('${S(14)}','${T1}','${S(90)}');
  INSERT INTO public.guest_players (id) VALUES ('${G(14)}'), ('${G(15)}'), ('${G(16)}');
  INSERT INTO public.person_links (person_id, guest_player_id)
    VALUES ('${PE(14)}','${G(14)}'), ('${PE(15)}','${G(15)}'), ('${PE(16)}','${G(16)}');
  INSERT INTO public.bookings (id, slot_id, guest_player_id, status)
    VALUES ('${B(14)}','${S(14)}','${G(14)}','cancelled'),
           ('${B(15)}','${S(14)}','${G(15)}','confirmed');
  INSERT INTO public.intake_requests (id, cycle_id, guest_player_id, status)
    VALUES ('${B(16)}','${S(90)}','${G(16)}','confirmed');

  -- second academy relating to the SAME person as fixture 1 → tenant isolation, not a collision
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('${G(20)}','${A2}');
  INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PE(1)}','${G(20)}');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id, notes)
    VALUES ('${M(20)}','${A2}','${G(20)}','${PE(1)}','clean');
`);

const AS_OF = '2026-08-08T00:00:00Z';

// ── run 1 ──────────────────────────────────────────────────────────────────────────────────────
const first = await runMembershipInventory(query, { asOf: AS_OF });

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
const second = await runMembershipInventory(query, { asOf: AS_OF });
ok('two runs over unchanged data are byte-identical', first.content_hash === second.content_hash,
  { first: first.content_hash, second: second.content_hash });

// Asserted against the SQL that actually RUNS (not the file's prose): a wall-clock call would make
// two runs over unchanged data diverge, so the whole determinism contract rests on its absence.
const executedSql = Object.values(buildQueries(AS_OF))
  .map((q) => q.sql.replace(/--[^\n]*/g, ''))   // strip SQL line comments
  .join('\n');
const wallClock = executedSql.match(/\b(now\(\)|current_date|current_timestamp|localtimestamp)\b/i);
ok('executed inventory SQL contains no wall-clock call (asOf only)', wallClock === null, { wallClock });

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
const dk = first.report.divergent_dual_key[0];
ok('divergent report keeps both resolutions', dk && dk.overview_person_id === PE(55) && dk.fam02_person_id === PE(6), dk);

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

console.log(fail === 0 ? '\n✅ U1a inventory + rollback rehearsal passed' : `\n❌ ${fail} check(s) failed`);
process.exit(fail === 0 ? 0 : 1);
