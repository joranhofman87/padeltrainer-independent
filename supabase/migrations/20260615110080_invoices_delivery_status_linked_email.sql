-- Email delivery visibility on the TrainerEarnings invoice list (src/components/
-- trainer/InvoiceList.tsx) — the last trainer surface without a delivery flag.
-- That list fetches raw invoice rows client-side, so it can't resolve the
-- recipient email under RLS. Extend the existing authorized batch RPC to ALSO
-- return linked_email (profile -> guest), so the shared InvoiceDeliveryChip can
-- show "No email" / bounced flags there too.
--
-- The caller-visibility gate is UNCHANGED (academy manager / trainer owner /
-- admin), so linked_email is only ever exposed for invoices the caller already
-- manages. Return shape changes -> DROP first. Only consumer is the (orphaned)
-- useInvoicesDeliveryStatus helper, updated in the same change.

DROP FUNCTION IF EXISTS public.get_invoices_delivery_status(uuid[]);

CREATE OR REPLACE FUNCTION public.get_invoices_delivery_status(p_invoice_ids uuid[])
RETURNS TABLE (invoice_id uuid, delivery_status text, linked_email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT i.id,
         public.get_invoice_delivery_status(i.id),
         coalesce(nullif(btrim(pr.email), ''), nullif(btrim(gp.email), ''))
  FROM public.invoices i
  LEFT JOIN public.profiles pr      ON pr.id = i.player_id
  LEFT JOIN public.guest_players gp ON gp.id = i.guest_player_id
  WHERE i.id = ANY (coalesce(p_invoice_ids, '{}'::uuid[]))
    AND (
      (i.academy_profile_id IS NOT NULL AND public.is_academy_manager(auth.uid(), i.academy_profile_id))
      OR i.trainer_id IN (SELECT tp.id FROM public.trainer_profiles tp WHERE tp.user_id = auth.uid())
      OR public.is_admin(auth.uid())
    );
$$;

COMMENT ON FUNCTION public.get_invoices_delivery_status(uuid[]) IS
  'Email delivery tracking: per-invoice delivery status + resolved recipient email (linked_email) for a page of invoices the caller is authorized for (academy manager / trainer owner / admin).';
REVOKE ALL ON FUNCTION public.get_invoices_delivery_status(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_invoices_delivery_status(uuid[]) TO authenticated;
