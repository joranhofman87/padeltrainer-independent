-- A1 PRESERVATION, STEP 1 OF 2 — CAPTURE (read-only). Pins the exact guest-side set that rule A1 would drop
-- from academy f5124b05-6c8b-40e4-9d67-36e2a41acd36, for Tom's binding decision of 2026-09-29: keep all 34
-- through an explicit academy relationship. Run BEFORE apply.sql (README, "Operator outcome contract",
-- rows CAP and CV):
--   psql -X -P pager=off -v ON_ERROR_STOP=1 -f this file
-- Output: ONE expanded record.
--   * pinned_ids: the dropped guest ids, sorted;
--   * pinned_sha256: sha256 of those ids joined by ',';
--   * pinned_count;
--   * the classification of the set (categories 1-7, signals, origin), plus two person-level refusal
--     signals.
-- No names, e-mail or contact data. One READ ONLY, REPEATABLE READ snapshot; ends in ROLLBACK.
-- The membership sets and categories are those of ptf_a1_exclusion_classification.sql, validated on
-- PGlite: receipt ptf-a1-cls-dryrun-2026-09-29T182547801Z-d31229e9, PASS. This file adds only:
--   * the id projection;
--   * person_removed_side: any side of the same person has a removed row for this academy;
--   * other_side_metadata: another side of the same person already has an active row for this academy.
\pset pager off
BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
\x on

WITH a AS (SELECT 'f5124b05-6c8b-40e4-9d67-36e2a41acd36'::uuid AS aid),
trainers AS (
  SELECT t.trainer_profile_id AS tid, coalesce(t.joined_at, t.created_at) AS since
    FROM public.academy_trainers t, a WHERE t.academy_profile_id = a.aid AND t.status = 'active'),
removed_g AS (
  SELECT m.guest_player_id AS gid FROM public.academy_player_metadata m, a
   WHERE m.academy_profile_id = a.aid AND m.removed_at IS NOT NULL AND m.guest_player_id IS NOT NULL),
removed_p AS (
  SELECT m.profile_id AS pid FROM public.academy_player_metadata m, a
   WHERE m.academy_profile_id = a.aid AND m.removed_at IS NOT NULL AND m.profile_id IS NOT NULL),
qual AS (
  SELECT b.guest_player_id AS gid, b.player_id AS pid, s.academy_profile_id AS slot_aid
    FROM public.bookings b JOIN public.availability_slots s ON s.id = b.slot_id
   WHERE b.status IN ('confirmed', 'completed')),
live_g AS (
  SELECT g.id AS gid FROM public.guest_players g, a WHERE g.academy_profile_id = a.aid
  UNION
  SELECT g.id FROM trainers t JOIN public.guest_players g ON g.trainer_id = t.tid),
a1_g AS (
  SELECT g.id AS gid FROM public.guest_players g, a WHERE g.academy_profile_id = a.aid
  UNION
  SELECT q.gid FROM qual q, a WHERE q.gid IS NOT NULL AND q.slot_aid = a.aid
  UNION
  SELECT m.guest_player_id FROM public.academy_player_metadata m, a
   WHERE m.academy_profile_id = a.aid AND m.guest_player_id IS NOT NULL),
admitted_g AS (SELECT gid FROM a1_g EXCEPT SELECT gid FROM removed_g),
admitted_p AS (
  SELECT DISTINCT q.pid FROM qual q, a WHERE q.pid IS NOT NULL AND q.slot_aid = a.aid
  EXCEPT SELECT pid FROM removed_p),
