-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N3 M6 (read side) — what an academy manager may SEE about notification outcomes.
-- Design contract findings 4 + 11 (thread 019fd175-f39e-73a3-80c3-7c43f6b13f97).
--
-- FINDING 4's boundary, honoured: `notification_row_visible_to_caller` is NOT widened. Player-
-- recipient events are `private_user_only` and stay invisible to managers — the outcomes list
-- below serves ONLY rows the visibility model already marks tenant-visible, redacted exactly as
-- the tenant timelines do (destination_redacted + public_summary; never payload, never raw
-- destination, never contact ids). The M6 surface states this limitation in copy rather than
-- pretending coverage.
--
-- FINDING 11's requirement, honoured WITHOUT identities: a manager who caps an event must be
-- able to see the cap WORKING, but a per-row listing of private events would leak recipient
-- identities through the back door. The impact read is therefore AGGREGATE-ONLY: counts per
-- event × channel × day, no recipient keys, no destinations, no ids — enough to see "37 sends
-- restricted yesterday", never WHO.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_academy_notification_outcomes(
  p_academy_profile_id uuid,
  p_limit int DEFAULT 50
) RETURNS TABLE (
  event_type text,
  channel text,
  status text,
  skip_reason text,
  destination_redacted text,
  public_summary jsonb,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_academy_manager(auth.uid(), p_academy_profile_id) THEN
    RAISE EXCEPTION 'get_academy_notification_outcomes: not a manager of this academy';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'get_academy_notification_outcomes: limit must be 1..200';
  END IF;
  RETURN QUERY
  SELECT o.event_type, o.channel, o.status, o.skip_reason,
         o.destination_redacted, o.public_summary, o.created_at
    FROM public.notification_outbox o
   WHERE o.tenant_academy_profile_id = p_academy_profile_id
     AND o.visibility_scope IN ('tenant_visible', 'tenant_visible_limited')
   ORDER BY o.created_at DESC
   LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.get_academy_notification_outcomes(uuid, int) IS
  'N3: recent notification outcomes for ONE academy — ONLY rows the visibility model already marks tenant-visible, projected exactly as the tenant timelines project them (redacted destination + sanitized summary; never payload/raw destination/contact ids). Player-recipient private events are deliberately absent; the surface says so. Manager-checked per call.';

REVOKE ALL ON FUNCTION public.get_academy_notification_outcomes(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_academy_notification_outcomes(uuid, int) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_academy_restriction_impact(
  p_academy_profile_id uuid,
  p_days int DEFAULT 30
) RETURNS TABLE (
  event_type text,
  channel text,
  day date,
  restricted_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_academy_manager(auth.uid(), p_academy_profile_id) THEN
    RAISE EXCEPTION 'get_academy_restriction_impact: not a manager of this academy';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
    RAISE EXCEPTION 'get_academy_restriction_impact: days must be 1..90';
  END IF;
  -- AGGREGATE-ONLY by contract: the cap's effect on PRIVATE events is countable, never
  -- enumerable — no recipient keys, no destinations, no row ids leave this function.
  RETURN QUERY
  SELECT o.event_type, o.channel, o.created_at::date AS day, count(*) AS restricted_count
    FROM public.notification_outbox o
   WHERE o.tenant_academy_profile_id = p_academy_profile_id
     AND o.skip_reason = 'tenant_restricted'
     AND o.created_at >= now() - make_interval(days => p_days)
   GROUP BY o.event_type, o.channel, o.created_at::date
   ORDER BY day DESC, o.event_type, o.channel;
END;
$$;

COMMENT ON FUNCTION public.get_academy_restriction_impact(uuid, int) IS
  'N3: the caps WORKING, as counts — tenant_restricted outcomes per event × channel × day for ONE academy. Aggregate-only by contract: a per-row listing of private events would leak recipient identities; a count cannot. Manager-checked per call.';

REVOKE ALL ON FUNCTION public.get_academy_restriction_impact(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_academy_restriction_impact(uuid, int) TO authenticated;
