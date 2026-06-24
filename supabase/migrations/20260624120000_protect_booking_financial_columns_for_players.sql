-- B2 (rebook go-live audit): players may NOT mark their own booking paid.
--
-- The RLS policy "Players can update their own bookings" (migration
-- 20260325214344) is FOR UPDATE USING (player_id = get_profile_id_for_user(auth.uid()))
-- with NO WITH CHECK — it exists so a player can cancel their own booking or edit
-- notes. The slot-tier trigger (20260613130000) deliberately lets field-only edits
-- (notes, payment_status) skip its capacity gate. Net effect: a logged-in player can
-- PATCH their own booking row to payment_status='paid' / paid_externally=true and the
-- academy would see a "paid" booking it was never paid for. This mirrors the invoice
-- guard (protect_invoice_financial_columns_for_players, 20260530120000) for bookings:
-- block mutations to financial columns when the caller IS the booking's player.
--
-- Service-role writes (mark-paid edge fns, sync-invoice-to-bookings) run with
-- auth.uid() = NULL and pass through. Manager/trainer writes target a player whose
-- profile != the caller's, so they also pass through. Only the player editing their
-- OWN money columns is blocked. Players keep cancelling (status) and editing notes.
-- The accept/book RPCs (priority_claim_accept, respond_to_priority_claim,
-- book_slot_for_payment) INSERT bookings, so this BEFORE UPDATE trigger never fires
-- for them.
--
-- Known edge case (same tradeoff as the invoice guard, 20260530120000): a
-- trainer/academy user who is ALSO the booking's player and marks their own booking
-- paid from a staff UI is blocked. Rare; acceptable for go-live. Staff normally mark
-- OTHER players' bookings paid (caller != player), which is unaffected.

CREATE OR REPLACE FUNCTION public.protect_booking_financial_columns_for_players()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player_profile_id uuid;
BEGIN
  -- Service role / unauthenticated server writes: not a logged-in player.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  v_player_profile_id := public.get_profile_id_for_user(auth.uid());

  -- Not the booking's own player (manager/trainer/admin acting on someone else's
  -- booking, or no profile) → other policies/guards govern; don't interfere.
  IF v_player_profile_id IS NULL OR NEW.player_id IS DISTINCT FROM v_player_profile_id THEN
    RETURN NEW;
  END IF;

  -- The caller is editing their OWN booking: financial / payment columns are off limits.
  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status
    OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
    OR NEW.paid_externally IS DISTINCT FROM OLD.paid_externally
    OR NEW.payment_amount IS DISTINCT FROM OLD.payment_amount
    OR NEW.original_amount IS DISTINCT FROM OLD.original_amount
    OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
    OR NEW.discount_reason IS DISTINCT FROM OLD.discount_reason
    OR NEW.mollie_payment_id IS DISTINCT FROM OLD.mollie_payment_id
    OR NEW.mollie_transaction_id IS DISTINCT FROM OLD.mollie_transaction_id
  THEN
    RAISE EXCEPTION 'players_may_not_change_booking_payment_fields'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_booking_financial_columns_for_players ON public.bookings;
CREATE TRIGGER trg_protect_booking_financial_columns_for_players
  BEFORE UPDATE ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_booking_financial_columns_for_players();
