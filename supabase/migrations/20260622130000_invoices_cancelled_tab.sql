-- Give cancelled invoices their own tab so they stop polluting the pending list.
--
-- Part 1 of this migration is non-destructive:
--   (A) CREATE OR REPLACE get_academy_invoice_summary_filtered — exclude cancelled
--       from count_unpaid (cancelled is its own tab now; € owed already excluded it).
--   (B) CREATE get_academy_invoice_cancelled_count — count for the Geannuleerd tab.
-- Part 2 (the 3-way tab split in get_academy_invoices) is applied separately, based
-- on the live prod definition, to avoid disturbing drifted columns/body.

-- (A) count_unpaid now excludes cancelled (NULL-safe, mirrors the rows partition).
CREATE OR REPLACE FUNCTION public.get_academy_invoice_summary_filtered(
  p_academy_profile_id uuid,
  p_trainer_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_no_email boolean DEFAULT false,
  p_delivery text DEFAULT NULL)
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
    coalesce(sum(total) FILTER (WHERE status NOT IN ('paid', 'cancelled')), 0)::numeric,
    -- pending = not paid AND not cancelled (NULL-safe)
    count(*) FILTER (WHERE status IS DISTINCT FROM 'paid' AND status IS DISTINCT FROM 'cancelled')::bigint,
    count(*) FILTER (WHERE status = 'paid')::bigint,
    count(*) FILTER (WHERE sent_at IS NULL AND status NOT IN ('paid', 'cancelled'))::bigint
  FROM scoped;
END;
$$;

