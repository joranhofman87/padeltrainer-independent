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

-- 5. Factor the "is this a legitimate reviewable booking for this player+trainer?" rule
--    into ONE SECURITY DEFINER helper, so the INSERT and UPDATE policies share it and
--    cannot drift. DEFINER lets it read bookings/slots regardless of the caller's grants.
CREATE OR REPLACE FUNCTION public.is_reviewable_booking(p_booking_id uuid, p_player_id uuid, p_trainer_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    p_booking_id IS NOT NULL
    -- AUTH-BOUND: this is SECURITY DEFINER (bypasses bookings RLS), so bind it to the
    -- caller — they may only assert bookings for their OWN player identity (or as admin).
    -- Otherwise it is an oracle leaking other players' booking existence/status/relations.
    AND (p_player_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid())
         OR public.is_admin(auth.uid()))
    AND EXISTS (
      SELECT 1
      FROM public.bookings b
      JOIN public.availability_slots s ON s.id = b.slot_id
      WHERE b.id = p_booking_id
        AND b.player_id = p_player_id
        AND s.trainer_id = p_trainer_id
        AND b.status IN ('completed', 'confirmed')
    );
$$;
COMMENT ON FUNCTION public.is_reviewable_booking(uuid, uuid, uuid) IS
  'Reviews integrity: TRUE iff booking_id is a real completed/confirmed booking of that player with that trainer AND the caller owns that player identity (or is admin). Shared by the reviews INSERT + UPDATE RLS; auth-bound + locked down so it is not an oracle over others'' bookings.';
REVOKE ALL ON FUNCTION public.is_reviewable_booking(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_reviewable_booking(uuid, uuid, uuid) TO authenticated, service_role;

-- 6. PLAYER INSERT policy — must be a legitimate reviewable booking.
DROP POLICY IF EXISTS "Players can create reviews for their bookings" ON public.reviews;
CREATE POLICY "Players can create reviews for their bookings"
  ON public.reviews FOR INSERT TO authenticated
  WITH CHECK (
    player_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid())
    AND public.is_reviewable_booking(booking_id, player_id, trainer_id)
  );

-- 7. PLAYER UPDATE policy — CLOSE THE BYPASS: the OLD policy had USING(own) and NO
--    WITH CHECK, so a player could insert a valid review then UPDATE it to a forged
--    trainer_id / booking_id / NULL and pollute another trainer. The RESULTING row must
--    now also be a legitimate reviewable booking (rating/comment edits keep booking_id +
--    trainer_id, so they still pass).
DROP POLICY IF EXISTS "Players can update their own reviews" ON public.reviews;
CREATE POLICY "Players can update their own reviews"
  ON public.reviews FOR UPDATE TO authenticated
  USING (player_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()))
  WITH CHECK (
    player_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid())
    AND public.is_reviewable_booking(booking_id, player_id, trainer_id)
  );

-- The separate admin policies ("Admins can create reviews" / "Admins can update any
-- review", is_admin(auth.uid())) are untouched: admins may insert/keep booking_id = NULL.

COMMENT ON CONSTRAINT reviews_booking_id_fkey ON public.reviews IS
  'A review''s booking_id, when set, must be a real booking. Admin/manual reviews use NULL. Player reviews are further gated to a completed/confirmed booking of that player+trainer by the INSERT RLS.';