dropped AS (SELECT gid FROM live_g EXCEPT SELECT gid FROM a1_g EXCEPT SELECT gid FROM removed_g),
f AS (
  SELECT
    d.gid,
    (g.academy_profile_id IS NOT NULL AND g.academy_profile_id <> a.aid) AS other_academy_owned,
    EXISTS (SELECT 1 FROM public.person_links pl JOIN public.person_links pl2 ON pl2.person_id = pl.person_id
             WHERE pl.guest_player_id = d.gid
               AND ((pl2.guest_player_id IS NOT NULL AND pl2.guest_player_id <> d.gid
                     AND pl2.guest_player_id IN (SELECT gid FROM admitted_g))
                 OR (pl2.profile_id IS NOT NULL AND pl2.profile_id IN (SELECT pid FROM admitted_p)))) AS person_still_listed,
    EXISTS (SELECT 1 FROM public.invoices i
             WHERE i.guest_player_id = d.gid AND i.academy_profile_id = a.aid) AS academy_invoice,
    EXISTS (SELECT 1 FROM public.academy_player_locations apl
             WHERE apl.guest_player_id = d.gid AND apl.academy_profile_id = a.aid) AS academy_location,
    EXISTS (SELECT 1 FROM public.intake_requests ir JOIN public.cycles c ON c.id = ir.cycle_id
             WHERE ir.guest_player_id = d.gid AND c.owner_type = 'academy' AND c.owner_id = a.aid) AS academy_intake,
    EXISTS (SELECT 1 FROM public.slot_priority_claims sc
               JOIN public.availability_slots s ON s.id IN (sc.slot_id, sc.source_slot_id)
             WHERE (sc.guest_player_id = d.gid OR sc.booked_by_guest_player_id = d.gid)
               AND s.academy_profile_id = a.aid) AS academy_rebook_claim,
    EXISTS (SELECT 1 FROM public.bookings b JOIN public.availability_slots s ON s.id = b.slot_id
             WHERE b.guest_player_id = d.gid AND s.academy_profile_id = a.aid
               AND b.status NOT IN ('confirmed', 'completed')) AS academy_other_status_booking,
    EXISTS (SELECT 1 FROM public.notification_contacts nc
             WHERE nc.guest_player_id = d.gid AND nc.consent_academy_profile_id = a.aid) AS academy_consent,
    EXISTS (SELECT 1 FROM qual q WHERE q.gid = d.gid AND q.slot_aid IS NOT NULL AND q.slot_aid <> a.aid) AS trained_other_academy,
    EXISTS (SELECT 1 FROM qual q WHERE q.gid = d.gid AND q.slot_aid IS NULL) AS trained_unstamped,
    EXISTS (SELECT 1 FROM public.invoices i
             WHERE i.guest_player_id = d.gid AND i.academy_profile_id IS NULL) AS trainer_invoice,
    EXISTS (SELECT 1 FROM trainers t WHERE t.tid = g.trainer_id AND g.created_at < t.since) AS created_before_trainer_joined,
    EXISTS (SELECT 1 FROM public.bookings b WHERE b.guest_player_id = d.gid) AS any_booking,
    CASE WHEN g.source IS NULL THEN '(null)'
         WHEN g.source ~ '^[a-z_]{1,32}$' THEN g.source
         ELSE '(other text)' END AS origin,
    EXISTS (SELECT 1 FROM public.person_links pl JOIN public.person_links pl2 ON pl2.person_id = pl.person_id
               JOIN public.academy_player_metadata m ON m.academy_profile_id = a.aid AND m.removed_at IS NOT NULL
                AND (m.guest_player_id = pl2.guest_player_id OR m.profile_id = pl2.profile_id)
             WHERE pl.guest_player_id = d.gid) AS person_removed_side,
    EXISTS (SELECT 1 FROM public.person_links pl JOIN public.person_links pl2 ON pl2.person_id = pl.person_id
               JOIN public.academy_player_metadata m ON m.academy_profile_id = a.aid AND m.removed_at IS NULL
                AND (m.guest_player_id = pl2.guest_player_id OR m.profile_id = pl2.profile_id)
             WHERE pl.guest_player_id = d.gid
               AND (pl2.guest_player_id IS DISTINCT FROM d.gid)) AS other_side_metadata
  FROM dropped d JOIN public.guest_players g ON g.id = d.gid CROSS JOIN a),
c AS (
  SELECT f.*, CASE
    WHEN person_still_listed THEN 1
    WHEN other_academy_owned THEN 2
    WHEN academy_invoice OR academy_location OR academy_intake OR academy_rebook_claim
      OR academy_other_status_booking OR academy_consent THEN 3
    WHEN trained_other_academy THEN 4
    WHEN trainer_invoice OR trained_unstamped OR created_before_trainer_joined THEN 5
    WHEN NOT any_booking THEN 6
    ELSE 7 END AS category
  FROM f)
SELECT
  count(*)                                                                    AS pinned_count,
  encode(sha256(convert_to(coalesce(string_agg(gid::text, ',' ORDER BY gid::text COLLATE "C"), ''), 'UTF8')), 'hex')
                                                                              AS pinned_sha256,
  '{' || coalesce(string_agg(gid::text, ',' ORDER BY gid::text COLLATE "C"), '') || '}'  AS pinned_ids,
  count(*) FILTER (WHERE category = 1)                                        AS cat1_person_still_listed,
  count(*) FILTER (WHERE category = 2)                                        AS cat2_other_academy_owned,
  count(*) FILTER (WHERE category = 3)                                        AS cat3_academy_signal,
  count(*) FILTER (WHERE category = 4)                                        AS cat4_trained_other_academy,
  count(*) FILTER (WHERE category = 5)                                        AS cat5_trainer_private,
  count(*) FILTER (WHERE category = 6)                                        AS cat6_no_booking_no_signal,
  count(*) FILTER (WHERE category = 7)                                        AS cat7_other,
  count(*) FILTER (WHERE academy_invoice)                                     AS signal_academy_invoice,
  count(*) FILTER (WHERE academy_location OR academy_intake OR academy_rebook_claim
                      OR academy_other_status_booking OR academy_consent)     AS signal_other_academy_signal,
  count(*) FILTER (WHERE origin = 'manual')                                   AS origin_manual,
  count(*) FILTER (WHERE person_removed_side)                                 AS refuse_person_removed_side,
  count(*) FILTER (WHERE other_side_metadata)                                 AS refuse_other_side_metadata
FROM c;
\x off
ROLLBACK;
