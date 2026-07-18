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
--   * UPDATE that changes the financial COMPOSITION or IDENTITY of a paid invoice
--     (total, subtotal, vat_amount, vat_rate, vat_breakdown, line_items,
--     invoice_number, invoice_date) → blocked, INCLUDING a single statement that
--     also flips the row into paid (gate is OLD.status='paid' OR NEW.status='paid').
--     Every composition writer already excludes paid (recalculate-invoices and
--     bulk-update-vat filter status in (draft,sent,pending); invoiceSync skips
--     non-unpaid; split-invoice refuses paid; EditInvoiceDialog hides Edit on paid),
--     the paid transition itself only sets status/paid_at/sent_at, the reversal path
--     is alert-only, and the GDPR anonymizer only nulls player_id. Correcting a paid
--     invoice is done by cancel + reissue (a NEW row), never by mutating it.
-- Status transitions (paid → cancelled/refunded), pdf_url, delivery flags, billing
-- details, booking_ids, notes, due_date on a paid invoice are all still allowed.

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

  -- UPDATE: an invoice's financial COMPOSITION and IDENTITY are frozen once it is
  -- paid — and may not be changed WHILE transitioning it into paid either (so a
  -- single UPDATE cannot set status='paid' together with a rewritten amount). We
  -- gate on OLD.status='paid' OR NEW.status='paid'. Verified against every writer:
  -- the paid transition (auto-create-invoice, markInvoicePaid) only ever sets
  -- status/paid_at/sent_at, and every composition writer (recalculate,
  -- bulk-update-vat, invoiceSync, split) excludes paid while EditInvoiceDialog
  -- hides its Edit button on paid. Still ALLOWED on a paid invoice: status
  -- transitions (cancel/refund),
  -- pdf_url, billing/contact details, delivery flags, booking_ids.
  IF (OLD.status = 'paid' OR NEW.status = 'paid') AND (
       NEW.total          IS DISTINCT FROM OLD.total
    OR NEW.subtotal       IS DISTINCT FROM OLD.subtotal
    OR NEW.vat_amount     IS DISTINCT FROM OLD.vat_amount
    OR NEW.vat_rate       IS DISTINCT FROM OLD.vat_rate
    OR NEW.vat_breakdown  IS DISTINCT FROM OLD.vat_breakdown
    OR NEW.line_items     IS DISTINCT FROM OLD.line_items
    OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
    OR NEW.invoice_date   IS DISTINCT FROM OLD.invoice_date
  ) THEN
    RAISE EXCEPTION 'Cannot change the financial fields of paid invoice % (amounts, VAT rate/breakdown, line items, number and date are frozen once paid) — cancel and reissue instead.', COALESCE(OLD.id, NEW.id)
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
