-- R01 (MASTER_AUDIT): bookings.payment_status CHECK omitted values the code writes.
--
-- The original constraint (migration 20260115213549) was:
--     CHECK (payment_status IN ('pending', 'paid', 'refunded', 'waived'))
-- but the Mollie webhook writes payment_status = 'failed' for every
-- failed/canceled/expired payment (mollie-webhook/index.ts case failed/canceled/
-- expired -> paymentStatus = 'failed'), and the earnings/invoicing surfaces both
-- read and expect payment_status = 'invoiced' (get_trainer_earnings_summary,
-- src/lib/trainerEarnings.ts, TrainerEarnings.tsx) and 'unpaid' (test fixtures).
--
-- Because applyBookingPaymentWriteback only tolerates unique-violation (23505) and
-- re-throws anything else, the rejected 'failed' write (23514) bubbles to a HTTP 500,
-- Mollie retries for ~24h, and the seat is stranded in a pending/occupying state.
-- This is deterministic on EVERY failed online payment, not race-dependent.
--
-- Fix: widen the CHECK to the full set of values the codebase writes/reads.
-- Widening only adds permitted values, so it cannot reject any existing row.

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_payment_status_check;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_payment_status_check
  CHECK (payment_status IN (
    'pending',
    'paid',
    'refunded',
    'waived',
    'failed',
    'invoiced',
    'unpaid'
  ));
