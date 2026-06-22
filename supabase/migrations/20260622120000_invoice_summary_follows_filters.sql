-- Make the academy invoice scoreboard cards follow the same filters as the table.
--
-- Previously get_academy_invoice_summary only accepted trainer + location, so the
-- top cards updated on those but ignored status / search / delivery / no-email.
-- We add those params (DEFAULT NULL → backward-compatible: the tab-total call that
-- passes only trainer+location still resolves via defaults) and apply the SAME
-- predicates as get_academy_invoices, so the cards reflect the filtered rows.
--
-- NOTE: the cards summary intentionally does NOT apply p_tab — the four figures are
-- a cross-status breakdown (unpaid € / unpaid count / paid count / draft count); the
-- tab-label counts come from a separate, filter-light call to this same function.

DROP FUNCTION IF EXISTS public.get_academy_invoice_summary(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.get_academy_invoice_summary(
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

REVOKE ALL ON FUNCTION public.get_academy_invoice_summary(uuid,uuid,uuid,text,text,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_academy_invoice_summary(uuid,uuid,uuid,text,text,boolean,text) TO authenticated;

COMMENT ON FUNCTION public.get_academy_invoice_summary(uuid,uuid,uuid,text,text,boolean,text) IS
  'Academy invoice scoreboard. With only trainer/location it returns the cross-status totals (tab labels); with status/search/no_email/delivery it mirrors get_academy_invoices'' filters so the cards match the table. p_tab is intentionally not applied.';
