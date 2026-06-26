-- Phase 4 F2 — update_cycle_pricing: adopt the canonical cycle-level lock order (owner-deployed).
--
-- update_cycle_pricing (migration 20260614120000) already atomically writes the cycle row AND every
-- linked availability_slot in one transaction (the MULTI-004 fix — billing reads the slot price, so
-- the two must commit together). This is a FAITHFUL re-statement of that function with ONE addition:
-- it now locks the cycle's slots in id order BEFORE repricing them.
--
-- WHY: apply_slot_edit_to_cycle / apply_slot_delete_to_cycle (Phase 4 F2) take their locks in the
-- canonical order cycle row → slots (ORDER BY id) FOR UPDATE. update_cycle_pricing previously locked
-- the cycle row but then took slot locks in scan order during its UPDATE. Two cycle-level RPCs acting
-- on overlapping slot sets in opposite order is the classic AB/BA deadlock setup. It is unreachable
-- TODAY only because all three first take cycles.id FOR UPDATE (and pricing RAISEs on a missing
-- cycle, so it never runs on an orphan group) — but that makes deadlock-freedom rest on the
-- cycle-row-lock invariant. The explicit id-ordered slot lock decouples it: every cycle-level RPC now
-- acquires the shared slots in the same order, so they can't deadlock regardless.
--
-- NOT CHANGED (deliberately): this does NOT recompute invoice line items. Billing line-item amounts
-- are rebuilt by the client's syncInvoicesAfterPriceChange (invoiceSync.recalculateInvoiceAfterRemoval)
-- — the VAT-inclusive / split / extra-cost pricing engine (locked by registration-pricing.golden) plus
-- a PDF regeneration via an edge function, neither of which can run inside Postgres. So a price change
-- is: (1) this RPC pushes the new price onto the cycle + slots atomically, then (2) the caller runs
-- syncInvoicesAfterPriceChange to rebuild the affected invoices. Folding (2) into SQL is infeasible;
-- keeping it on the client matches the apply_slot_delete_to_cycle precedent (SQL stamps scalars, the
-- TS engine rebuilds line items + PDF).
CREATE OR REPLACE FUNCTION public.update_cycle_pricing(
  _cycle_id uuid,
  _price_per_session numeric,
  _extra_costs jsonb,
  _split_payment boolean,
  _prices_include_vat boolean
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_settings jsonb;
BEGIN
  SELECT COALESCE(settings, '{}'::jsonb) INTO v_settings
  FROM public.cycles WHERE id = _cycle_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cycle_not_found';
  END IF;

  -- Canonical cycle-level lock order: cycle row (above) → slots (id-ordered). See the header for why
  -- this matters vs apply_slot_edit_to_cycle / apply_slot_delete_to_cycle.
  PERFORM 1 FROM public.availability_slots WHERE cyclus_id = _cycle_id ORDER BY id FOR UPDATE;

  v_settings := v_settings
    || jsonb_build_object('extra_costs', COALESCE(_extra_costs, '[]'::jsonb))
    || jsonb_build_object('split_payment', _split_payment)
    || jsonb_build_object('prices_include_vat', _prices_include_vat);

  UPDATE public.cycles
     SET price_per_session = _price_per_session,
         settings = v_settings
   WHERE id = _cycle_id;

  UPDATE public.availability_slots
     SET price_per_session = _price_per_session,
         extra_costs = CASE
           WHEN _extra_costs IS NOT NULL
                AND jsonb_typeof(_extra_costs) = 'array'
                AND jsonb_array_length(_extra_costs) > 0
           THEN _extra_costs ELSE NULL END,
         split_payment = _split_payment,
         prices_include_vat = _prices_include_vat
   WHERE cyclus_id = _cycle_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_cycle_pricing(uuid, numeric, jsonb, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_cycle_pricing(uuid, numeric, jsonb, boolean, boolean) TO authenticated, service_role;
