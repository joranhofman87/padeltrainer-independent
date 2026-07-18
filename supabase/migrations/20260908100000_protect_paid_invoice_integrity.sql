-- Audit follow-up (#4b): a paid invoice is a permanent financial record. Until now
-- nothing at the DB level stopped a paid invoice from being hard-DELETEd or having
-- its money rewritten — RLS only restricts trainers/academy managers to draft
-- deletes, and both the "Admins can delete invoices" policy AND every service_role
-- edge path bypass RLS entirely. This trigger is the DB-final backstop that even
-- admin/service_role writes cannot get around.
--
-- Scope (deliberately narrow — verified against every invoice writer so it breaks
-- no legitimate flow):
--   * DELETE of a paid invoice → blocked. No path hard-deletes paid invoices:
--     deleteOrCancelInvoices() deletes ONLY drafts (soft-cancels the rest), and
--     GDPR erasure RETAINS invoices (anonymizes player_id, never deletes).
--   * UPDATE that changes total / subtotal / vat_amount while the row IS paid →
--     blocked. Every amount writer already excludes paid: recalculate-invoices and
--     bulk-update-vat filter status in (draft,sent,pending); invoiceSync skips
--     non-unpaid; split-invoice refuses paid; the reversal path is alert-only; the
--     GDPR anonymizer only nulls player_id. Correcting a paid invoice is done by
--     cancel + reissue (a NEW row), never by mutating the settled one.
-- Status transitions (paid → cancelled/refunded), pdf_url, delivery flags, billing
-- details, booking_ids, etc. on a paid invoice are all still allowed.

CREATE OR REPLACE FUNCTION public.protect_paid_invoice_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'paid' THEN
      RAISE EXCEPTION 'Cannot delete paid invoice % — paid invoices are permanent financial records; soft-cancel (status=cancelled) instead.', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE: once the invoice is paid its financial amounts are frozen.
  IF OLD.status = 'paid' AND (
       NEW.total      IS DISTINCT FROM OLD.total
    OR NEW.subtotal   IS DISTINCT FROM OLD.subtotal
    OR NEW.vat_amount IS DISTINCT FROM OLD.vat_amount
  ) THEN
    RAISE EXCEPTION 'Cannot change the amount of paid invoice % (total/subtotal/vat_amount are frozen once paid) — cancel and reissue instead.', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_paid_invoice_integrity ON public.invoices;
CREATE TRIGGER trg_protect_paid_invoice_integrity
  BEFORE DELETE OR UPDATE ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_paid_invoice_integrity();
