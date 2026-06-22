-- Make the academy invoices scoreboard cards follow the same filters as the table.
--
-- The existing get_academy_invoice_summary only accepts trainer + location, so the
-- top cards updated on those but ignored status / search / delivery / no-email.
--
-- This is PURELY ADDITIVE: we create a SEPARATE function (no DROP / no REPLACE of the
-- existing one) so there is nothing destructive and no dependency on the existing
-- function's exact shape (prod has drifted from the migration history). The frontend
-- keeps using get_academy_invoice_summary for the stable tab-label totals and calls
-- this new function for the filtered cards.
--
-- NOTE: this summary intentionally does NOT apply p_tab — the four figures are a
-- cross-status breakdown (unpaid € / unpaid count / paid count / draft count).

CREATE OR REPLACE FUNCTION public.get_academy_invoice_summary_filtered(
  p_academy_profile_id uuid,
  p_trainer_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_status text DEFAULT NULL,      -- computed_status: open|sent|overdue|draft|paid|cancelled | NULL
  p_search text DEFAULT NULL,      -- ILIKE on player_name / invoice_number
  p_no_email boolean DEFAULT false,
  p_delivery text DEFAULT NULL)    -- undelivered|bounced|no_email|delivered | NULL
RETURNS TABLE (sum_unpaid numeric, count_unpaid bigint, count_paid bigint, count_draft bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
BEGIN
  IF NOT public.is_academy_manager(auth.uid(), p_academy_profile_id) THEN
    RAISE EXCEPTION 'not authorized for academy %', p_academy_profile_id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH inv AS (
    SELECT i.status, i.sent_at, i.total, i.trainer_id, i.player_name, i.invoice_number,
      coalesce(nullif(btrim(pr.email), ''), nullif(btrim(gp.email), '')) AS r_linked_email,
      -- first booking's slot location, skipping bookings whose slot has no location
      (SELECT s.location_id
         FROM public.bookings b
         JOIN public.availability_slots s ON s.id = b.slot_id
        WHERE b.id = ANY (coalesce(i.booking_ids, '{}'::uuid[]))
          AND s.location_id IS NOT NULL
        ORDER BY array_position(i.booking_ids, b.id)
        LIMIT 1) AS r_location_id,
      CASE
        WHEN i.status = 'paid' THEN 'paid'
        WHEN i.status = 'cancelled' THEN 'cancelled'
        WHEN i.sent_at IS NOT NULL AND now() > i.due_date::timestamptz THEN 'overdue'
        WHEN i.sent_at IS NOT NULL THEN 'sent'
        WHEN i.status = 'draft' THEN 'draft'
        ELSE 'open'
      END AS r_computed_status,
      -- only needed for the delivery filter; skip the per-row function call otherwise
      CASE WHEN p_delivery IS NULL THEN NULL
           ELSE public.get_invoice_delivery_status(i.id) END AS r_delivery_status
    FROM public.invoices i
    LEFT JOIN public.profiles pr      ON pr.id = i.player_id
    LEFT JOIN public.guest_players gp ON gp.id = i.guest_player_id
    WHERE i.academy_profile_id = p_academy_profile_id
  ),
  scoped AS (
    SELECT inv.status, inv.sent_at, inv.total
    FROM inv
    WHERE (p_trainer_id IS NULL OR inv.trainer_id = p_trainer_id)
      AND (p_location_id IS NULL OR inv.r_location_id = p_location_id)
      AND (p_status IS NULL OR inv.r_computed_status = p_status)
      AND (v_search IS NULL OR inv.player_name ILIKE '%' || v_search || '%'
                           OR inv.invoice_number ILIKE '%' || v_search || '%')
      AND (NOT p_no_email OR inv.r_linked_email IS NULL)
      AND (
        p_delivery IS NULL
        OR (p_delivery = 'no_email'    AND inv.r_linked_email IS NULL)
        OR (p_delivery = 'bounced'     AND inv.r_delivery_status IN ('bounced','failed'))
        OR (p_delivery = 'delivered'   AND inv.r_delivery_status = 'delivered')
        OR (p_delivery = 'undelivered' AND (inv.r_linked_email IS NULL OR inv.r_delivery_status IN ('bounced','failed')))
      )
  )
  SELECT
    coalesce(sum(total) FILTER (WHERE status NOT IN ('paid', 'cancelled')), 0)::numeric,  -- owed € (excl. cancelled)
    count(*) FILTER (WHERE status IS DISTINCT FROM 'paid')::bigint,                        -- all not-paid
    count(*) FILTER (WHERE status = 'paid')::bigint,
    count(*) FILTER (WHERE sent_at IS NULL AND status NOT IN ('paid', 'cancelled'))::bigint -- drafts
  FROM scoped;
END;
$$;

REVOKE ALL ON FUNCTION public.get_academy_invoice_summary_filtered(uuid,uuid,uuid,text,text,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_academy_invoice_summary_filtered(uuid,uuid,uuid,text,text,boolean,text) TO authenticated;

COMMENT ON FUNCTION public.get_academy_invoice_summary_filtered(uuid,uuid,uuid,text,text,boolean,text) IS
  'Academy invoice scoreboard cards — mirrors get_academy_invoices'' filters (status/search/no_email/delivery + trainer/location) so the cards match the filtered table. p_tab is intentionally not applied. The plain get_academy_invoice_summary still serves the cross-status tab-label totals.';
