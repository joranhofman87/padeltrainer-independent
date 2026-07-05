-- P2-2: narrow the ACADEMY-MANAGER guest_players SELECT branch.
-- Before: an academy manager could read a shared trainer's ENTIRE guest_players
-- roster via (trainer_id IN <academy's active trainers>) with NO per-academy
-- scoping on the guest row -> cross-tenant PII leak. Owner decision: an academy may
-- only see guests with SOME relationship to the academy. Relationship = ANY of:
--   (a) guest_players.academy_profile_id in the caller's academies; OR
--   (b) the guest has a booking on a slot owned by one of the caller's academies
--       (availability_slots.academy_profile_id in the caller's academies); OR
--   (c) an academy_player_metadata row links the guest to one of the caller's academies.
-- Trainer-role own-guest visibility ('Trainers can view their own guest players'),
-- the admin SELECT policy, and the INSERT/UPDATE/DELETE academy policies are
-- intentionally left unchanged. get_players_overview is SECURITY DEFINER and unaffected.

-- 1. SECURITY DEFINER predicate behind the new SELECT policy. SECURITY DEFINER so it
--    can read bookings / availability_slots / academy_player_metadata without
--    recursing into their (or guest_players') RLS. Returns only a boolean, gated to
--    the caller's own academy set via get_user_academy_ids(_user_id).
CREATE OR REPLACE FUNCTION public.guest_belongs_to_user_academy(
  _guest_id uuid,
  _user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    -- (a) guest owned directly by one of the caller's academies
    SELECT 1
    FROM public.guest_players gp
    WHERE gp.id = _guest_id
      AND gp.academy_profile_id IN (SELECT public.get_user_academy_ids(_user_id))
  )
  OR EXISTS (
    -- (b) guest has a booking on a slot owned by one of the caller's academies
    SELECT 1
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    WHERE b.guest_player_id = _guest_id
      AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(_user_id))
  )
  OR EXISTS (
    -- (c) academy_player_metadata link between the guest and a caller academy
    SELECT 1
    FROM public.academy_player_metadata m
    WHERE m.guest_player_id = _guest_id
      AND m.academy_profile_id IN (SELECT public.get_user_academy_ids(_user_id))
  )
$$;

REVOKE ALL ON FUNCTION public.guest_belongs_to_user_academy(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guest_belongs_to_user_academy(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.guest_belongs_to_user_academy(uuid, uuid) TO authenticated;

-- 2. Drop BOTH over-broad academy SELECT policies (each OR-combined the unscoped
--    trainer_id branch). Write-path (INSERT/UPDATE/DELETE) policies are untouched.
DROP POLICY IF EXISTS "Academy managers can view their trainers guest players" ON public.guest_players;
DROP POLICY IF EXISTS "Academy managers can view guest players for their trainers" ON public.guest_players;

-- 3. Single scoped academy-manager SELECT policy.
DROP POLICY IF EXISTS "Academy managers can view related academy guest players" ON public.guest_players;
CREATE POLICY "Academy managers can view related academy guest players"
ON public.guest_players FOR SELECT
TO authenticated
USING (public.guest_belongs_to_user_academy(id, auth.uid()));

-- 4. Email-dedup lookup for the academy resolve-or-create path.
-- Narrowing the SELECT policy above removes the academy manager's RLS visibility
-- into a shared trainer's not-yet-related guests. That is correct for reads, but the
-- guest email-dedup in src/lib/playerResolve.ts RELIED on that visibility to reuse a
-- trainer-created guest by email; without it, resolve-or-create would insert a
-- DUPLICATE academy-owned guest for the same person (the two partial unique indexes
-- do not collide across trainer-owned vs academy-owned rows -> no 23505). This
-- SECURITY DEFINER function reproduces the OLD dedup visibility (academy-owned OR
-- owned by one of the passed active-trainer ids) so dedup keeps working while the RLS
-- read stays narrowed. It only returns id + full_name for exact-email candidates; the
-- caller (pickGuestIdByName) still disambiguates shared emails by name.
CREATE OR REPLACE FUNCTION public.find_guest_players_by_email_for_academy(
  _email text,
  _academy_profile_id uuid,
  _trainer_ids uuid[]
)
RETURNS TABLE (id uuid, full_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT gp.id, gp.full_name
  FROM public.guest_players gp
  WHERE gp.email = _email
    AND _email <> ''
    -- caller must actually manage the academy they claim to dedup within
    AND _academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
    AND (
      gp.academy_profile_id = _academy_profile_id
      OR gp.trainer_id = ANY (_trainer_ids)
    )
  ORDER BY gp.created_at
  LIMIT 10
$$;

REVOKE ALL ON FUNCTION public.find_guest_players_by_email_for_academy(text, uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.find_guest_players_by_email_for_academy(text, uuid, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.find_guest_players_by_email_for_academy(text, uuid, uuid[]) TO authenticated;
