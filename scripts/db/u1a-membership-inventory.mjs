/**
 * U1a — READ-ONLY academy–Player membership inventory.
 *
 * Answers ONE question: for every academy–Player relationship the live system can derive today,
 * what would a canonical `academy_player_memberships` row be, and which candidates are NOT
 * deterministically eligible for a later backfill?
 *
 * It never writes. It never merges. It never infers identity from email or phone — every subject
 * resolves to a person EXCLUSIVELY through the existing `person_links` map. Ambiguity is
 * quarantined into a named unresolved class, never resolved by guessing (U1a design, docs branch
 * `e1ef618c:docs/FOUNDATION_EXECUTION_PLAN.md`).
 *
 * ── Two orthogonal classifications (deliberate, do not collapse them) ──────────────────────────
 *
 *   EVIDENCE PATHS (may overlap — one candidate can be reachable by several paths). Each shipped
 *   derivation path keeps its OWN exact status semantics; they are never merged into one rule,
 *   because the live readers genuinely disagree about which bookings imply a relationship.
 *
 *   TERMINAL DISPOSITIONS (a strict partition — every candidate lands in exactly ONE, by the fixed
 *   precedence in DISPOSITION_PRECEDENCE). `eligible` is the last resort: a candidate is eligible
 *   only when no unresolved condition applies.
 *
 * ── Determinism contract ──────────────────────────────────────────────────────────────────────
 *
 *   * one REPEATABLE READ, READ ONLY transaction per run (the DB itself refuses writes);
 *   * a caller-supplied fixed `asOf` instead of now()/current_date — this file contains neither
 *     (pinned by a test that greps this source);
 *   * every row-level output ordered by UUID totally (no ties, no ORDER BY on nullable text);
 *   * canonical serialization (sorted keys) + a content hash;
 *   * source-table fingerprints taken before AND after the read set, proving zero mutation.
 */

import { createHash } from 'node:crypto';

/** Bump when the output SHAPE changes; a hash comparison across versions is meaningless. */
export const INVENTORY_VERSION = 'u1a.1';

/**
 * Terminal dispositions, most-specific first. A candidate takes the FIRST one that applies, so the
 * set partitions the candidate universe. Order is a contract: it decides which unresolved reason is
 * reported when several apply, and reruns must classify identically.
 */
export const DISPOSITION_PRECEDENCE = [
  // Ordered before the generic orphan class on purpose: a location row whose academy_profile_id
  // names a `profiles` row (the shipped wrong-target FK) ALSO fails the academy-exists check, so the
  // specific diagnosis has to win or it could never be reported.
  'unresolved_wrong_target_academy_fk',
  'unresolved_orphan_reference',
  'unresolved_missing_person_link',
  'unresolved_split_frozen',
  'unresolved_divergent_dual_key',
  'unresolved_stale_person_stamp',
  'unresolved_bridge_divergent',
  'unresolved_auto_merged_email_pair',
  'unresolved_both_owner_guest',
  'unresolved_trainer_only',
  'unresolved_visibility_only',
  'unresolved_field_conflict',
  'unresolved_dismissed_only_locations',
  'eligible',
];

/** Evidence paths, with the shipped predicate each one reproduces verbatim. */
export const EVIDENCE_PATHS = [
  ['E1_booking_active_trainer', '20261006120000:118 — b.status IN (confirmed,completed), player_id NOT NULL, slot at an active academy trainer'],
  ['E2_direct_slot_academy', '20260814100000:23 — slot.academy_profile_id IS NOT NULL and equals the academy'],
  ['E3_guest_scope_any_status', '20260706130100:28 — guest owned by the academy, OR any-status booking on an academy slot, OR a metadata link'],
  ['E4_academy_owned_cycle', '20260906100000:43 — cycles.owner_type=academy AND owner_id=academy AND type=cyclus'],
  ['E5_cycle_label_booking', '20260906100000:86 — b.status <> cancelled AND (player_id IS NOT NULL OR guest_player_id IS NOT NULL)'],
  ['E6_booking_participant', '20260827100000:710 — trainers derived from DIRECTLY academy-stamped slots (not academy_trainers)'],
  ['E7_cycle_group_booking', "20260827100000:792 — b.status IN (confirmed,pending,pending_approval); profile link only where guest_player_id IS NULL"],
  ['E8_intake_participant', "20260827100000:819 — ir.status IN (confirmed,booked,pending); same guest-first link rule"],
  ['E9_visibility_helper', '20260904100000:106 — is_player_of_academy: booking arm (status NOT IN cancelled,cancelled_swap) + guest BRIDGE arm; both establish a PROFILE subject'],
  ['E10_overview_guest_scope', '20261006120000:110 — guests owned by the academy OR by one of its ACTIVE trainers (the path that surfaces trainer-owned guests)'],
];

/**
 * The legacy source tables the inventory reads. Fingerprinted before and after, so a run that
 * mutated anything is detectable even though the transaction is READ ONLY.
 */
const SOURCE_TABLES = [
  'academy_player_metadata',
  'academy_player_locations',
  'guest_players',
  'person_links',
  'persons',
  'person_merge_review',
  'bookings',
  'availability_slots',
  'academy_trainers',
  'cycles',
  'intake_requests',
  'academy_profiles',
  'profiles',
  'academy_locations',
];