REVOKE ALL ON FUNCTION public.get_academy_invoice_summary_filtered(uuid,uuid,uuid,text,text,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_academy_invoice_summary_filtered(uuid,uuid,uuid,text,text,boolean,text) TO authenticated;

-- (B) cancelled-invoice count for the Geannuleerd tab label (trainer/location-scoped).
CREATE OR REPLACE FUNCTION public.get_academy_invoice_cancelled_count(
  p_academy_profile_id uuid,
  p_trainer_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  IF NOT public.is_academy_manager(auth.uid(), p_academy_profile_id) THEN
    RAISE EXCEPTION 'not authorized for academy %', p_academy_profile_id USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_count
  FROM public.invoices i
  WHERE i.academy_profile_id = p_academy_profile_id
    AND i.status = 'cancelled'
    AND (p_trainer_id IS NULL OR i.trainer_id = p_trainer_id)
    AND (p_location_id IS NULL OR p_location_id = (
      SELECT s.location_id FROM public.bookings b
        JOIN public.availability_slots s ON s.id = b.slot_id
       WHERE b.id = ANY (coalesce(i.booking_ids, '{}'::uuid[])) AND s.location_id IS NOT NULL
       ORDER BY array_position(i.booking_ids, b.id) LIMIT 1));
  RETURN coalesce(v_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.get_academy_invoice_cancelled_count(uuid,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_academy_invoice_cancelled_count(uuid,uuid,uuid) TO authenticated;

-- Part 2: 3-way tab partition in the rows query. Based verbatim on the live prod
-- definition; the ONLY change is the `filtered` WHERE partition (paid | cancelled |
-- unpaid=neither). Non-destructive CREATE OR REPLACE (same signature + columns).
CREATE OR REPLACE FUNCTION public.get_academy_invoices(
  p_academy_profile_id uuid, p_tab text DEFAULT 'unpaid'::text, p_status text DEFAULT NULL::text,
  p_search text DEFAULT NULL::text, p_trainer_id uuid DEFAULT NULL::uuid, p_location_id uuid DEFAULT NULL::uuid,
  p_no_email boolean DEFAULT false, p_delivery text DEFAULT NULL::text, p_sort text DEFAULT 'created_at'::text,
  p_sort_dir text DEFAULT 'desc'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS TABLE(academy_profile_id uuid, booking_ids uuid[], created_at timestamp with time zone, due_date date,
  forwarded_at timestamp with time zone, guest_player_id uuid, id uuid, invoice_date date, invoice_number text,
  line_items jsonb, mollie_payment_id text, mollie_payment_url text, notes text, paid_at timestamp with time zone,
  pdf_url text, player_address text, player_btw_number text, player_business_name text, player_id uuid,
  player_name text, prices_include_vat boolean, public_token uuid, public_token_revoked_at timestamp with time zone,
  sent_at timestamp with time zone, split_count integer, status text, subtotal numeric, total numeric,
  trainer_id uuid, updated_at timestamp with time zone, vat_amount numeric, vat_breakdown jsonb, vat_rate numeric,
  linked_email text, location_id uuid, computed_status text, delivery_status text, total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
BEGIN
  IF NOT public.is_academy_manager(auth.uid(), p_academy_profile_id) THEN
    RAISE EXCEPTION 'not authorized for academy %', p_academy_profile_id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH inv AS (
    SELECT i.*,
      coalesce(nullif(btrim(pr.email), ''), nullif(btrim(gp.email), '')) AS r_linked_email,
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
      public.get_invoice_delivery_status(i.id) AS r_delivery_status
    FROM public.invoices i
    LEFT JOIN public.profiles pr      ON pr.id = i.player_id
    LEFT JOIN public.guest_players gp ON gp.id = i.guest_player_id
    WHERE i.academy_profile_id = p_academy_profile_id
  ),
  filtered AS (
    SELECT inv.* FROM inv
    -- 3-way tab partition: paid | cancelled | unpaid(=neither). Still a COMPLETE,
    -- NULL-safe partition — cancelled now has its own tab; NULL/unknown stay unpaid.
    WHERE ( (p_tab = 'paid'      AND inv.status = 'paid')
         OR (p_tab = 'cancelled' AND inv.status = 'cancelled')
         OR (p_tab NOT IN ('paid','cancelled')
             AND inv.status IS DISTINCT FROM 'paid'
             AND inv.status IS DISTINCT FROM 'cancelled') )
      AND (p_status IS NULL OR inv.r_computed_status = p_status)
      AND (p_trainer_id IS NULL OR inv.trainer_id = p_trainer_id)
      AND (p_location_id IS NULL OR inv.r_location_id = p_location_id)
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
  ),
  page AS (
    SELECT f.*, count(*) OVER () AS f_total_count
    FROM filtered f
    ORDER BY
      CASE WHEN p_sort = 'player_name' AND p_sort_dir = 'asc'  THEN lower(f.player_name) END ASC,
      CASE WHEN p_sort = 'player_name' AND p_sort_dir = 'desc' THEN lower(f.player_name) END DESC,
      CASE WHEN p_sort = 'total'       AND p_sort_dir = 'asc'  THEN f.total END ASC,
      CASE WHEN p_sort = 'total'       AND p_sort_dir = 'desc' THEN f.total END DESC,
      CASE WHEN p_sort = 'due_date'    AND p_sort_dir = 'asc'  THEN f.due_date END ASC,
      CASE WHEN p_sort = 'due_date'    AND p_sort_dir = 'desc' THEN f.due_date END DESC,
      CASE WHEN p_sort = 'status'      AND p_sort_dir = 'asc'  THEN f.r_computed_status END ASC,
      CASE WHEN p_sort = 'status'      AND p_sort_dir = 'desc' THEN f.r_computed_status END DESC,
      CASE WHEN p_sort = 'paid_at'     AND p_sort_dir = 'asc'  THEN f.paid_at END ASC,
      CASE WHEN p_sort = 'paid_at'     AND p_sort_dir = 'desc' THEN f.paid_at END DESC,
      CASE WHEN p_sort = 'created_at'  AND p_sort_dir = 'asc'  THEN f.created_at END ASC,
      f.created_at DESC,
      f.id DESC
    LIMIT v_limit OFFSET v_offset
  )
  SELECT
    p.academy_profile_id, p.booking_ids, p.created_at, p.due_date, p.forwarded_at,
    p.guest_player_id, p.id, p.invoice_date, p.invoice_number, p.line_items,
    p.mollie_payment_id, p.mollie_payment_url, p.notes, p.paid_at, p.pdf_url,
    p.player_address, p.player_btw_number, p.player_business_name, p.player_id,
    p.player_name, p.prices_include_vat, p.public_token, p.public_token_revoked_at,
    p.sent_at, p.split_count, p.status, p.subtotal, p.total, p.trainer_id,
    p.updated_at, p.vat_amount, p.vat_breakdown, p.vat_rate,
    p.r_linked_email, p.r_location_id, p.r_computed_status, p.r_delivery_status, p.f_total_count
  FROM page p;
END;
$function$;
