-- Phase 4 F2 — atomic, set-based slot delete (owner-deployed, INERT until Slice 6 consumes it).
--
-- Replaces the per-role client delete paths that each, in several non-atomic round-trips, computed a
-- "deletable" set and then DELETEd availability_slots:
--   • AcademySlotDetail.handleDelete  ("protect booked slots, delete the rest")
--   • DeleteSlotDialog.handleDelete    ("cancel bookings client-side → then delete")
-- Both rely on filterDeletableSlotIds (src/lib/slotDeleteGuard.ts) to avoid the data-loss trap:
-- bookings.slot_id is ON DELETE CASCADE (migration 20260115210247), so deleting a slot that still
-- holds an active (capacity-occupying) booking silently destroys that booking. This RPC makes the
-- guard + delete ATOMIC — under the row locks taken below, the protected set is computed and the
-- DELETE runs with no window for a concurrent booking (new INSERT or status flip of an existing one)
-- to land between "check" and "delete", which the client check-then-delete could not prevent.
--
-- SECURITY INVOKER: every read/write stays under the caller's RLS, exactly as the client did — an
-- academy/trainer can only delete slots (and only sees the bookings) their policies already allow, so
-- the protected set is computed against the same rows the client saw. No privilege escalation.
--   INVARIANT: this relies on every owner role's bookings-SELECT RLS covering at least the slots its
--   slot-DELETE RLS covers (true today for trainer/academy/club). A future role granted slot-DELETE
--   WITHOUT the matching bookings-SELECT would under-count the protected set → re-audit on new roles.
--
-- WHICH slots stays the caller's decision: it passes the explicit _slot_ids it resolved (a single
-- slot, or a cycle's future/all slots — a now()/timezone choice). The RPC never expands the set, so
-- it can never delete more than the caller intended.
--
-- ADOPTION CONTRACT (Slice 6 — this is a GUARD, not a canceller or an invoice engine):
--   1. It KEEPS any slot that still holds an occupying booking. The trainer "delete cyclus" flow that
--      today CANCELS bookings first must still cancel them BEFORE calling, or those slots silently
--      survive — treat a non-zero protected_count as the kept set to surface, not a failure.
--   2. Cancellation emails + invoice credit/recalc run on the CALLER, BEFORE this call, scoped to the
--      slots it will actually delete (the cascade destroys the bookings those reads need).
--   3. The in-transaction recalc only stamps invoices.split_count. The caller must STILL run its
--      syncInvoicesAfterBookingRemoval / syncSplitCountForCycle AFTER this returns to rebuild invoice
--      LINE-ITEM amounts — this RPC does not touch line items.
CREATE OR REPLACE FUNCTION public.apply_slot_delete_to_cycle(
  _cycle_id uuid,
  _slot_ids uuid[]
)
RETURNS TABLE(deleted_count int, protected_count int, protected_slot_ids uuid[])
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_protected uuid[];
  v_deleted   uuid[];
