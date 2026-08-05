-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N3 seam-review round — the player history gains KEYSET PAGINATION.
--
-- The sweep caught the gap: the UI asked for 10 rows, the RPC hard-caps at 200, and nothing
-- offered a route to anything older — so after eleven changes the oldest was unreachable while
-- the surface claimed every change is visible.
--
-- The cursor is COMPOSITE (created_at, id): multiple audit rows can share one transaction
-- timestamp, and a timestamp-only cursor would permanently skip every unreturned row equal to
-- the boundary. Row-value comparison keeps the walk total and deterministic. The row id is an
-- opaque uuid — exposing it to the player identifies nothing.
--
-- (The 1-arg overload is dropped as hygiene; note that 1-arg CALLS still succeed via the
-- p_before defaults — the drop prevents a stale second DEFINITION lingering, not short calls.)
-- ═══════════════════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.get_my_notification_restriction_history(int);
DROP FUNCTION IF EXISTS public.get_my_notification_restriction_history(int, timestamptz);

CREATE OR REPLACE FUNCTION public.get_my_notification_restriction_history(
  p_limit int DEFAULT 50,
  p_before timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL
) RETURNS TABLE (
  id uuid,
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
  IF (p_before IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'get_my_notification_restriction_history: the cursor is COMPOSITE — pass both p_before and p_before_id, or neither';
  END IF;
  RETURN QUERY
  SELECT au.id, au.academy_profile_id, a.name, au.event_type, au.channel,
         au.old_max_frequency, au.new_max_frequency, au.reason, au.created_at
    FROM public.academy_notification_restriction_audit au
    JOIN public.academy_profiles a ON a.id = au.academy_profile_id
   WHERE au.academy_profile_id IN (SELECT public.notif_my_academy_ids())
     AND (p_before IS NULL OR (au.created_at, au.id) < (p_before, p_before_id))
   ORDER BY au.created_at DESC, au.id DESC
   LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.get_my_notification_restriction_history(int, timestamptz, uuid) IS
  'N3: the audit trail of cap changes in the CALLING account''s academies, keyset-paginated on the COMPOSITE (created_at, id) — a timestamp-only cursor would skip rows sharing a transaction timestamp at a page boundary. Both cursor parts or neither. Actor identity deliberately withheld from players.';

REVOKE ALL ON FUNCTION public.get_my_notification_restriction_history(int, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_notification_restriction_history(int, timestamptz, uuid) TO authenticated;
