-- PRIVACY / GDPR fix: profiles_public was a definer-rights view (security_invoker
-- = off) with NO WHERE clause, GRANTed to anon + authenticated. It therefore let
-- ANYONE with the public API key (incl. anonymous visitors) enumerate EVERY
-- user's name, city, bio, rating and federation member-id — players included.
-- Players are NOT public.
--
-- This restricts the ROWS the view returns to the intended model, mirroring the
-- relationship predicates already vetted on the base profiles table:
--   * PUBLIC TRAINERS are world-visible (the trainer directory) — anon included.
--   * Your OWN profile.
--   * Admins.
--   * A trainer sees profiles of players they have booked.
--   * An academy/club manager sees profiles of their trainers and of players who
--     train at their academy/club (booked slots or linked guest records).
--   * A player sees the profile of a trainer they book (so the trainer's NAME
--     still renders) — public trainers already covered above.
-- Anyone NOT in one of those relationships can no longer see a player at all.
--
-- Columns are unchanged (only rows are filtered) so the 22 consumers keep
-- working; email/phone were never in this view. security_invoker stays off so
-- the public-trainer carve-out can serve anonymous directory visitors, but every
-- non-public row is now gated by an explicit relationship to the caller.

CREATE OR REPLACE VIEW public.profiles_public
WITH (security_invoker = off)
AS
SELECT
  p.id,
  p.user_id,
  p.full_name,
  p.avatar_url,
  p.bio,
  p.location,
  p.skill_rating,
  p.rating_system,
  p.rating_member_id,
  p.created_at,
  p.updated_at
FROM public.profiles p
WHERE
  -- (1) Public trainers: world-visible (directory / anon).
  EXISTS (
    SELECT 1 FROM public.trainer_profiles tp
    WHERE tp.user_id = p.user_id AND tp.is_public = true
  )
  -- (2) Own profile.
  OR (auth.uid() IS NOT NULL AND p.user_id = auth.uid())
  -- (3) Admin.
  OR public.is_admin(auth.uid())
  -- (4) Caller is a trainer who has this player booked.
  OR public.is_player_of_trainer(p.id)
  -- (5) Caller is an academy manager of the trainer this profile belongs to.
  OR p.user_id IN (
    SELECT tp.user_id
    FROM public.trainer_profiles tp
    JOIN public.academy_trainers atr ON atr.trainer_profile_id = tp.id
    JOIN public.academy_managers am ON am.academy_profile_id = atr.academy_profile_id
    WHERE am.user_id = auth.uid() AND atr.status = 'active'
  )
  -- (6) Caller is an academy manager and this profile is a player who trains at
  --     their academy (a booking on one of the academy's slots).
  OR EXISTS (
    SELECT 1
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    JOIN public.academy_managers am ON am.academy_profile_id = s.academy_profile_id
    WHERE b.player_id = p.id AND am.user_id = auth.uid()
  )
  -- (6b) ... or this profile is linked to a guest the academy manages.
  OR EXISTS (
    SELECT 1
    FROM public.guest_players g
    JOIN public.academy_managers am ON am.academy_profile_id = g.academy_profile_id
    WHERE g.linked_profile_id = p.id AND am.user_id = auth.uid()
  )
  -- (7) Caller is a player who books a slot taught by this trainer (sees the
  --     trainer's name even if the trainer is not individually public).
  OR EXISTS (
    SELECT 1
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
    WHERE b.player_id = public.get_profile_id_for_user(auth.uid())
      AND tp.user_id = p.user_id
  )
  -- (8) Caller is a club manager of the trainer this profile belongs to
  --     (trainer linked to one of the club's locations).
  OR p.user_id IN (
    SELECT tp.user_id
    FROM public.trainer_profiles tp
    JOIN public.trainer_locations tl ON tl.trainer_id = tp.id
    JOIN public.club_profiles cp ON cp.location_id = tl.location_id
    JOIN public.club_managers cm ON cm.club_profile_id = cp.id
    WHERE cm.user_id = auth.uid()
  )
  -- (9) Caller is a club manager and this profile is a player who trains at the
  --     club (booked a slot taught by one of the club's trainers).
  OR EXISTS (
    SELECT 1
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    JOIN public.trainer_locations tl ON tl.trainer_id = s.trainer_id
    JOIN public.club_profiles cp ON cp.location_id = tl.location_id
    JOIN public.club_managers cm ON cm.club_profile_id = cp.id
    WHERE b.player_id = p.id AND cm.user_id = auth.uid()
  );

GRANT SELECT ON public.profiles_public TO anon, authenticated;
