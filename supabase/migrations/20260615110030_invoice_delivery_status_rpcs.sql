-- Email delivery tracking — read signals for the UI (additive; no surgery on the
-- paginated money RPCs). Three SECURITY DEFINER functions:
--   get_invoice_delivery_status(invoice)      -> latest delivery status for one invoice
--   get_invoices_delivery_status(invoice[])   -> batch (per page of the invoice list)
--   get_academy_undeliverable_recipients(ac)  -> the academy's players whose email is
--                                                undeliverable (dashboard count + fix-it card)
--
-- (Deferred convenience, not in v1: a server-side "bounced" filter on the paginated
--  invoice lists — the per-row indicator + player badge + the recipients list cover
--  "know about it + fix fast" without reproducing those large RPCs.)

-- Latest meaningful delivery status for an invoice. Correlates events both by the
-- invoice_id stamped on rows AND by the Resend message id of the invoice's sent rows
-- (so an un-enriched bounce webhook still maps back). bounce/complaint win on ties.
CREATE OR REPLACE FUNCTION public.get_invoice_delivery_status(p_invoice_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH rel AS (
    SELECT ev.event_type, ev.occurred_at
    FROM public.email_delivery_events ev
    WHERE ev.invoice_id = p_invoice_id
       OR (ev.resend_email_id IS NOT NULL AND ev.resend_email_id IN (
             SELECT s.resend_email_id FROM public.email_delivery_events s
             WHERE s.invoice_id = p_invoice_id AND s.resend_email_id IS NOT NULL))
  )
  SELECT CASE
           WHEN rel.event_type IN ('bounced', 'complained') THEN 'bounced'
           WHEN rel.event_type = 'delivered'                 THEN 'delivered'
           WHEN rel.event_type IN ('send_failed', 'failed')  THEN 'failed'
           WHEN rel.event_type = 'sent'                      THEN 'sent'
           ELSE NULL
         END
  FROM rel
  ORDER BY rel.occurred_at DESC, (rel.event_type IN ('bounced', 'complained')) DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_invoice_delivery_status(uuid) IS
  'Email delivery tracking: latest delivery status (bounced|delivered|failed|sent|NULL) for an invoice.';
REVOKE ALL ON FUNCTION public.get_invoice_delivery_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_invoice_delivery_status(uuid) TO service_role;

-- Batch lookup for the invoice list: only returns statuses for invoices the caller
-- manages (academy manager) / owns (trainer) / admin.
CREATE OR REPLACE FUNCTION public.get_invoices_delivery_status(p_invoice_ids uuid[])
RETURNS TABLE (invoice_id uuid, delivery_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT i.id, public.get_invoice_delivery_status(i.id)
  FROM public.invoices i
  WHERE i.id = ANY (coalesce(p_invoice_ids, '{}'::uuid[]))
    AND (
      (i.academy_profile_id IS NOT NULL AND public.is_academy_manager(auth.uid(), i.academy_profile_id))
      OR i.trainer_id IN (SELECT tp.id FROM public.trainer_profiles tp WHERE tp.user_id = auth.uid())
      OR public.is_admin(auth.uid())
    );
$$;

COMMENT ON FUNCTION public.get_invoices_delivery_status(uuid[]) IS
  'Email delivery tracking: per-invoice delivery status for a page of invoices the caller is authorized for.';
REVOKE ALL ON FUNCTION public.get_invoices_delivery_status(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_invoices_delivery_status(uuid[]) TO authenticated;

-- The academy's players/guests whose RESOLVED email is undeliverable (hard bounce /
-- complaint). Powers the dashboard alert count + the BouncingEmailsCard. Email
-- resolution mirrors get_invoice_recipient_identity (guest -> linked profile first).
CREATE OR REPLACE FUNCTION public.get_academy_undeliverable_recipients(p_academy_profile_id uuid)
RETURNS TABLE (
  player_key      text,
  player_type     text,
  profile_id      uuid,
  guest_player_id uuid,
  full_name       text,
  email           text,
  state           text,
  last_event_at   timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_academy_manager(auth.uid(), p_academy_profile_id) THEN
    RAISE EXCEPTION 'not authorized for academy %', p_academy_profile_id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH members AS (
    SELECT ('p_' || p.id::text)                       AS m_player_key,
           'registered'::text                         AS m_player_type,
           p.id                                       AS m_profile_id,
           NULL::uuid                                 AS m_guest_player_id,
           coalesce(nullif(btrim(p.full_name), ''), '') AS m_full_name,
           lower(btrim(p.email))                      AS m_email
    FROM public.academy_player_metadata m
    JOIN public.profiles p ON p.id = m.profile_id
    WHERE m.academy_profile_id = p_academy_profile_id AND m.removed_at IS NULL
      AND nullif(btrim(p.email), '') IS NOT NULL
    UNION ALL
    SELECT ('g_' || g.id::text),
           'guest'::text,
           g.linked_profile_id,
           g.id,
           coalesce(nullif(btrim(g.full_name), ''), nullif(btrim(lp.full_name), ''), ''),
           lower(btrim(coalesce(nullif(btrim(lp.email), ''), g.email)))
    FROM public.academy_player_metadata m
    JOIN public.guest_players g ON g.id = m.guest_player_id
    LEFT JOIN public.profiles lp ON lp.id = g.linked_profile_id
    WHERE m.academy_profile_id = p_academy_profile_id AND m.removed_at IS NULL
      AND nullif(btrim(coalesce(nullif(btrim(lp.email), ''), g.email)), '') IS NOT NULL
  )
  SELECT DISTINCT ON (mem.m_player_key)
         mem.m_player_key, mem.m_player_type, mem.m_profile_id, mem.m_guest_player_id,
         mem.m_full_name, mem.m_email, s.state, s.last_event_at
  FROM members mem
  JOIN public.email_address_state s ON s.email = mem.m_email
  WHERE s.state IN ('hard_bounced', 'complained')
  ORDER BY mem.m_player_key, mem.m_full_name;
END;
$$;

COMMENT ON FUNCTION public.get_academy_undeliverable_recipients(uuid) IS
  'Email delivery tracking: the academy''s players/guests whose resolved email is undeliverable (hard bounce/complaint). Dashboard alert count + fix-it card. SECURITY DEFINER, is_academy_manager authorized.';
REVOKE ALL ON FUNCTION public.get_academy_undeliverable_recipients(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_academy_undeliverable_recipients(uuid) TO authenticated;
