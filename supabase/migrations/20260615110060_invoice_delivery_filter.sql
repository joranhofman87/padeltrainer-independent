-- Email delivery visibility on the academy invoice list: a per-invoice delivery
-- status + a server-side delivery filter (undelivered/bounced/no_email/delivered),
-- plus a delivery summary RPC for the "X never reached the player" banner.
-- get_academy_invoices gains delivery_status + p_delivery; body is the original
-- (20260614160000) verbatim + those surgical additions. Signature changes -> DROP first.

DROP FUNCTION IF EXISTS public.get_academy_invoices(uuid,text,text,text,uuid,uuid,boolean,text,text,integer,integer);

CREATE OR REPLACE FUNCTION public.get_academy_invoices(
  p_academy_profile_id uuid,
  p_tab text DEFAULT 'unpaid',        -- 'unpaid' | 'paid'
  p_status text DEFAULT NULL,         -- computed_status filter: open|sent|overdue|draft|paid|cancelled | NULL
  p_search text DEFAULT NULL,         -- ILIKE on player_name
  p_trainer_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_no_email boolean DEFAULT false,
  p_delivery text DEFAULT NULL,        -- undelivered|bounced|no_email|delivered|NULL
  p_sort text DEFAULT 'created_at',   -- created_at|paid_at|player_name|total|due_date|status
  p_sort_dir text DEFAULT 'desc',
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  academy_profile_id uuid, booking_ids uuid[], created_at timestamptz, due_date date,
  forwarded_at timestamptz, guest_player_id uuid, id uuid, invoice_date date,
  invoice_number text, line_items jsonb, mollie_payment_id text, mollie_payment_url text,
  notes text, paid_at timestamptz, pdf_url text, player_address text, player_btw_number text,
  player_business_name text, player_id uuid, player_name text, prices_include_vat boolean,
  public_token uuid, public_token_revoked_at timestamptz, sent_at timestamptz,
  split_count integer, status text, subtotal numeric, total numeric, trainer_id uuid,
  updated_at timestamptz, vat_amount numeric, vat_breakdown jsonb, vat_rate numeric,
  linked_email text, location_id uuid, computed_status text, delivery_status text, total_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
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
      public.get_invoice_delivery_status(i.id) AS r_delivery_status
    FROM public.invoices i
    LEFT JOIN public.profiles pr      ON pr.id = i.player_id
    LEFT JOIN public.guest_players gp ON gp.id = i.guest_player_id
    WHERE i.academy_profile_id = p_academy_profile_id
  ),
  filtered AS (
    SELECT inv.* FROM inv
    WHERE ( (p_tab = 'paid'   AND inv.status = 'paid')
         OR (p_tab <> 'paid' AND inv.status NOT IN ('paid', 'cancelled')) )
      AND (p_status IS NULL OR inv.r_computed_status = p_status)
      AND (p_trainer_id IS NULL OR inv.trainer_id = p_trainer_id)
      AND (p_location_id IS NULL OR inv.r_location_id = p_location_id)
      AND (v_search IS NULL OR inv.player_name ILIKE '%' || v_search || '%')
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
      f.created_at DESC,   -- default order + deterministic primary tail
      f.id DESC            -- unique tiebreaker (created_at is not unique)
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
$$;

COMMENT ON FUNCTION public.get_academy_invoices(uuid,text,text,text,uuid,uuid,boolean,text,text,text,integer,integer) IS
  'Paginated academy invoice list (P-RD-001): page slice + total_count, server-side filters/search/sort, no 1000-row truncation. SECURITY DEFINER, scope-authorized via is_academy_manager.';
REVOKE ALL ON FUNCTION public.get_academy_invoices(uuid,text,text,text,uuid,uuid,boolean,text,text,text,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_academy_invoices(uuid,text,text,text,uuid,uuid,boolean,text,text,text,integer,integer) TO authenticated;

-- Delivery breakdown for the current tab/trainer/location view (drives the banner).
CREATE OR REPLACE FUNCTION public.get_academy_invoice_delivery_summary(
  p_academy_profile_id uuid,
  p_tab text DEFAULT 'unpaid',
  p_trainer_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL
)
RETURNS TABLE (total bigint, no_email bigint, bounced bigint, delivered bigint, pending bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_academy_manager(auth.uid(), p_academy_profile_id) THEN
    RAISE EXCEPTION 'not authorized for academy %', p_academy_profile_id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      coalesce(nullif(btrim(pr.email), ''), nullif(btrim(gp.email), '')) AS linked_email,
      public.get_invoice_delivery_status(i.id) AS dstatus,
      (SELECT s.location_id FROM public.bookings b JOIN public.availability_slots s ON s.id = b.slot_id
        WHERE b.id = ANY (coalesce(i.booking_ids, '{}'::uuid[])) AND s.location_id IS NOT NULL
        ORDER BY array_position(i.booking_ids, b.id) LIMIT 1) AS loc
    FROM public.invoices i
    LEFT JOIN public.profiles pr      ON pr.id = i.player_id
    LEFT JOIN public.guest_players gp ON gp.id = i.guest_player_id
    WHERE i.academy_profile_id = p_academy_profile_id
      AND ((p_tab = 'paid' AND i.status = 'paid') OR (p_tab <> 'paid' AND i.status NOT IN ('paid', 'cancelled')))
      AND (p_trainer_id IS NULL OR i.trainer_id = p_trainer_id)
  )
  SELECT
    count(*)::bigint,
    count(*) FILTER (WHERE linked_email IS NULL)::bigint,
    count(*) FILTER (WHERE dstatus IN ('bounced', 'failed'))::bigint,
    count(*) FILTER (WHERE dstatus = 'delivered')::bigint,
    count(*) FILTER (WHERE dstatus = 'sent')::bigint
  FROM base
  WHERE (p_location_id IS NULL OR loc = p_location_id);
END;
$$;
REVOKE ALL ON FUNCTION public.get_academy_invoice_delivery_summary(uuid, text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_academy_invoice_delivery_summary(uuid, text, uuid, uuid) TO authenticated;
