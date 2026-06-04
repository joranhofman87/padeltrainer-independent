-- PR-2: Players may only update billing fields on their own invoices (RLS policy unchanged;
-- this trigger blocks mutations to financial / workflow columns when the caller is the invoice player).
--
-- Known edge case (acceptable for this PR; see docs/P0_PR1_PR4_NOTES.md, GitHub issue #1):
-- If the logged-in trainer/academy user is also invoice.player_id, financial edits from staff
-- UIs may be blocked. Follow-up: exempt invoice owner roles before applying the player guard.

CREATE OR REPLACE FUNCTION public.protect_invoice_financial_columns_for_players()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player_profile_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  v_player_profile_id := public.get_profile_id_for_user(auth.uid());
  IF v_player_profile_id IS NULL OR NEW.player_id IS DISTINCT FROM v_player_profile_id THEN
    RETURN NEW;
  END IF;

  IF OLD.status IN ('paid', 'cancelled') THEN
    RAISE EXCEPTION 'invoice_locked'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
    OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
    OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
    OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
    OR NEW.vat_amount IS DISTINCT FROM OLD.vat_amount
    OR NEW.vat_rate IS DISTINCT FROM OLD.vat_rate
    OR NEW.total IS DISTINCT FROM OLD.total
    OR NEW.line_items IS DISTINCT FROM OLD.line_items
    OR NEW.vat_breakdown IS DISTINCT FROM OLD.vat_breakdown
    OR NEW.mollie_payment_id IS DISTINCT FROM OLD.mollie_payment_id
    OR NEW.mollie_payment_url IS DISTINCT FROM OLD.mollie_payment_url
    OR NEW.booking_ids IS DISTINCT FROM OLD.booking_ids
    OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
    OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
    OR NEW.due_date IS DISTINCT FROM OLD.due_date
    OR NEW.trainer_id IS DISTINCT FROM OLD.trainer_id
    OR NEW.academy_profile_id IS DISTINCT FROM OLD.academy_profile_id
    OR NEW.guest_player_id IS DISTINCT FROM OLD.guest_player_id
    OR NEW.player_id IS DISTINCT FROM OLD.player_id
    OR NEW.player_name IS DISTINCT FROM OLD.player_name
    OR NEW.public_token IS DISTINCT FROM OLD.public_token
    OR NEW.public_token_revoked_at IS DISTINCT FROM OLD.public_token_revoked_at
    OR NEW.forwarded_at IS DISTINCT FROM OLD.forwarded_at
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW.prices_include_vat IS DISTINCT FROM OLD.prices_include_vat
  THEN
    RAISE EXCEPTION 'players_may_only_update_billing_fields'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_invoice_financial_columns_for_players ON public.invoices;
CREATE TRIGGER trg_protect_invoice_financial_columns_for_players
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_invoice_financial_columns_for_players();
