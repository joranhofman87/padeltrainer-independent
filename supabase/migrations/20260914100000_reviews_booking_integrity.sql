-- Reviews integrity hardening (follow-up to notification PR 5; before PR 6).
-- A review's booking_id, WHEN PRESENT, must reference a REAL booking; a player-created
-- review must correspond to a legitimate completed/confirmed booking of THAT player with
-- THAT trainer. Admin/manual reviews carry booking_id = NULL (no more fabricated "virtual
-- booking" UUIDs). This removes the fake-booking review semantics that let a caller pollute
-- a trainer's public rating; it complements the PR-5 trigger's email-authorization guard.

-- 1. booking_id becomes nullable — admin/manual reviews have no underlying booking.
ALTER TABLE public.reviews ALTER COLUMN booking_id DROP NOT NULL;

-- 2. Cleanup so the FK adds cleanly: any existing booking_id that isn't a real booking → NULL.
--    (Prod currently has 0 reviews; defensive for other environments / historical rows.)
UPDATE public.reviews r
SET booking_id = NULL
WHERE booking_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.bookings b WHERE b.id = r.booking_id);

-- 3. One review per REAL booking, but unlimited NULLs (admin/manual): the existing
--    reviews_booking_id_key UNIQUE constraint already delivers this on a nullable column
--    (Postgres treats NULLs as distinct), so it is KEPT — no index rework needed.

-- 4. FK: a present booking_id must reference a real booking; clears to NULL if it's deleted.
ALTER TABLE public.reviews
  ADD CONSTRAINT reviews_booking_id_fkey
  FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;

-- 5. Tighten the PLAYER INSERT policy: a non-admin review must be tied to a real
--    completed/confirmed booking of the inserting player with the reviewed trainer.
--    The new row's columns (player_id/trainer_id/booking_id) are referenced BARE in the
--    outer scope and compared to the booking's own player/trainer via scalar subqueries —
--    correlating only booking_id inside (unambiguous: bookings has no booking_id column),
--    which avoids bookings.player_id shadowing the review's player_id.
DROP POLICY IF EXISTS "Players can create reviews for their bookings" ON public.reviews;
CREATE POLICY "Players can create reviews for their bookings"
  ON public.reviews FOR INSERT TO public
  WITH CHECK (
    player_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid())
    AND booking_id IS NOT NULL
    AND player_id  = (SELECT b.player_id FROM public.bookings b WHERE b.id = booking_id)
    AND trainer_id = (SELECT s.trainer_id FROM public.bookings b
                        JOIN public.availability_slots s ON s.id = b.slot_id
                       WHERE b.id = booking_id)
    AND (SELECT b.status FROM public.bookings b WHERE b.id = booking_id)
          IN ('completed', 'confirmed')
  );

-- The separate "Admins can create reviews" policy (WITH CHECK is_admin(auth.uid())) is left
-- untouched: admins may insert manual reviews with booking_id = NULL.

COMMENT ON CONSTRAINT reviews_booking_id_fkey ON public.reviews IS
  'A review''s booking_id, when set, must be a real booking. Admin/manual reviews use NULL. Player reviews are further gated to a completed/confirmed booking of that player+trainer by the INSERT RLS.';