/**
 * The candidate universe + every fact each candidate needs for classification.
 *
 * A CANDIDATE is one (academy_profile_id, subject_kind, subject_id) pair — the legacy shape of "this
 * academy relates to this human". Subjects are guests or profiles, never a person id: the person is
 * a RESULT of person_links resolution, and its absence is itself a reportable disposition.
 */
const CANDIDATE_SQL = /* sql */ `
WITH
-- ── academy trainer sets (active only — the shipped readers all require status='active') ────────
active_trainers AS (
  SELECT at.academy_profile_id, at.trainer_profile_id
  FROM academy_trainers at
  WHERE at.status = 'active'
),
-- slots reachable by an academy: directly stamped, or run by one of its active trainers
academy_slots AS (
  SELECT s.id AS slot_id, s.academy_profile_id AS direct_academy_id, s.trainer_id, s.cyclus_id
  FROM availability_slots s
),
slot_academy AS (
  SELECT sl.slot_id, sl.direct_academy_id AS academy_profile_id, true AS is_direct, sl.cyclus_id
  FROM academy_slots sl
  WHERE sl.direct_academy_id IS NOT NULL
  UNION ALL
  SELECT sl.slot_id, t.academy_profile_id, false AS is_direct, sl.cyclus_id
  FROM academy_slots sl
  JOIN active_trainers t ON t.trainer_profile_id = sl.trainer_id
),
-- 20260827100000:715-724 scopes by CYCLE, not by trainer: cycles the academy owns, UNION cycles
-- reached through a DIRECTLY academy-stamped slot. Reproduced exactly — an earlier draft expanded to
-- "every slot of a trainer who has one direct academy slot", which wrongly swept in that trainer's
-- personal and other-academy slots.
academy_cycles AS (
  SELECT c.id AS cycle_id, c.owner_id AS academy_profile_id
  FROM cycles c
  WHERE c.owner_type = 'academy'
  UNION
  SELECT sl.cyclus_id, sl.direct_academy_id
  FROM academy_slots sl
  WHERE sl.direct_academy_id IS NOT NULL AND sl.cyclus_id IS NOT NULL
),
academy_cycle_slots AS (
  SELECT ac.academy_profile_id, sl.slot_id
  FROM academy_cycles ac
  JOIN academy_slots sl ON sl.cyclus_id = ac.cycle_id
),

-- ── raw source rows ─────────────────────────────────────────────────────────────────────────────
meta AS (SELECT m.* FROM academy_player_metadata m),
loc  AS (SELECT l.* FROM academy_player_locations l),
gp   AS (SELECT g.* FROM guest_players g),

-- ── evidence: each path emits (academy_profile_id, subject_kind, subject_id) ────────────────────
-- E1 — booking at an active academy trainer, confirmed/completed, player_id set (dual-key included)
e1 AS (
  SELECT sa.academy_profile_id, 'profile'::text AS subject_kind, b.player_id AS subject_id
  FROM bookings b
  JOIN slot_academy sa ON sa.slot_id = b.slot_id AND sa.is_direct = false
  WHERE b.player_id IS NOT NULL AND b.status IN ('confirmed','completed')
),
-- E2 — slot directly stamped with the academy (any booking subject on it)
e2 AS (
  SELECT sa.academy_profile_id,
         CASE WHEN b.guest_player_id IS NOT NULL THEN 'guest' ELSE 'profile' END AS subject_kind,
         COALESCE(b.guest_player_id, b.player_id) AS subject_id
  FROM bookings b
  JOIN slot_academy sa ON sa.slot_id = b.slot_id AND sa.is_direct = true
  WHERE b.guest_player_id IS NOT NULL OR b.player_id IS NOT NULL
),
-- E3 — guest academy scope: direct ownership | ANY-status booking on an academy slot | metadata link
e3 AS (
  SELECT g.academy_profile_id, 'guest'::text, g.id FROM gp g WHERE g.academy_profile_id IS NOT NULL
  UNION ALL
  SELECT sa.academy_profile_id, 'guest'::text, b.guest_player_id
  FROM bookings b JOIN slot_academy sa ON sa.slot_id = b.slot_id AND sa.is_direct = true
  WHERE b.guest_player_id IS NOT NULL
  UNION ALL
  SELECT m.academy_profile_id, 'guest'::text, m.guest_player_id
  FROM meta m WHERE m.guest_player_id IS NOT NULL AND m.academy_profile_id IS NOT NULL
),
-- E4 — academy-owned cyclus cycles → subjects booked into their slots
e4 AS (
  SELECT c.owner_id AS academy_profile_id,
         CASE WHEN b.guest_player_id IS NOT NULL THEN 'guest' ELSE 'profile' END,
         COALESCE(b.guest_player_id, b.player_id)
  FROM cycles c
  JOIN academy_slots sl ON sl.cyclus_id = c.id
  JOIN bookings b ON b.slot_id = sl.slot_id
  WHERE c.owner_type = 'academy' AND c.type = 'cyclus'
    AND (b.guest_player_id IS NOT NULL OR b.player_id IS NOT NULL)
),
-- E5 — cycle-label predicate: status <> cancelled
e5 AS (
  SELECT c.owner_id AS academy_profile_id,
         CASE WHEN b.guest_player_id IS NOT NULL THEN 'guest' ELSE 'profile' END,
         COALESCE(b.guest_player_id, b.player_id)
  FROM cycles c
  JOIN academy_slots sl ON sl.cyclus_id = c.id
  JOIN bookings b ON b.slot_id = sl.slot_id
  WHERE c.owner_type = 'academy' AND c.type = 'cyclus'
    AND b.status <> 'cancelled'
    AND (b.player_id IS NOT NULL OR b.guest_player_id IS NOT NULL)
),
-- E6 — booking participants on slots of the academy's cycle scope
e6 AS (
  SELECT acs.academy_profile_id,
         CASE WHEN b.guest_player_id IS NOT NULL THEN 'guest' ELSE 'profile' END,
         COALESCE(b.guest_player_id, b.player_id)
  FROM bookings b JOIN academy_cycle_slots acs ON acs.slot_id = b.slot_id
  WHERE b.guest_player_id IS NOT NULL OR b.player_id IS NOT NULL
),
-- E7 — cycle-group bookings: confirmed|pending|pending_approval, profile arm only when guest IS NULL
e7 AS (
  SELECT acs.academy_profile_id, 'guest'::text, b.guest_player_id
  FROM bookings b JOIN academy_cycle_slots acs ON acs.slot_id = b.slot_id
  WHERE b.status IN ('confirmed','pending','pending_approval') AND b.guest_player_id IS NOT NULL
  UNION ALL
  SELECT acs.academy_profile_id, 'profile'::text, b.player_id
  FROM bookings b JOIN academy_cycle_slots acs ON acs.slot_id = b.slot_id
  WHERE b.status IN ('confirmed','pending','pending_approval')
    AND b.player_id IS NOT NULL AND b.guest_player_id IS NULL
),
-- E8 — intake participants: confirmed|booked|pending, same guest-first link rule, over the SAME
--      cycle scope as E6/E7 (academy-owned cycles UNION cycles reached via direct academy slots)
e8 AS (
  SELECT ac.academy_profile_id, 'guest'::text, ir.guest_player_id
  FROM intake_requests ir JOIN academy_cycles ac ON ac.cycle_id = ir.cycle_id
  WHERE ir.status IN ('confirmed','booked','pending') AND ir.guest_player_id IS NOT NULL
  UNION ALL
  SELECT ac.academy_profile_id, 'profile'::text, ir.player_id
  FROM intake_requests ir JOIN academy_cycles ac ON ac.cycle_id = ir.cycle_id
  WHERE ir.status IN ('confirmed','booked','pending')
    AND ir.player_id IS NOT NULL AND ir.guest_player_id IS NULL
),
-- E9 — is_player_of_academy(profile, academy): both arms establish visibility of a PROFILE, so both
--      emit PROFILE subjects. The guest arm is a BRIDGE (twin precedence, else linked, else shared
--      person_links) — it does not make the guest itself the subject; E3 already covers scoped guests.
e9 AS (
  -- (1) booking at one of the academy's active trainers
  SELECT t.academy_profile_id, 'profile'::text, b.player_id
  FROM bookings b
  JOIN academy_slots sl ON sl.slot_id = b.slot_id
  JOIN active_trainers t ON t.trainer_profile_id = sl.trainer_id
  WHERE b.player_id IS NOT NULL
    AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled','cancelled_swap')
  UNION ALL
  -- (2) a guest in academy scope tied to this profile; split-frozen guests grant nothing
  SELECT a.academy_profile_id, 'profile'::text, pr.id
  FROM gp g
  JOIN profiles pr ON (
        g.twin_of_profile_id = pr.id
     OR (g.twin_of_profile_id IS NULL AND g.linked_profile_id = pr.id)
     OR EXISTS (
          SELECT 1 FROM person_links plg
          JOIN person_links plp ON plp.person_id = plg.person_id
          WHERE plg.guest_player_id = g.id AND plp.profile_id = pr.id)
  )
  CROSS JOIN LATERAL (
    SELECT g.academy_profile_id AS academy_profile_id WHERE g.academy_profile_id IS NOT NULL
    UNION
    SELECT t.academy_profile_id FROM active_trainers t WHERE t.trainer_profile_id = g.trainer_id
  ) a
  WHERE NOT EXISTS (
    SELECT 1 FROM person_merge_review r
    WHERE r.guest_player_id = g.id AND r.status = 'pending'
      AND r.kind IN ('twin_detached_needs_split','merged_guest_email_moved')
  )
),
-- E10 — the players-overview guest scope: academy-owned OR owned by an ACTIVE academy trainer.
--       Distinct from E3 (which is academy-direct only) and the reason a trainer-owned guest is
--       visible at an academy at all — without it those guests would never be inventoried.
e10 AS (
  SELECT g.academy_profile_id, 'guest'::text, g.id FROM gp g WHERE g.academy_profile_id IS NOT NULL
  UNION ALL
  SELECT t.academy_profile_id, 'guest'::text, g.id
  FROM gp g JOIN active_trainers t ON t.trainer_profile_id = g.trainer_id
),
-- source-table classes (the legacy overlay rows themselves are candidates too)
s_meta AS (
  SELECT m.academy_profile_id,
         CASE WHEN m.guest_player_id IS NOT NULL THEN 'guest' ELSE 'profile' END AS subject_kind,
         COALESCE(m.guest_player_id, m.profile_id) AS subject_id
  FROM meta m
  WHERE m.academy_profile_id IS NOT NULL
    AND (m.guest_player_id IS NOT NULL OR m.profile_id IS NOT NULL)
),
s_loc AS (
  SELECT l.academy_profile_id,
         CASE WHEN l.guest_player_id IS NOT NULL THEN 'guest' ELSE 'profile' END,
         COALESCE(l.guest_player_id, l.profile_id)
  FROM loc l
  WHERE l.guest_player_id IS NOT NULL OR l.profile_id IS NOT NULL
),
evidence AS (
  SELECT 'E1_booking_active_trainer' AS path, * FROM e1
  UNION ALL SELECT 'E2_direct_slot_academy', * FROM e2
  UNION ALL SELECT 'E3_guest_scope_any_status', * FROM e3
  UNION ALL SELECT 'E4_academy_owned_cycle', * FROM e4
  UNION ALL SELECT 'E5_cycle_label_booking', * FROM e5
  UNION ALL SELECT 'E6_booking_participant', * FROM e6
  UNION ALL SELECT 'E7_cycle_group_booking', * FROM e7
  UNION ALL SELECT 'E8_intake_participant', * FROM e8
  UNION ALL SELECT 'E9_visibility_helper', * FROM e9
  UNION ALL SELECT 'E10_overview_guest_scope', * FROM e10
  UNION ALL SELECT 'S1_metadata_row', * FROM s_meta
  UNION ALL SELECT 'S2_location_row', * FROM s_loc
),
evidence_clean AS (
  SELECT * FROM evidence WHERE academy_profile_id IS NOT NULL AND subject_id IS NOT NULL
),
candidates AS (
  SELECT academy_profile_id, subject_kind, subject_id,
         array_agg(DISTINCT path ORDER BY path) AS paths
  FROM evidence_clean
  GROUP BY academy_profile_id, subject_kind, subject_id
),

-- ── person resolution — person_links ONLY, guest-first (FAM-02). No email/phone inference. ──────
resolved AS (
  SELECT c.*,
         CASE WHEN c.subject_kind = 'guest'
              THEN (SELECT pl.person_id FROM person_links pl WHERE pl.guest_player_id = c.subject_id)
              ELSE (SELECT pl.person_id FROM person_links pl WHERE pl.profile_id = c.subject_id)
         END AS person_id
  FROM candidates c
),

-- ── relationship field values, normalized per (academy, person, field) ─────────────────────────
-- Sources: academy-owned metadata rows AND the per-owner fields on academy-owned guest rows (a guest
-- IS an owner-scoped relationship record). tag_ids is compared as a SORTED SET — comparing the array
-- literal would report {a,b} vs {b,a} as a conflict.
conflict_values AS (
  SELECT m.academy_profile_id,
         COALESCE(
           (SELECT pl.person_id FROM person_links pl WHERE pl.guest_player_id = m.guest_player_id),
           (SELECT pl.person_id FROM person_links pl WHERE pl.profile_id = m.profile_id)
         ) AS person_id,
         f.field, f.val
  FROM meta m
  CROSS JOIN LATERAL (VALUES
    ('notes', m.notes),
    ('tag_ids', (SELECT COALESCE(string_agg(t::text, ',' ORDER BY t::text), '')
                 FROM unnest(COALESCE(m.tag_ids, '{}'::uuid[])) AS t)),
    ('billing_email', m.billing_email),
    ('removal_state', (m.removed_at IS NOT NULL)::text),
    ('trainer_assignment', m.trainer_profile_id::text),
    ('preferred_location', m.preferred_location_id::text)
  ) AS f(field, val)
  WHERE m.academy_profile_id IS NOT NULL AND f.val IS NOT NULL
  UNION ALL
  SELECT g.academy_profile_id,
         (SELECT pl.person_id FROM person_links pl WHERE pl.guest_player_id = g.id),
         f.field, f.val
  FROM gp g
  CROSS JOIN LATERAL (VALUES
    ('notes', g.notes),
    ('preferred_location', g.preferred_location_id::text)
  ) AS f(field, val)
  WHERE g.academy_profile_id IS NOT NULL AND f.val IS NOT NULL
),

-- ── per-candidate classification facts ─────────────────────────────────────────────────────────
facts AS (
  SELECT r.*,
    -- the academy reference must exist (metadata carries NO FK; locations point at the WRONG table)
    EXISTS (SELECT 1 FROM academy_profiles ap WHERE ap.id = r.academy_profile_id) AS academy_exists,
    -- subject row must exist
    CASE WHEN r.subject_kind = 'guest'
         THEN EXISTS (SELECT 1 FROM gp g WHERE g.id = r.subject_id)
         ELSE EXISTS (SELECT 1 FROM profiles p WHERE p.id = r.subject_id)
    END AS subject_exists,
    -- split-frozen: pending twin_detached_needs_split / merged_guest_email_moved
    CASE WHEN r.subject_kind = 'guest' THEN EXISTS (
      SELECT 1 FROM person_merge_review m
      WHERE m.guest_player_id = r.subject_id AND m.status = 'pending'
        AND m.kind IN ('twin_detached_needs_split','merged_guest_email_moved')
    ) ELSE false END AS split_frozen,
    -- historical unique-email auto-merge (OD-09: intact + reviewable, never newly-verified evidence)
    CASE WHEN r.subject_kind = 'guest' THEN EXISTS (
      SELECT 1 FROM person_merge_review m
      WHERE m.guest_player_id = r.subject_id AND m.kind = 'auto_merged_email_pair'
    ) ELSE false END AS auto_merged_email_pair,
    -- guest owned by BOTH an academy and a trainer
    CASE WHEN r.subject_kind = 'guest' THEN EXISTS (
      SELECT 1 FROM gp g
      WHERE g.id = r.subject_id AND g.academy_profile_id IS NOT NULL AND g.trainer_id IS NOT NULL
    ) ELSE false END AS both_owner_guest,
    -- twin/linked bridge disagrees with person_links
    CASE WHEN r.subject_kind = 'guest' THEN EXISTS (
      SELECT 1 FROM gp g
      WHERE g.id = r.subject_id
        AND COALESCE(g.twin_of_profile_id, g.linked_profile_id) IS NOT NULL
        AND (SELECT pl.person_id FROM person_links pl WHERE pl.guest_player_id = g.id) IS DISTINCT FROM
            (SELECT pl2.person_id FROM person_links pl2
             WHERE pl2.profile_id = COALESCE(g.twin_of_profile_id, g.linked_profile_id))
    ) ELSE false END AS bridge_divergent,
    -- stale stamp: a source row's stored person_id disagrees with person_links
    EXISTS (
      SELECT 1 FROM meta m
      WHERE m.academy_profile_id = r.academy_profile_id
        AND ((r.subject_kind = 'guest' AND m.guest_player_id = r.subject_id)
          OR (r.subject_kind = 'profile' AND m.profile_id = r.subject_id))
        AND m.person_id IS DISTINCT FROM r.person_id
        AND m.person_id IS NOT NULL
    ) OR EXISTS (
      SELECT 1 FROM loc l
      WHERE l.academy_profile_id = r.academy_profile_id
        AND ((r.subject_kind = 'guest' AND l.guest_player_id = r.subject_id)
          OR (r.subject_kind = 'profile' AND l.profile_id = r.subject_id))
        AND l.person_id IS DISTINCT FROM r.person_id
        AND l.person_id IS NOT NULL
    ) AS stale_person_stamp,
    -- reachable ONLY through the deliberately unguarded visibility arms: E9 and nothing else
    (r.paths = ARRAY['E9_visibility_helper']) AS visibility_only,
    -- trainer-only association: a trainer-OWNED guest (no academy owner) with no direct academy
    -- evidence. Trainer-owned METADATA rows are deliberately NOT folded in here: the owner CHECK is
    -- XOR, so those rows carry academy_profile_id = NULL and cannot be scoped to an academy — an
    -- unscoped EXISTS would taint every candidate for that subject at every OTHER academy. They get
    -- their own report (trainer_owned_metadata_rows) instead.
    (r.subject_kind = 'guest' AND EXISTS (
        SELECT 1 FROM gp g
        WHERE g.id = r.subject_id AND g.trainer_id IS NOT NULL AND g.academy_profile_id IS NULL)
      AND NOT (r.paths && ARRAY['E2_direct_slot_academy','E3_guest_scope_any_status',
                                'E4_academy_owned_cycle','S1_metadata_row','S2_location_row'])
    ) AS trainer_only,
    -- location rows whose academy_profile_id does not name a real academy (WRONG-target FK: profiles)
    EXISTS (
      SELECT 1 FROM loc l
      WHERE l.academy_profile_id = r.academy_profile_id
        AND ((r.subject_kind = 'guest' AND l.guest_player_id = r.subject_id)
          OR (r.subject_kind = 'profile' AND l.profile_id = r.subject_id))
        AND NOT EXISTS (SELECT 1 FROM academy_profiles ap WHERE ap.id = l.academy_profile_id)
    ) AS wrong_target_academy_fk,
    -- every location row for this candidate is dismissed
    (EXISTS (
      SELECT 1 FROM loc l WHERE l.academy_profile_id = r.academy_profile_id
        AND ((r.subject_kind = 'guest' AND l.guest_player_id = r.subject_id)
          OR (r.subject_kind = 'profile' AND l.profile_id = r.subject_id))
     ) AND NOT EXISTS (
      SELECT 1 FROM loc l WHERE l.academy_profile_id = r.academy_profile_id
        AND ((r.subject_kind = 'guest' AND l.guest_player_id = r.subject_id)
          OR (r.subject_kind = 'profile' AND l.profile_id = r.subject_id))
        AND l.dismissed = false
     )) AS dismissed_only_locations,
    -- Field conflict is a PERSON-level property, not a row-level one: the partial unique indexes on
    -- academy_player_metadata make two rows per (academy, SAME key) impossible, so a conflict can only
    -- arise across the guest-keyed and profile-keyed rows of ONE person at ONE academy (exactly what
    -- the soft-removal split produces).
    (r.person_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM conflict_values cv
      WHERE cv.academy_profile_id = r.academy_profile_id AND cv.person_id = r.person_id
      GROUP BY cv.field
      HAVING count(DISTINCT cv.val) > 1
    )) AS field_conflict
  FROM resolved r
),
-- ── divergent dual-key: the overview reader resolves by player_id, FAM-02 stamps guest-first ─────
-- PER ROW (booking_id retained — two bookings with the same key pair are two facts, not one) and over
-- EVERY booking evidence path, so a booking visible only through the academy's cycle scope counts too.
academy_bookings AS (
  SELECT sa.academy_profile_id, b.id AS booking_id, b.player_id, b.guest_player_id
  FROM bookings b JOIN slot_academy sa ON sa.slot_id = b.slot_id
  UNION
  SELECT acs.academy_profile_id, b.id, b.player_id, b.guest_player_id
  FROM bookings b JOIN academy_cycle_slots acs ON acs.slot_id = b.slot_id
),
dual_key AS (
  SELECT ab.academy_profile_id, ab.booking_id, ab.player_id, ab.guest_player_id,
         (SELECT pl.person_id FROM person_links pl WHERE pl.profile_id = ab.player_id) AS overview_person_id,
         (SELECT pl.person_id FROM person_links pl WHERE pl.guest_player_id = ab.guest_player_id) AS fam02_person_id
  FROM academy_bookings ab
  WHERE ab.player_id IS NOT NULL AND ab.guest_player_id IS NOT NULL
),
divergent AS (
  SELECT * FROM dual_key
  WHERE overview_person_id IS DISTINCT FROM fam02_person_id
)
`;

