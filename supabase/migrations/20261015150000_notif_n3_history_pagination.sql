-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N3 seam-review round — the player history gains KEYSET PAGINATION.
--
-- The sweep caught the gap: the UI asked for 10 rows, the RPC hard-caps at 200, and nothing
-- offered a route to anything older — so after eleven changes the oldest was unreachable while
-- the surface claimed every change is visible. `p_before` is a keyset cursor (created_at of the
-- last row the caller has); pages walk backwards deterministically. The old single-arg shape is
-- DROPPED so no caller can keep the unpaginated illusion.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.get_my_notification_restriction_history(int);

CREATE OR REPLACE FUNCTION public.get_my_notification_restriction_history(
  p_limit int DEFAULT 50,
  p_before timestamptz DEFAULT NULL
) RETURNS TABLE (
  academy_profile_id uuid,
  academy_name text,
  event_type text,
  channel text,
  old_max_frequency text,
  new_max_frequency text,
  reason text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'get_my_notification_restriction_history: authentication required';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'get_my_notification_restriction_history: limit must be 1..200';
  END IF;
  RETURN QUERY
  SELECT au.academy_profile_id, a.name, au.event_type, au.channel,
         au.old_max_frequency, au.new_max_frequency, au.reason, au.created_at
    FROM public.academy_notification_restriction_audit au
    JOIN public.academy_profiles a ON a.id = au.academy_profile_id
   WHERE au.academy_profile_id IN (SELECT public.notif_my_academy_ids())
     AND (p_before IS NULL OR au.created_at < p_before)
   ORDER BY au.created_at DESC
   LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.get_my_notification_restriction_history(int, timestamptz) IS
  'N3: the audit trail of cap changes in the CALLING account''s academies, keyset-paginated on created_at (p_before = the oldest timestamp the caller already has; NULL = newest page). Every change is reachable by walking pages. Actor identity deliberately withheld from players. The unpaginated 1-arg form is DROPPED.';

REVOKE ALL ON FUNCTION public.get_my_notification_restriction_history(int, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_notification_restriction_history(int, timestamptz) TO authenticated;
