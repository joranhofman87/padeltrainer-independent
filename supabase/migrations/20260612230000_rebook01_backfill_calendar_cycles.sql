-- ============================================================================
-- REBOOK-01 backfill: create cycles rows for historical calendar-created cycli
-- ============================================================================
--
-- WHAT THIS DOES
--   The calendar "Cyclus aanmaken" flows (trainer/academy AddSlotDialog, club
--   ClubAddSlotDialog, DuplicateCyclusDialog, onboarding step 3) used to mint
--   availability_slots.cyclus_id = crypto.randomUUID() WITHOUT creating a row
--   in the cycles table. Those cycli are therefore invisible to the
--   "Volgende ronde opzetten" (rebooking) wizard and the registrations
--   (Inschrijvingen) list, which both read from the cycles table.
--   The app code now creates a cycles row up front; this script backfills the
--   historical orphans: for every DISTINCT availability_slots.cyclus_id that
--   has no matching cycles row, it inserts one cycles row with
--     id                = the existing cyclus_id (so slots keep pointing at it)
--     name              = max(cyclus_name) of the group, fallback 'Cyclus'
--     owner             = 'academy'/academy_profile_id when any slot in the
--                         group has academy_profile_id set, else
--                         'trainer'/trainer_id (availability_slots.trainer_id
--                         REFERENCES trainer_profiles(id) — the same id the
--                         trainer pages pass to getCycles('trainer', ...))
--     start/end_date    = min/max(start_time)::date of the group's slots
--     type              = 'cyclus'
--     status            = 'closed'  (public registration forms only render for
--                         status 'open', so nothing becomes publicly bookable)
--     price_per_session = max(price_per_session) of the group (any slot)
--
--   Limitation: club-calendar-created cycli carry no club marker on the slots
--   (only trainer_id), so they are backfilled as trainer-owned. The trainer
--   who teaches them will see them in their own rebooking list.
--
-- OWNER SIGN-OFF: approved 2026-06-12 ("if nothing goes out to players and it
--   doesn't change anything else than just adding a cycle record that is fine").
--   PGlite-rehearsed (6 assertions) before applying.
--
-- WHY IT WAS INITIALLY HELD BACK
--   This creates immediately VISIBLE rows for ALL real trainers', academies'
--   and clubs' historical calendar cycles at once: every old calendar cyclus
--   suddenly appears in their "Inschrijvingen"/cycles overview and rebooking
--   wizard, including long-finished ones. That is the intended end state, but
--   it should be applied deliberately (after checking row counts on production
--   and, ideally, after telling users), not silently as part of a routine
--   deploy. Hence: prepared but not applied.
--
-- HOW TO APPLY
--   1. Review the expected volume first:
--        SELECT count(DISTINCT s.cyclus_id)
--        FROM public.availability_slots s
--        WHERE s.cyclus_id IS NOT NULL
--          AND NOT EXISTS (SELECT 1 FROM public.cycles c WHERE c.id = s.cyclus_id);
--   2. Run this whole file in the Supabase SQL editor (or psql) against the
--      target project. It runs as one transaction-safe DO block and RAISEs a
--      NOTICE with the number of rows inserted.
--   3. Idempotent: the NOT EXISTS guard means re-running inserts nothing new.
--      (If you later promote it into supabase/migrations/, rename it with a
--      timestamp prefix; it is safe to run after the app-side fix is live.)
--
-- ============================================================================

DO $$
DECLARE
  inserted_count integer;
BEGIN
  WITH ins AS (
    INSERT INTO public.cycles (
      id,
      owner_type,
      owner_id,
      name,
      start_date,
      end_date,
      type,
      status,
      price_per_session,
      settings
    )
    SELECT
      s.cyclus_id,
      CASE
        WHEN bool_or(s.academy_profile_id IS NOT NULL) THEN 'academy'
        ELSE 'trainer'
      END                                              AS owner_type,
      COALESCE(
        max(s.academy_profile_id::text)::uuid,         -- no max(uuid) in PG: cast via text
        max(s.trainer_id::text)::uuid                  -- trainer_profiles.id (FK on availability_slots)
      )                                                AS owner_id,
      COALESCE(max(s.cyclus_name), 'Cyclus')           AS name,
      min(s.start_time)::date                          AS start_date,
      max(s.start_time)::date                          AS end_date,
      'cyclus'                                         AS type,
      'closed'                                         AS status,  -- never an open public form
      max(s.price_per_session)                         AS price_per_session,
      '{}'::jsonb                                      AS settings
    FROM public.availability_slots s
    WHERE s.cyclus_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.cycles c WHERE c.id = s.cyclus_id
      )
    GROUP BY s.cyclus_id
    RETURNING 1
  )
  SELECT count(*) INTO inserted_count FROM ins;

  RAISE NOTICE 'backfill_calendar_cycles: inserted % cycles row(s) for orphaned cyclus_ids', inserted_count;
END
$$;
