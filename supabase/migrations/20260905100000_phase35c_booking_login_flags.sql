-- Phase 3.5c: get_booking_login_flags — person-level has_login per BOOKING.
--
-- PROBLEM (scout-confirmed): ~10 staff surfaces still render a Guest/Gast badge
-- (or gate functionality) on SEAT presence (`!!booking.guest_player_id`): the four
-- slot-detail surfaces (trainer/academy/dialog/club), both trainer agenda cards,
-- the AcademyDayGrid booked chip, BookForPlayerDialog's occupied rows, and —
-- worst — PlayerCoachingNoteEditor, which DISABLES note-sharing claiming the
-- player "has no login". Under FAM-02 a MERGED login-holder's seats are
-- guest-keyed, so all of these mislabel (and the note editor loses function) for
-- exactly the people the unification merged. Doctrine (3.3a/3.3d/3.3e): every
-- guest/registered label keys on person-level login (persons.user_id), never the
-- seat.
--
-- FIX: one bulk DEFINER resolver, booking_id → has_login, mirroring the
-- 3.3a roster resolution: person arm first (bookings.person_id → persons.user_id),
-- then the profile side (seat player_id → profiles.user_id, PURE-PROFILE rows
-- only per FAM-02), then the guest link side (person_links guest → profile side —
-- SUSPENDED while the guest is split-frozen: identity uncertain → accountless).
-- Returns ONLY (booking_id, has_login) — a boolean, no PII, no refs.
--
-- AUTHZ: rows are returned ONLY for bookings whose slot the caller can manage
-- (slot's trainer / academy manager / club manager / admin) — the same audience
-- that already reads those bookings on the calling surfaces. Unauthorized ids are
-- silently omitted (no oracle: absence = not-yours-or-unknown, and the flag
-- itself exists only for people already visible to the caller).

CREATE OR REPLACE FUNCTION public.get_booking_login_flags(_booking_ids uuid[])
RETURNS TABLE (booking_id uuid, has_login boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    b.id AS booking_id,
    COALESCE(
      -- person arm: the stamped person has an account.
      (SELECT pe.user_id IS NOT NULL FROM public.persons pe WHERE pe.id = b.person_id),
      -- profile side (pure-profile seats only — FAM-02: dual-keyed rows belong
      -- to the guest and resolve via the guest arms below).
      CASE WHEN b.player_id IS NOT NULL AND b.guest_player_id IS NULL THEN EXISTS (
        SELECT 1 FROM public.profiles p WHERE p.id = b.player_id AND p.user_id IS NOT NULL
      ) END,
      -- guest link side: the guest's person has an account — suspended while
      -- split-frozen (identity uncertain → treat as accountless).
      CASE WHEN b.guest_player_id IS NOT NULL AND NOT public.is_guest_split_frozen(b.guest_player_id) THEN EXISTS (
        SELECT 1
        FROM public.person_links plg
        JOIN public.persons pe ON pe.id = plg.person_id
        WHERE plg.guest_player_id = b.guest_player_id
          AND pe.user_id IS NOT NULL
      ) END,
      false
    ) AS has_login
  FROM public.bookings b
  JOIN public.availability_slots s ON s.id = b.slot_id
  WHERE b.id = ANY(_booking_ids)
    AND (
      public.is_admin(auth.uid())
      OR s.trainer_id IN (SELECT tp.id FROM public.trainer_profiles tp WHERE tp.user_id = auth.uid())
      OR (s.academy_profile_id IS NOT NULL
          AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid())))
      OR (s.location_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM public.club_profiles cp
        JOIN public.club_managers cm ON cm.club_profile_id = cp.id
        WHERE cp.location_id = s.location_id AND cm.user_id = auth.uid()
      ))
    );
$$;

COMMENT ON FUNCTION public.get_booking_login_flags(uuid[]) IS
  'Phase 3.5c: booking_id → person-level has_login (boolean only, no PII) for the Guest/Registered badges + note-sharing gates on staff surfaces. Person arm first, then pure-profile seat, then guest person-link (suspended while split-frozen). Rows returned only for bookings on slots the caller manages (trainer/academy manager/club manager/admin); others silently omitted.';

REVOKE ALL ON FUNCTION public.get_booking_login_flags(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_booking_login_flags(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_booking_login_flags(uuid[]) TO authenticated;
