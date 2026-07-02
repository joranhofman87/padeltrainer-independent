-- P1-5 / P2-7: single-slot pay-first charges (create-mollie-payment single-slot +
-- create-guest-slot-payment) bake sumSlotExtraCosts into booking.payment_amount. This flag
-- records that fact so auto-create-invoice and invoiceSync skip re-appending the extra_costs
-- line items (which otherwise overstate the authed invoice / double-count the guest invoice).
--
-- NULL / false  => extras NOT included in payment_amount (manual bookings, cyclus bookings)
--                  → invoice builders append extras as before.
-- true          => extras already in payment_amount (single-slot pay-first)
--                  → invoice builders skip the extras append.
--
-- Nullable, no default flip, no backfill: existing rows stay NULL and keep today's behavior;
-- only new single-slot pay-first bookings are stamped true.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS amount_includes_extras boolean;

COMMENT ON COLUMN public.bookings.amount_includes_extras IS
  'True when booking.payment_amount already includes the slot extra_costs (single-slot pay-first charge). Invoice builders (auto-create-invoice, invoiceSync) skip appending extra_costs line items when set, so invoice.total == captured amount. NULL/false = extras not included (append as normal).';
