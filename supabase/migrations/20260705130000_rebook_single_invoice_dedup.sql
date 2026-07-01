-- Slice A / A-7 — structural double-pay guard for the NO-LOGIN single-claim rebook invoice.
--
-- The single-claim public rebook payment (create-rebook-invoice-public) mints ONE full-price invoice
-- covering a claimant's whole cyclus. The rebook invite goes to the player who may double-click, or
-- retry after a dropped network — so two concurrent mints must NOT produce two payable invoices. The
-- group path solves the same problem with a unique partial index on invoices.rebook_group_id; single
-- claims have no group, so add the analogous key.
--
-- We use a SEPARATE column (rebook_cyclus_id), NOT the existing invoices.cycle_id: cycle_id is owned by
-- the event-registration flow, whose dedup index (20260621110000) relies on booking invoices keeping
-- cycle_id NULL. A rebook invoice IS booking-based, so reusing cycle_id would break that invariant.
--
-- The unique partial index enforces AT MOST ONE active (non-cancelled) rebook invoice per
-- (claimant identity, cyclus). Identity = COALESCE(player_id, guest_player_id) — the same shape the
-- event dedup uses — so it covers both registered players and guest-keyed (no-login) claimants.
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS rebook_cyclus_id uuid;

COMMENT ON COLUMN public.invoices.rebook_cyclus_id IS
  'Set on a single-claim (non-group) no-login rebook invoice = the cyclus it pays for. Backs the one-active-invoice-per-(claimant,cyclus) unique index so concurrent re-clicks conflict at the DB. NULL for all other invoices.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_rebook_cyclus_claimant
  ON public.invoices (rebook_cyclus_id, COALESCE(player_id, guest_player_id))
  WHERE rebook_cyclus_id IS NOT NULL AND status <> 'cancelled';
