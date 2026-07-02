-- P1-2: swap_slots ownership hardening.
-- swap_slots is SECURITY DEFINER and therefore bypasses the availability_slots RLS
-- UPDATE policies. Before this migration it had default PUBLIC EXECUTE and did two
-- blind UPDATEs, so any authenticated (or anon) caller could reassign trainer_id
-- (mis-routing Mollie payouts) and overwrite start/end on ANY tenant's slots.
--
-- This CREATE OR REPLACE keeps the EXACT signature, SECURITY DEFINER, and search_path,
-- and adds an ownership guard that reproduces the three legitimate UPDATE paths already
-- encoded in the availability_slots RLS UPDATE policies:
--   * trainer owns the slot (trainer_profiles.user_id = auth.uid())
--   * academy manager      (get_user_academy_ids(auth.uid()) contains academy_profile_id)
--   * club manager         (trainer_locations JOIN club_profiles via get_user_club_ids)
-- plus the admin bypass (is_admin), applied to BOTH slot A and slot B.

-- Ownership predicate reused by swap_slots. STABLE SECURITY DEFINER so it can read the
-- ownership tables regardless of the caller's RLS. Returns FALSE for a missing slot.
CREATE OR REPLACE FUNCTION public.can_manage_slot(_user_id uuid, _slot_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.availability_slots s
    WHERE s.id = _slot_id
      AND (
        -- Admin bypass (preserves pre-existing SECURITY-DEFINER admin capability)
        public.is_admin(_user_id)
        -- Trainer owns the slot
        OR s.trainer_id IN (
          SELECT tp.id FROM public.trainer_profiles tp WHERE tp.user_id = _user_id
        )
        -- Academy manager for the slot's academy
        OR (
          s.academy_profile_id IS NOT NULL
          AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(_user_id))
        )
        -- Club manager for the slot's trainer
        OR s.trainer_id IN (
          SELECT tl.trainer_id
          FROM public.trainer_locations tl
          JOIN public.club_profiles cp ON cp.location_id = tl.location_id
          WHERE cp.id IN (SELECT public.get_user_club_ids(_user_id))
            AND tl.relationship_type IN ('club', 'club_trainer')
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.swap_slots(
  _slot_a_id uuid,
  _slot_a_trainer_id uuid,
  _slot_a_start timestamptz,
  _slot_a_end timestamptz,
  _slot_b_id uuid,
  _slot_b_trainer_id uuid,
  _slot_b_start timestamptz,
  _slot_b_end timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _uid uuid := auth.uid();
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'swap_slots: authentication required';
  END IF;

  -- Both target slots must exist and the caller must be allowed to manage EACH of them,
  -- exactly as the availability_slots RLS UPDATE policies would allow (or be an admin).
  IF NOT public.can_manage_slot(_uid, _slot_a_id) THEN
    RAISE EXCEPTION 'swap_slots: not authorized to modify slot %', _slot_a_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.can_manage_slot(_uid, _slot_b_id) THEN
    RAISE EXCEPTION 'swap_slots: not authorized to modify slot %', _slot_b_id
      USING ERRCODE = '42501';
  END IF;

  -- Atomic swap: update both slots in one transaction
  UPDATE availability_slots
  SET trainer_id = _slot_a_trainer_id,
      start_time = _slot_a_start,
      end_time = _slot_a_end
  WHERE id = _slot_a_id;

  UPDATE availability_slots
  SET trainer_id = _slot_b_trainer_id,
      start_time = _slot_b_start,
      end_time = _slot_b_end
  WHERE id = _slot_b_id;
END;
$$;

-- Lock down EXECUTE: no PUBLIC/anon; authenticated only (the RPC now self-authorizes).
REVOKE ALL ON FUNCTION public.swap_slots(uuid, uuid, timestamptz, timestamptz, uuid, uuid, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.swap_slots(uuid, uuid, timestamptz, timestamptz, uuid, uuid, timestamptz, timestamptz) FROM anon;
GRANT EXECUTE ON FUNCTION public.swap_slots(uuid, uuid, timestamptz, timestamptz, uuid, uuid, timestamptz, timestamptz) TO authenticated;

REVOKE ALL ON FUNCTION public.can_manage_slot(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_manage_slot(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_manage_slot(uuid, uuid) TO authenticated;
