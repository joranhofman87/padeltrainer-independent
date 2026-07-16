-- Person-unification Phase 0 audit fix (#2/#8/#9): the academy guest-email dedup RPC matched
-- `gp.email = _email` CASE-SENSITIVELY, but guest_players.email is not lowercased on write and every
-- OTHER email path folds case (link_guest_data_to_profile, intake backfill, invoice matching). The
-- registered-player twin path lowercases its email before lookup, so a mixed-case LEGACY guest row
-- (e.g. 'Jan@Example.com') would evade reuse → a DUPLICATE guest twin, a duplicate cycle seat +
-- double invoice for one human, AND it defeats the link trigger's single-unlinked-match guard
-- (leaving the twin unlinked, its bookings never backfilled). Fold case so the dedup uses the SAME
-- key as the link trigger (lower(btrim(email))).
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
  WHERE lower(btrim(gp.email)) = lower(btrim(_email))
    AND btrim(_email) <> ''
    -- caller must actually manage the academy they claim to dedup within
    AND _academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
    AND (
      gp.academy_profile_id = _academy_profile_id
      OR gp.trainer_id = ANY (_trainer_ids)
    )
  ORDER BY gp.created_at
  LIMIT 10
$$;

-- Keep the case-folded lookup index-backed (the WHERE now filters on lower(btrim(email))).
CREATE INDEX IF NOT EXISTS idx_guest_players_lower_email
  ON public.guest_players (lower(btrim(email)))
  WHERE email IS NOT NULL AND btrim(email) <> '';

-- Grants unchanged from 20260706130100 (re-assert; CREATE OR REPLACE preserves them but be explicit).
REVOKE ALL ON FUNCTION public.find_guest_players_by_email_for_academy(text, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_guest_players_by_email_for_academy(text, uuid, uuid[]) TO authenticated;