/**
 * Ordered, canonical query set. Every statement is a SELECT; the transaction is READ ONLY.
 * Exported so a rehearsal can assert the property on the SQL that ACTUALLY RUNS (no wall-clock
 * calls) rather than on this file's prose.
 */
export function buildQueries(asOf) {
  return {
    dispositions: {
      sql: `${CANDIDATE_SQL}
        SELECT f.academy_profile_id, f.subject_kind, f.subject_id, f.person_id, f.paths,
          CASE
            WHEN f.wrong_target_academy_fk THEN 'unresolved_wrong_target_academy_fk'
            WHEN NOT f.subject_exists OR NOT f.academy_exists THEN 'unresolved_orphan_reference'
            WHEN f.person_id IS NULL THEN 'unresolved_missing_person_link'
            WHEN f.split_frozen THEN 'unresolved_split_frozen'
            WHEN EXISTS (SELECT 1 FROM divergent d
                         WHERE d.academy_profile_id = f.academy_profile_id
                           AND ((f.subject_kind = 'guest' AND d.guest_player_id = f.subject_id)
                             OR (f.subject_kind = 'profile' AND d.player_id = f.subject_id)))
              THEN 'unresolved_divergent_dual_key'
            WHEN f.stale_person_stamp THEN 'unresolved_stale_person_stamp'
            WHEN f.bridge_divergent THEN 'unresolved_bridge_divergent'
            WHEN f.auto_merged_email_pair THEN 'unresolved_auto_merged_email_pair'
            WHEN f.both_owner_guest THEN 'unresolved_both_owner_guest'
            WHEN f.trainer_only THEN 'unresolved_trainer_only'
            WHEN f.visibility_only THEN 'unresolved_visibility_only'
            WHEN f.field_conflict THEN 'unresolved_field_conflict'
            WHEN f.dismissed_only_locations THEN 'unresolved_dismissed_only_locations'
            ELSE 'eligible'
          END AS disposition
        FROM facts f
        ORDER BY f.academy_profile_id, f.subject_kind, f.subject_id`,
    },
    evidence_path_counts: {
      sql: `${CANDIDATE_SQL}
        SELECT path, count(*)::int AS relationship_count
        FROM (SELECT DISTINCT path, academy_profile_id, subject_kind, subject_id FROM evidence_clean) e
        GROUP BY path ORDER BY path`,
    },
    // Duplicate taxonomy — FOUR distinct measures, never conflated (U1a design).
    duplicates_raw_multiplicity: {
      sql: `${CANDIDATE_SQL}
        SELECT 'academy_player_metadata' AS source, m.academy_profile_id,
               COALESCE(m.guest_player_id, m.profile_id) AS subject_id, count(*)::int AS row_count
        FROM meta m WHERE m.academy_profile_id IS NOT NULL
        GROUP BY 1,2,3 HAVING count(*) > 1
        UNION ALL
        SELECT 'academy_player_locations', l.academy_profile_id,
               COALESCE(l.guest_player_id, l.profile_id), count(*)::int
        FROM loc l GROUP BY 1,2,3 HAVING count(*) > 1
        ORDER BY 1,2,3`,
    },
    duplicates_normalized_per_source: {
      sql: `${CANDIDATE_SQL}
        SELECT source, academy_profile_id, person_id, count(*)::int AS subject_count
        FROM (
          SELECT 'academy_player_metadata' AS source, m.academy_profile_id,
                 COALESCE(
                   (SELECT pl.person_id FROM person_links pl WHERE pl.guest_player_id = m.guest_player_id),
                   (SELECT pl.person_id FROM person_links pl WHERE pl.profile_id = m.profile_id)
                 ) AS person_id,
                 COALESCE(m.guest_player_id, m.profile_id) AS subject_id
          FROM meta m WHERE m.academy_profile_id IS NOT NULL
          UNION
          SELECT 'academy_player_locations', l.academy_profile_id,
                 COALESCE(
                   (SELECT pl.person_id FROM person_links pl WHERE pl.guest_player_id = l.guest_player_id),
                   (SELECT pl.person_id FROM person_links pl WHERE pl.profile_id = l.profile_id)
                 ),
                 COALESCE(l.guest_player_id, l.profile_id)
          FROM loc l
        ) x
        WHERE person_id IS NOT NULL
        GROUP BY source, academy_profile_id, person_id
        HAVING count(*) > 1
        ORDER BY source, academy_profile_id, person_id`,
    },
    // Cross-source overlap = the SAME canonical pair evidenced by BOTH legacy sources (whether by one
    // subject or two). Distinct from raw multiplicity (one source, many rows) and from canonical-pair
    // collision (many candidates, any source).
    duplicates_cross_source_overlap: {
      sql: `${CANDIDATE_SQL}
        SELECT f.academy_profile_id, f.person_id,
               count(DISTINCT f.subject_id)::int AS subject_count
        FROM facts f
        WHERE f.person_id IS NOT NULL
        GROUP BY f.academy_profile_id, f.person_id
        HAVING bool_or(f.paths && ARRAY['S1_metadata_row'])
           AND bool_or(f.paths && ARRAY['S2_location_row'])
        ORDER BY f.academy_profile_id, f.person_id`,
    },
    duplicates_canonical_pair_collision: {
      sql: `${CANDIDATE_SQL}
        SELECT f.academy_profile_id, f.person_id, count(*)::int AS candidate_count
        FROM facts f
        WHERE f.person_id IS NOT NULL
        GROUP BY f.academy_profile_id, f.person_id
        HAVING count(*) > 1
        ORDER BY f.academy_profile_id, f.person_id`,
    },
    // Person-level: the partial unique indexes forbid two rows per (academy, same key), so a conflict
    // is only ever between the guest-keyed and profile-keyed rows of ONE person at ONE academy.
    field_conflicts: {
      sql: `${CANDIDATE_SQL}
        SELECT academy_profile_id, person_id, field, distinct_values
        FROM (
          SELECT m.academy_profile_id,
                 COALESCE(
                   (SELECT pl.person_id FROM person_links pl WHERE pl.guest_player_id = m.guest_player_id),
                   (SELECT pl.person_id FROM person_links pl WHERE pl.profile_id = m.profile_id)
                 ) AS person_id,
                 f.field, count(DISTINCT f.val)::int AS distinct_values
          FROM meta m
          CROSS JOIN LATERAL (VALUES
            ('notes', m.notes),
            ('tag_ids', m.tag_ids::text),
            ('billing_email', m.billing_email),
            ('removal_state', (m.removed_at IS NOT NULL)::text),
            ('trainer_assignment', m.trainer_profile_id::text),
            ('preferred_location', m.preferred_location_id::text)
          ) AS f(field, val)
          WHERE m.academy_profile_id IS NOT NULL AND f.val IS NOT NULL
          GROUP BY 1,2,3
        ) x
        WHERE distinct_values > 1 AND person_id IS NOT NULL
        ORDER BY academy_profile_id, person_id, field`,
    },
    divergent_dual_key: {
      sql: `${CANDIDATE_SQL}
        SELECT academy_profile_id, booking_id, player_id, guest_player_id,
               overview_person_id, fam02_person_id
        FROM divergent
        ORDER BY academy_profile_id, booking_id`,
    },
    trainer_owned_metadata_rows: {
      sql: `${CANDIDATE_SQL}
        SELECT m.id AS row_id, m.trainer_profile_id,
               COALESCE(m.guest_player_id, m.profile_id) AS subject_id
        FROM meta m WHERE m.trainer_profile_id IS NOT NULL
        ORDER BY m.id`,
    },
    dismissed_only_locations: {
      sql: `${CANDIDATE_SQL}
        SELECT l.academy_profile_id, COALESCE(l.guest_player_id, l.profile_id) AS subject_id
        FROM loc l
        GROUP BY 1, 2
        HAVING bool_and(l.dismissed)
        ORDER BY 1, 2`,
    },
    orphans: {
      sql: `${CANDIDATE_SQL}
        SELECT 'metadata_academy_missing' AS kind, m.id AS row_id
        FROM meta m
        WHERE m.academy_profile_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM academy_profiles ap WHERE ap.id = m.academy_profile_id)
        UNION ALL
        SELECT 'location_academy_missing', l.id
        FROM loc l
        WHERE NOT EXISTS (SELECT 1 FROM academy_profiles ap WHERE ap.id = l.academy_profile_id)
        ORDER BY 1, 2`,
    },
    cross_tenant_anomalies: {
      sql: `${CANDIDATE_SQL}
        SELECT 'metadata_preferred_location_foreign' AS kind, m.id AS row_id
        FROM meta m
        WHERE m.preferred_location_id IS NOT NULL AND m.academy_profile_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM academy_locations al
            WHERE al.location_id = m.preferred_location_id AND al.academy_profile_id = m.academy_profile_id)
        UNION ALL
        SELECT 'guest_trainer_not_in_academy', g.id
        FROM gp g
        WHERE g.academy_profile_id IS NOT NULL AND g.trainer_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM active_trainers t
            WHERE t.trainer_profile_id = g.trainer_id AND t.academy_profile_id = g.academy_profile_id)
        ORDER BY 1, 2`,
    },
    missing_person_stamp_rows: {
      sql: `${CANDIDATE_SQL}
        SELECT 'academy_player_metadata' AS source, m.id AS row_id FROM meta m WHERE m.person_id IS NULL
        UNION ALL
        SELECT 'academy_player_locations', l.id FROM loc l WHERE l.person_id IS NULL
        ORDER BY 1, 2`,
    },
    per_academy_reconciliation: {
      sql: `${CANDIDATE_SQL}
        SELECT f.academy_profile_id,
               count(*)::int AS candidates,
               count(*) FILTER (WHERE f.person_id IS NOT NULL)::int AS with_person,
               count(DISTINCT f.person_id)::int AS distinct_persons
        FROM facts f
        GROUP BY f.academy_profile_id
        ORDER BY f.academy_profile_id`,
    },
    // Per-academy × disposition: the reconciliation the later backfill is checked against. Summing
    // `n` within an academy must reproduce that academy's `candidates` above.
    per_academy_dispositions: {
      sql: `${CANDIDATE_SQL}
        SELECT f.academy_profile_id, d.disposition, count(*)::int AS n
        FROM facts f
        CROSS JOIN LATERAL (SELECT
          CASE
            WHEN f.wrong_target_academy_fk THEN 'unresolved_wrong_target_academy_fk'
            WHEN NOT f.subject_exists OR NOT f.academy_exists THEN 'unresolved_orphan_reference'
            WHEN f.person_id IS NULL THEN 'unresolved_missing_person_link'
            WHEN f.split_frozen THEN 'unresolved_split_frozen'
            WHEN EXISTS (SELECT 1 FROM divergent dv
                         WHERE dv.academy_profile_id = f.academy_profile_id
                           AND ((f.subject_kind = 'guest' AND dv.guest_player_id = f.subject_id)
                             OR (f.subject_kind = 'profile' AND dv.player_id = f.subject_id)))
              THEN 'unresolved_divergent_dual_key'
            WHEN f.stale_person_stamp THEN 'unresolved_stale_person_stamp'
            WHEN f.bridge_divergent THEN 'unresolved_bridge_divergent'
            WHEN f.auto_merged_email_pair THEN 'unresolved_auto_merged_email_pair'
            WHEN f.both_owner_guest THEN 'unresolved_both_owner_guest'
            WHEN f.trainer_only THEN 'unresolved_trainer_only'
            WHEN f.visibility_only THEN 'unresolved_visibility_only'
            WHEN f.field_conflict THEN 'unresolved_field_conflict'
            WHEN f.dismissed_only_locations THEN 'unresolved_dismissed_only_locations'
            ELSE 'eligible'
          END AS disposition) d
        GROUP BY f.academy_profile_id, d.disposition
        ORDER BY f.academy_profile_id, d.disposition`,
    },
    membership_table_state: {
      sql: `SELECT count(*)::int AS existing_membership_rows FROM public.academy_player_memberships`,
    },
    as_of_echo: { sql: `SELECT $1::timestamptz AS as_of`, params: [asOf] },
  };
}

