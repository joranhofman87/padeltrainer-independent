-- Phase 2: academy-curated, guest-capable, multi-location store for players.
-- One row per (academy, subject, location) with a `dismissed` flag:
--   dismissed=false -> manually ATTACHED (the club shows even without a booking/preferred)
--   dismissed=true  -> SUPPRESSED   (hide a club that an auto/preferred/intake source would
--                                     otherwise surface)
--   no row          -> the club shows iff trained/preferred/intake surfaces it (Phase 1)
-- attach()/detach() are idempotent upserts of that one flag. Manager-gated + RLS.

CREATE TABLE public.academy_player_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  dismissed boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT apl_one_subject CHECK ((profile_id IS NOT NULL)::int + (guest_player_id IS NOT NULL)::int = 1)
);
-- exactly-one-subject means two partial uniques (NULLs don't dedupe in a single UNIQUE)
CREATE UNIQUE INDEX apl_uniq_profile ON public.academy_player_locations (academy_profile_id, profile_id, location_id) WHERE profile_id IS NOT NULL;
CREATE UNIQUE INDEX apl_uniq_guest   ON public.academy_player_locations (academy_profile_id, guest_player_id, location_id) WHERE guest_player_id IS NOT NULL;
CREATE INDEX apl_by_academy ON public.academy_player_locations (academy_profile_id);

ALTER TABLE public.academy_player_locations ENABLE ROW LEVEL SECURITY;
-- Defense in depth: even direct table access is restricted to the academy's managers.
CREATE POLICY apl_manager_all ON public.academy_player_locations
  FOR ALL TO authenticated
  USING (public.is_academy_manager(auth.uid(), academy_profile_id))
  WITH CHECK (public.is_academy_manager(auth.uid(), academy_profile_id));
REVOKE ALL ON public.academy_player_locations FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.academy_player_locations TO authenticated;

-- ── writers (SECURITY DEFINER, manager-gated, validating + idempotent) ──────────
CREATE OR REPLACE FUNCTION public.set_player_location(
  p_academy_profile_id uuid,
  p_profile_id uuid,
  p_guest_player_id uuid,
  p_location_id uuid,
  p_dismissed boolean   -- false = attach/show, true = detach/suppress
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_academy_manager(auth.uid(), p_academy_profile_id) THEN
    RAISE EXCEPTION 'not authorized for academy %', p_academy_profile_id USING ERRCODE = '42501';
  END IF;
  IF (p_profile_id IS NOT NULL)::int + (p_guest_player_id IS NOT NULL)::int <> 1 THEN
    RAISE EXCEPTION 'exactly one of profile_id / guest_player_id required' USING ERRCODE = '22023';
  END IF;
  -- the location must be one of the academy's contracted clubs
  IF NOT EXISTS (SELECT 1 FROM public.academy_locations al
                 WHERE al.academy_profile_id = p_academy_profile_id AND al.location_id = p_location_id) THEN
    RAISE EXCEPTION 'location % is not an academy location', p_location_id USING ERRCODE = '23503';
  END IF;

  -- idempotent upsert (retry loop handles a concurrent INSERT racing our INSERT)
  LOOP
    UPDATE public.academy_player_locations
       SET dismissed = p_dismissed, updated_at = now(), created_by = coalesce(created_by, auth.uid())
     WHERE academy_profile_id = p_academy_profile_id
       AND location_id = p_location_id
       AND ((p_profile_id IS NOT NULL AND profile_id = p_profile_id)
         OR (p_guest_player_id IS NOT NULL AND guest_player_id = p_guest_player_id));
    IF FOUND THEN RETURN; END IF;
    BEGIN
      INSERT INTO public.academy_player_locations
        (academy_profile_id, profile_id, guest_player_id, location_id, dismissed, created_by)
      VALUES (p_academy_profile_id, p_profile_id, p_guest_player_id, p_location_id, p_dismissed, auth.uid());
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      -- a concurrent writer inserted the row first; loop back and UPDATE it
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.set_player_location(uuid, uuid, uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_player_location(uuid, uuid, uuid, uuid, boolean) TO authenticated;
COMMENT ON FUNCTION public.set_player_location(uuid, uuid, uuid, uuid, boolean) IS
  'Attach (p_dismissed=false) or suppress/detach (true) a club for a player in an academy. Idempotent upsert of one flag; manager-gated; location must belong to the academy.';