BEGIN
  IF _slot_ids IS NULL OR array_length(_slot_ids, 1) IS NULL THEN
    RETURN QUERY SELECT 0, 0, '{}'::uuid[];
    RETURN;
  END IF;

  -- Canonical cycle-level lock order (the same in every cycle-level RPC, to avoid deadlock):
  --   cycle row  →  candidate slot rows (id order)  →  their bookings (id order)  →  split advisory.
  --
  -- (1) Serialize concurrent edits of the same cycle (price / edit / delete) so two admins acting at
  -- once don't interleave; shares this first lock with update_cycle_pricing (same order). Best-effort:
  -- an orphan cyclus_id group (no cycles row — there is NO FK on availability_slots.cyclus_id) must
  -- still be deletable, so a missing cycle is NOT an error here — it simply locks nothing, and the
  -- ordered slot/booking locks below become the serialization point for those orphan groups.
  IF _cycle_id IS NOT NULL THEN
    PERFORM 1 FROM public.cycles WHERE id = _cycle_id FOR UPDATE;
  END IF;

  -- (2) Lock the candidate slot rows, IN id ORDER. Two effects:
  --  • TOCTOU vs new bookings: a concurrent `INSERT INTO bookings(slot_id=…)` must take FOR KEY SHARE
  --    on its parent slot row, which conflicts with this FOR UPDATE (load-bearing — must NOT be
  --    weakened to FOR NO KEY UPDATE, which does not conflict), so a new booking blocks until we
  --    commit, then fails its FK cleanly (its slot is gone) instead of being cascade-deleted.
  --  • Deadlock safety: the ORDER BY makes any two F2 calls that share slots but NOT a non-null cycle
  --    (null/orphan-cycle deletes, or overlapping slot sets passed under different cyclus_ids — legal,
  --    no FK on cyclus_id) acquire the shared rows in the same order, eliminating an AB/BA cycle.
  PERFORM 1 FROM public.availability_slots WHERE id = ANY(_slot_ids) ORDER BY id FOR UPDATE;

  -- (3) Lock the EXISTING bookings on those slots, also id-ordered. The slot lock stops new INSERTs
  -- but NOT a status UPDATE of an existing booking — changing bookings.status doesn't touch the FK key
  -- (slot_id), so it takes no lock on the parent slot. Without this, a booking the protect-read saw as
  -- cancelled/declined/pending could be flipped to confirmed+paid by an async path (mollie-webhook /
  -- verify-mollie-payment / finalize-proposals / markInvoicePaid) in the window before the DELETE and
  -- then be cascade-deleted — the precise data loss this function exists to prevent. Locking the rows
  -- FOR UPDATE serializes that flip against the guard (the flip either commits first, so the
  -- protect-read sees it and keeps the slot, or waits and no-ops on the deleted row).
  PERFORM 1 FROM public.bookings WHERE slot_id = ANY(_slot_ids) ORDER BY id FOR UPDATE;

  -- Protected = any requested slot that still holds a capacity-occupying booking. This status list
  -- mirrors CAPACITY_OCCUPYING_STATUSES (src/lib/lessons.ts) and the partial index
  -- idx_bookings_slot_status (migration 20260629120000) so the lookup uses the index at 10k+ slots.
  -- NULL-status bookings are excluded (matches the client's .in(status, ...)).
  SELECT COALESCE(array_agg(DISTINCT b.slot_id), '{}'::uuid[])
    INTO v_protected
  FROM public.bookings b
  WHERE b.slot_id = ANY(_slot_ids)
    AND b.status IN ('confirmed', 'pending', 'pending_approval');

  -- ONE set-based delete of exactly the unprotected requested slots — no per-slot loop, no 500-row
  -- client chunking. FK cascades (bookings, session notes/reports, …) fire exactly as they did for
  -- the client DELETE; `id <> ALL('{}')` is vacuously true, so when nothing is protected every
  -- requested slot is deleted.
  WITH del AS (
    DELETE FROM public.availability_slots s
     WHERE s.id = ANY(_slot_ids)
       AND s.id <> ALL(v_protected)
    RETURNING s.id
  )
  SELECT COALESCE(array_agg(id), '{}'::uuid[]) INTO v_deleted FROM del;

  -- Reconcile the split divisor whenever there is a cycle to scope it to — UNCONDITIONALLY (even when
  -- nothing was deletable), matching the academy delete path, which ran syncSplitCountForCycle on
  -- every delete and used it to re-stamp the authoritative 1/N onto unpaid siblings regardless of
  -- outcome. recalc_cycle_split_count self-guards (no-ops on non-split cycles and on count<=1), so
  -- always calling it is safe + idempotent. _cycle_id IS the cyclus_id: cycles.id ==
  -- availability_slots.cyclus_id is the de-facto group key (there is no FK), and recalc keys off
  -- cyclus_id, so passing _cycle_id positionally is correct. This only stamps invoices.split_count;
  -- per the adoption contract above, the caller still rebuilds invoice LINE-ITEM amounts afterward.
  IF _cycle_id IS NOT NULL THEN
    PERFORM public.recalc_cycle_split_count(_cycle_id);
  END IF;

  RETURN QUERY SELECT
    COALESCE(array_length(v_deleted, 1), 0),
    COALESCE(array_length(v_protected, 1), 0),
    v_protected;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_slot_delete_to_cycle(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_slot_delete_to_cycle(uuid, uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.apply_slot_delete_to_cycle(uuid, uuid[]) IS
  'Phase 4 F2: atomic set-based slot delete. Protects slots with a capacity-occupying booking (never '
  'cascade-deletes an active booking), deletes the rest in one statement, recomputes the split divisor. '
  'SECURITY INVOKER (RLS-scoped). Side-effects (emails, invoice credit/recalc) stay on the caller.';
