-- Phase 0c hardening (external audit, finding H1): find_guest_players_by_email_for_academy
-- TRUSTED the caller-supplied _trainer_ids array. The academy gate (get_user_academy_ids) only
-- validates the ACADEMY claim, so any authenticated user who manages any academy could pass
-- arbitrary trainer UUIDs and use this SECURITY DEFINER function as a cross-tenant email oracle:
-- "does trainer T (of some OTHER academy) have a guest with exactly this email — and what is their
-- name?". The flaw is as old as the function (P2-2, 20260706130100); this re-creation derives the
-- trainer set INSIDE the function from academy_trainers, so the caller can no longer widen the
-- search beyond the academy they actually manage. The _trainer_ids parameter is KEPT in the
-- signature (deployed clients still pass it) but is now IGNORED.
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
    -- match the partial index predicate (idx_guest_players_lower_email) so the planner can use it
    AND gp.email IS NOT NULL AND btrim(gp.email) <> ''
    -- caller must actually manage the academy they claim to dedup within
    AND _academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
    AND (
      gp.academy_profile_id = _academy_profile_id
      -- H1 fix: the trainer set is DERIVED here — never taken from the caller
      OR gp.trainer_id IN (
        SELECT at.trainer_profile_id
        FROM public.academy_trainers at
        WHERE at.academy_profile_id = _academy_profile_id
          AND at.status = 'active'
      )
    )
  ORDER BY gp.created_at
  LIMIT 10
$$;

REVOKE ALL ON FUNCTION public.find_guest_players_by_email_for_academy(text, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_guest_players_by_email_for_academy(text, uuid, uuid[]) TO authenticated;
