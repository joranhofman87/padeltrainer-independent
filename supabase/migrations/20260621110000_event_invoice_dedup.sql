-- Idempotency guard for event-registration invoices.
--
-- A registrant must never end up with two live (unpaid) invoices for the same
-- event — a double-submit or a concurrent retry would otherwise mint a second
-- payable invoice. This partial unique index makes the second insert fail at the
-- DB level; the minter catches it and returns the existing invoice instead.
--
-- Scope: only event-registration invoices (cycle_id IS NOT NULL — booking
-- invoices keep cycle_id NULL and are unaffected) and only "live" ones
-- (paid/cancelled excluded, so re-registering after a completed payment is
-- still allowed). The key is per registrant: the resolved player_id, else the
-- guest_player_id.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_live_event_invoice_per_registrant
  ON public.invoices (cycle_id, COALESCE(player_id, guest_player_id))
  WHERE cycle_id IS NOT NULL
    AND status NOT IN ('paid', 'cancelled');
