-- Public-booking audit P0-1: a logged-in player could self-INSERT a booking with
-- payment_status='paid' (+ paid_at / mollie ids) and get a CONFIRMED seat that looks
-- PAID without ever paying. The pay-first rule was enforced only in the React client.
--
-- Why the DB let it through:
--   * The bookings INSERT RLS policy (20260325214344) is WITH CHECK (player_id = self) —
--     it constrains ONLY player_id, nothing about payment.
--   * enforce_booking_slot_tier (20260610220000) is the only BEFORE INSERT trigger and
--     checks capacity + slot tier ONLY, never payment.
--   * protect_booking_financial_columns_for_players (20260624120000) is BEFORE UPDATE —
--     it never fires on the direct client INSERT (its own header says so).
--
-- Fix: the INSERT-side counterpart of that UPDATE guard. On a PLAYER self-insert
-- (auth.uid() resolves to NEW.player_id), FORCE the proof-of-online-payment columns to
-- their safe defaults. Every legitimate player self-insert already sets
-- payment_status='pending' with no paid_at / mollie ids (BookLesson.tsx), so this is a
-- no-op for real bookings and only neutralises the masquerade — a forged 'paid' insert
-- becomes an ordinary unpaid pending booking the academy can see and chase.
--
-- FORCE (not RAISE): legitimate inserts are unaffected, and an abusive insert still
-- succeeds but as a harmless unpaid row — no legit flow can be broken by an unanticipated
-- value. Service-role writes (webhook, book_slot_for_payment, sync-invoice-to-bookings)
-- run with auth.uid() = NULL and pass through. Staff booking OTHER players
-- (player_id != caller) pass through — other guards govern those.
--
-- NOTE (companion follow-up): paid_externally=true is left ALONE here because it is a
-- LEGITIMATE player self-insert value for manual-invoicing cycles (BookLesson.tsx sets it
-- for payment_timing='manual'). Blocking the manual-invoicing self-insert abuse (audit
-- P2) needs the slot's cycle payment_timing and is a separate, cycle-aware change.

CREATE OR REPLACE FUNCTION public.protect_booking_payment_on_player_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player_profile_id uuid;
BEGIN
  -- Service role / unauthenticated server writes (webhook, book_slot_for_payment,
  -- sync-invoice-to-bookings): not a logged-in player → trusted, pass through.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  v_player_profile_id := public.get_profile_id_for_user(auth.uid());

  -- Not the booking's own player (manager/trainer/admin booking someone else, or no
  -- profile) → other policies/guards govern; don't interfere.
  IF v_player_profile_id IS NULL OR NEW.player_id IS DISTINCT FROM v_player_profile_id THEN
    RETURN NEW;
  END IF;

  -- The caller is inserting their OWN booking: they may NOT assert proof of an online
  -- payment. Coerce the money-received columns to safe defaults regardless of input.
  NEW.payment_status := 'pending';
  NEW.paid_at := NULL;
  NEW.mollie_payment_id := NULL;
  NEW.mollie_transaction_id := NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_booking_payment_on_player_insert ON public.bookings;
CREATE TRIGGER trg_protect_booking_payment_on_player_insert
  BEFORE INSERT ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_booking_payment_on_player_insert();
