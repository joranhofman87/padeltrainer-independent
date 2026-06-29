-- ============================================================================
-- REBOOK GO-LIVE · Workstream B, Slice B4 — one-time linked-guest backfill
-- ============================================================================
-- Owner-run, idempotent, EXPLICIT-LINK-ONLY (never email).
--
-- WHY. The signup linker `link_guest_data_to_profile` (migration 20260530190000)
-- backfills `bookings.player_id` / `invoices.player_id` for a guest's rows at the
-- moment the player signs up. But a booking/invoice created AFTER signup for an
-- already-linked guest (academy add, captain rebook) stays guest-keyed
-- (player_id NULL). B1/B2 already make those VISIBLE to the player via the
-- linked-guest read RPCs, so this backfill is OPTIONAL — it only converts those
-- rows to be natively player_id-keyed (so they show via the normal player_id
-- query and become player-cancellable).
--
-- SAFETY. Keyed on the EXPLICIT `guest_players.linked_profile_id` ONLY (never
-- email) — so it can never cross-link the wrong person via a shared/typo email.
-- It only ever SETS player_id where it is currently NULL (never overwrites), and
-- never touches guest_player_id, so the academy roster (which reads
-- guest_player_id) is unaffected. Re-running is a no-op. The booking constraint
-- `booking_has_player` (player_id OR guest_player_id) stays satisfied — the row
-- becomes dual-keyed, exactly as the signup linker already does.
--
-- PRECONDITION. Confirm the signup linker is deployed (it is, since 2026-05-30):
--   SELECT proname FROM pg_proc WHERE proname = 'link_guest_data_to_profile';   -- expect 1 row
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STEP 1 — READ-ONLY PREVIEW. Run this first; eyeball the counts. No writes.
-- ----------------------------------------------------------------------------
WITH linked_guests AS (
  SELECT id AS guest_id, linked_profile_id
  FROM public.guest_players
  WHERE linked_profile_id IS NOT NULL
)
SELECT
  (SELECT count(*) FROM public.bookings b
     JOIN linked_guests lg ON lg.guest_id = b.guest_player_id
    WHERE b.player_id IS NULL)  AS bookings_to_backfill,
  (SELECT count(*) FROM public.invoices i
     JOIN linked_guests lg ON lg.guest_id = i.guest_player_id
    WHERE i.player_id IS NULL) AS invoices_to_backfill,
  (SELECT count(*) FROM linked_guests) AS linked_guest_records;

-- ----------------------------------------------------------------------------
-- STEP 2 — BACKFILL (transactional). Run after the preview looks right.
-- Idempotent: only fills NULL player_id; safe to re-run.
-- ----------------------------------------------------------------------------
BEGIN;

WITH linked_guests AS (
  SELECT id AS guest_id, linked_profile_id
  FROM public.guest_players
  WHERE linked_profile_id IS NOT NULL
)
UPDATE public.bookings b
SET player_id = lg.linked_profile_id
FROM linked_guests lg
WHERE b.guest_player_id = lg.guest_id
  AND b.player_id IS NULL;

WITH linked_guests AS (
  SELECT id AS guest_id, linked_profile_id
  FROM public.guest_players
  WHERE linked_profile_id IS NOT NULL
)
UPDATE public.invoices i
SET player_id = lg.linked_profile_id
FROM linked_guests lg
WHERE i.guest_player_id = lg.guest_id
  AND i.player_id IS NULL;

-- Sanity: after this, the STEP 1 preview should report 0 / 0.
COMMIT;
