-- PR 10c-a3 — one forward-only RPC the digest WORKER needs: terminalize a RENDERED single-item group whose
-- rendered {to,subject,html} exceeds the ~90 KB store budget (§CH). Multi-item oversize groups SPLIT (existing
-- split RPC → smaller children); a single item that renders oversize cannot be reduced, so it must terminalize
-- as oversize_failed — otherwise the worker would render→reject→re-claim it forever. INERT: nothing calls this
-- until the worker runs, and the worker's kill switch keeps it off. SQL-only, no digest event enabled.
--
-- Ownership + run + state gated exactly like store/begin; goes through notif_digest_finalize_group so members
-- are finalized (§MEM) + scrubbed and attempt ownership is cleared, same as every other terminal transition.
CREATE OR REPLACE FUNCTION public.finalize_notification_digest_render_oversize(
    p_run_id uuid, p_group_id uuid, p_worker text, p_now timestamptz)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g record;
BEGIN
  SELECT * INTO g FROM public.notification_digest_groups
   WHERE id = p_group_id AND state IN ('prepared','request_ready') AND locked_by = p_worker AND worker_run_id = p_run_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'render_oversize: group % not owned/prepared by % (run %)', p_group_id, p_worker, p_run_id;
  END IF;
  PERFORM notif_digest_assert_run(p_run_id, 'dispatch', g.channel);
  -- a group with more than one member MUST be split (reducible), never terminalized — only a single item that
  -- cannot fit is a genuine render oversize.
  IF g.item_count > 1 THEN
    RAISE EXCEPTION 'render_oversize: group % has % members and must be split, not terminalized', p_group_id, g.item_count;
  END IF;
  PERFORM notif_digest_finalize_group(p_group_id, 'oversize_failed', 'render_oversize', p_now);
  PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'oversize_failed', 0);
END $$;

-- ACL: operational entrypoint — service_role EXECUTE only (Supabase's default EXECUTE-to-all is revoked).
REVOKE ALL ON FUNCTION public.finalize_notification_digest_render_oversize(uuid, uuid, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_notification_digest_render_oversize(uuid, uuid, text, timestamptz)
  TO service_role;
