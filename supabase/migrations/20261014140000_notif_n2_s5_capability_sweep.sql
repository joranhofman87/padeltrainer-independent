-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N2 S5 — the capability retention sweep.
--
-- THE RETENTION CONTRACT (N2 §7): a capability may be deleted only once its source can never
-- retry — `expires_at` more than 30 days past — and NEVER merely because it was revoked. The
-- 30-day margin exists because expiry blocks the SEND (S3's attach layer refuses a non-live
-- capability), but a send dispatched just before expiry can still be retried by its sender for
-- a while; deleting the row under such a retry would turn "capability_expired" (truthful) into
-- "pre_cutover_row_requires_new_send" (wrong era). Past expiry + 30 days, every sender path has
-- long since gone terminal.
--
-- REVOCATION IS NOT A DELETION TRIGGER. `revoked_at` is audit state: it explains WHY a link
-- stopped working while the row still answers context lookups with 'revoked' — deleting early
-- would turn that truthful answer into 'missing'. A revoked row leaves through the same
-- expiry+30d door as every other row.
--
-- Suppression provenance (`email_marketing_suppression.capability_id`) deliberately has NO FK to
-- this table: the AUDIT RECORD outlives the capability. Sweeping a capability never touches the
-- suppression it produced.
--
-- BOUNDED per call. The sweep is a maintenance job; an unbounded DELETE on a large table inside
-- one transaction is how maintenance becomes an outage.
--
-- NOT WIRED TO ANY SCHEDULER HERE. Destructive cleanup is an owner gate; the deploy runbook
-- gives the owner the exact cron to install. Shipping this migration alone changes nothing.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.sweep_notification_manage_capabilities(
  p_limit int DEFAULT 1000
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted int;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'sweep_notification_manage_capabilities: limit must be 1..10000';
  END IF;

  WITH doomed AS (
    SELECT c.id
      FROM public.notification_manage_capabilities c
     WHERE c.expires_at < now() - interval '30 days'
     ORDER BY c.expires_at
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.notification_manage_capabilities c
   USING doomed d
   WHERE c.id = d.id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION public.sweep_notification_manage_capabilities(int) IS
  'N2 S5 retention sweep: deletes capabilities whose expires_at is more than 30 days past — the only door out, for revoked rows too (revocation is audit state, not a deletion trigger). Bounded and SKIP LOCKED so it can never wedge a sender mid-read. service_role only; scheduling it is an owner deploy step.';

REVOKE ALL ON FUNCTION public.sweep_notification_manage_capabilities(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_notification_manage_capabilities(int) TO service_role;
