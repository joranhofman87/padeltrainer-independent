-- Theme A / R02 (audit, HIGH — financial-record loss on account deletion).
--
-- Deleting a player HARD-DELETED their bookings. delete-user-data anonymizes a departing player's
-- bookings by nulling player_id ("keep for record-keeping"), but booking_has_player
--   CHECK (player_id IS NOT NULL OR guest_player_id IS NOT NULL)
-- rejects that for a registered player's self-booking (guest_player_id NULL): the UPDATE fails with
-- 23514, the bare `await` swallows it (0 rows anonymized), and the subsequent profiles.delete()
-- cascades bookings.player_id (ON DELETE CASCADE) — erasing every paid/completed booking for that
-- player, the exact opposite of the code's stated intent, with no error surfaced.
--
-- Retain-in-place (the agreed model): detach the deleted player instead of deleting the booking.
--   1) bookings.player_id  ON DELETE CASCADE -> SET NULL — a profile delete now NULLs the reference
--      and keeps the financial row.
--   2) bookings.anonymized_at stamp + a relaxed CHECK that permits an anonymized (owner-less) row,
--      so the deletion code can null player_id and the row is legal. New non-anonymized bookings
--      still require an owner (the CHECK only widens for anonymized_at IS NOT NULL).

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;

COMMENT ON COLUMN public.bookings.anonymized_at IS
  'Theme A/R02: set when the booking''s player account was deleted — player_id is nulled but the financial row is retained for record-keeping. Gates the relaxed booking_has_player CHECK.';

-- Retain the booking, detach the deleted player (was ON DELETE CASCADE → erased the row).
ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_player_id_fkey;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_player_id_fkey
  FOREIGN KEY (player_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Permit an anonymized booking to carry neither owner id; still require one otherwise.
ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS booking_has_player;
ALTER TABLE public.bookings
  ADD CONSTRAINT booking_has_player
  CHECK (player_id IS NOT NULL OR guest_player_id IS NOT NULL OR anonymized_at IS NOT NULL);