/** Stable stringify: object keys sorted at every depth, so the hash depends on VALUES only. */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

export function contentHash(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/** Backend process id, used to prove every statement ran on ONE session. null if unavailable. */
async function backendPid(query) {
  try {
    const { rows } = await query('SELECT pg_backend_pid() AS pid');
    return rows[0]?.pid ?? null;
  } catch {
    return null; // engines without pg_backend_pid: the check degrades, the run does not
  }
}

/** md5 fingerprint per source table: row count + content digest, both order-independent. */
async function fingerprintSources(query) {
  const out = {};
  for (const table of SOURCE_TABLES) {
    const { rows } = await query(
      `SELECT count(*)::int AS n,
              COALESCE(md5(string_agg(t.digest, '' ORDER BY t.digest)), '') AS digest
       FROM (SELECT md5(x::text) AS digest FROM public.${table} x) t`,
    );
    out[table] = { rows: rows[0].n, digest: rows[0].digest };
  }
  return out;
}

/**
 * Run the inventory.
 *
 * @param {(sql: string, params?: unknown[]) => Promise<{rows: any[]}>} query
 * @param {{ asOf: string }} options  `asOf` is REQUIRED and fixed by the caller — the inventory
 *        contains no now()/current_date, so two runs over unchanged data are byte-identical.
 */
export async function runMembershipInventory(query, { asOf } = {}) {
  // An ABSOLUTE instant only. PostgreSQL happily parses 'now', 'today' and 'yesterday' as
  // timestamptz, which would smuggle wall-clock behaviour straight back into a "fixed" as_of.
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/.test(asOf)) {
    throw new Error(
      `runMembershipInventory: \`asOf\` must be an absolute ISO-8601 timestamp with offset (got ${JSON.stringify(asOf)}). ` +
      'Relative inputs like "now"/"today" are rejected: they would break determinism.',
    );
  }

  await query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    // The snapshot only exists if BEGIN, every read and COMMIT run on ONE backend. A pooled
    // `pool.query` would scatter them across connections and silently void both READ ONLY and
    // REPEATABLE READ, so pin the session identity and re-check it at the end.
    const pidAtStart = await backendPid(query);

    const fingerprintBefore = await fingerprintSources(query);

    const queries = buildQueries(asOf);
    const report = {};
    for (const name of Object.keys(queries).sort()) {
      const { sql, params } = queries[name];
      const { rows } = await query(sql, params ?? []);
      report[name] = rows;
    }

    const fingerprintAfter = await fingerprintSources(query);

    const pidAtEnd = await backendPid(query);
    if (pidAtStart !== null && pidAtStart !== pidAtEnd) {
      throw new Error(
        `runMembershipInventory: the query callback is not session-pinned (backend ${pidAtStart} → ${pidAtEnd}). ` +
        'Pass a checked-out client, not a pool: a pooled callback voids the REPEATABLE READ snapshot.',
      );
    }

    await query('COMMIT');

    const dispositionCounts = {};
    for (const key of DISPOSITION_PRECEDENCE) dispositionCounts[key] = 0;
    for (const row of report.dispositions) dispositionCounts[row.disposition] += 1;

    const body = {
      inventory_version: INVENTORY_VERSION,
      as_of: asOf,
      disposition_counts: dispositionCounts,
      total_candidates: report.dispositions.length,
      report,
    };

    return {
      ...body,
      source_fingerprint_before: fingerprintBefore,
      source_fingerprint_after: fingerprintAfter,
      mutation_free: canonicalize(fingerprintBefore) === canonicalize(fingerprintAfter),
      content_hash: contentHash(body),
    };
  } catch (err) {
    await query('ROLLBACK').catch(() => {});
    throw err;
  }
}
