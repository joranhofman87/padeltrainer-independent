-- ============================================================================
-- Holds first-class in the slot delete + capacity-shrink guards (audit Batch 3, §4.1)
-- ============================================================================
-- Both apply_slot_delete_to_cycle and apply_slot_edit_to_cycle counted occupancy as
-- confirmed/pending/pending_approval ONLY — blind to live `payment_pending` holds, unlike the
-- capacity TRIGGER (enforce_booking_slot_tier, 20260715100000) and the public occupancy read
-- (get_public_slot_occupancy, 20260706140000), which both count a live hold.
--
-- Consequences the audit flagged:
--   • [P1] deleting a slot whose ONLY occupant is a mid-checkout hold was NOT protected → the
--     slot (and the hold + its priority claim) CASCADE-deleted; the later paid webhook found no
--     booking rows → money captured, no seat, silently. Now the live hold PROTECTS the slot.
--   • [P2] a capacity shrink ignored live holds → a hold that later converts oversells (max+1).
--     Now the shrink guard counts live holds toward occupancy.
--
-- A "live hold" is exactly the canonical predicate used everywhere else:
--   status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now().
-- Each guard keeps its existing base predicate (bare `status IN (...)`, so NULL-status bookings
-- stay excluded as before) and merely ORs in the live-hold clause — behaviour-preserving apart
-- from now honouring holds. Both functions are re-emitted VERBATIM except that one predicate.
-- ============================================================================

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
    AND (
      b.status IN ('confirmed', 'pending', 'pending_approval')
      OR (b.status = 'payment_pending' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at > now())
    );

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

CREATE OR REPLACE FUNCTION public.apply_slot_edit_to_cycle(
  _cycle_id uuid,
  _slot_ids uuid[],
  _patch    jsonb
)
RETURNS TABLE(updated_count int, blocked_count int, blocked_slot_ids uuid[])
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_new_max  int;
  v_blocked  uuid[];
  v_updated  uuid[];
  v_shift    boolean := (_patch ? 'start_shift_minutes') AND (_patch ? 'duration_minutes');
BEGIN
  IF _slot_ids IS NULL OR array_length(_slot_ids, 1) IS NULL
     OR _patch IS NULL OR _patch = '{}'::jsonb THEN
    RETURN QUERY SELECT 0, 0, '{}'::uuid[];
    RETURN;
  END IF;

  -- Time edit is both-or-neither (a half-specified shift would silently no-op the time) and the
  -- resulting duration must be positive (else the availability_slots end_time>start_time CHECK would
  -- abort the whole batch with an opaque 23514). Fail loudly + early instead.
  IF (_patch ? 'start_shift_minutes') <> (_patch ? 'duration_minutes') THEN
    RAISE EXCEPTION 'apply_slot_edit_to_cycle: start_shift_minutes and duration_minutes must be provided together';
  END IF;
  IF v_shift AND round((_patch->>'duration_minutes')::numeric) <= 0 THEN
    RAISE EXCEPTION 'apply_slot_edit_to_cycle: duration_minutes must be positive (got %)', _patch->>'duration_minutes';
  END IF;

  -- Canonical cycle-level lock order (shared across the F2 RPCs): cycle row → candidate slots (id
  -- order). Best-effort on the cycle row (orphan cyclus_id groups have no cycles row — no FK; the
  -- id-ordered slot lock is then the real serialization point). The ordered slot lock prevents AB/BA
  -- deadlock between two overlapping edits/deletes.
  IF _cycle_id IS NOT NULL THEN
    PERFORM 1 FROM public.cycles WHERE id = _cycle_id FOR UPDATE;
  END IF;
  PERFORM 1 FROM public.availability_slots WHERE id = ANY(_slot_ids) ORDER BY id FOR UPDATE;

  -- Capacity-shrink guard. Runs only when the patch sets a CONCRETE max (present-but-null is a no-op,
  -- below — it never clears capacity, so there is nothing to guard).
  IF (_patch ? 'max_participants') AND (_patch->>'max_participants') IS NOT NULL THEN
    v_new_max := round((_patch->>'max_participants')::numeric)::int;  -- tolerate a fractional value

    -- Lock the bookings too: a capacity change races with a concurrent booking INSERT/status flip
    -- that would push occupancy over the new max between this check and the UPDATE. Locking them
    -- (id-ordered) serializes that flip against the guard — same discipline as apply_slot_delete.
    PERFORM 1 FROM public.bookings WHERE slot_id = ANY(_slot_ids) ORDER BY id FOR UPDATE;

    -- Occupancy = count of capacity-occupying bookings per slot (CAPACITY_OCCUPYING_STATUSES — mirrors
    -- src/lib/lessons.ts + the idx_bookings_slot_status partial index). A slot is BLOCKED iff the new
    -- max is below its occupancy AND is an ACTUAL reduction (new < current, or current is unset). The
    -- "actual reduction" clause is essential: the client ALWAYS sends max_participants in the
    -- apply-to-cyclus payload, so without it an unchanged max would block any legacy slot already over
    -- its own capacity — a slot this edit isn't shrinking.
    SELECT COALESCE(array_agg(s.id ORDER BY s.id), '{}'::uuid[]) INTO v_blocked
    FROM public.availability_slots s
    JOIN (
      SELECT b.slot_id, count(*) AS occ
      FROM public.bookings b
      WHERE b.slot_id = ANY(_slot_ids)
        AND (
          b.status IN ('confirmed', 'pending', 'pending_approval')
          OR (b.status = 'payment_pending' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at > now())
        )
      GROUP BY b.slot_id
    ) o ON o.slot_id = s.id
    WHERE s.id = ANY(_slot_ids)
      AND o.occ > v_new_max
      AND (s.max_participants IS NULL OR v_new_max < s.max_participants);

    -- All-or-nothing: refuse the whole edit if any slot would be over-shrunk (no partial desync).
    IF array_length(v_blocked, 1) IS NOT NULL THEN
      RETURN QUERY SELECT 0, array_length(v_blocked, 1), v_blocked;
      RETURN;
    END IF;
  END IF;

  -- One set-based UPDATE. A field is written only when its key is present in _patch, else kept.
  --  • NON-NULLABLE / never-cleared columns (trainer_id, max_participants, is_public): a present-but-
  --    NULL value is a NO-OP (kept) — writing NULL would either violate NOT NULL or silently uncap a
  --    slot to the default-4 capacity, bypassing the shrink guard above.
  --  • Nullable columns (location_id, rating_system, min/max_rating, cyclus_name): a present-but-null
  --    value CLEARS the column (matches the client sending location_id=null for "none").
  -- The time shift references the OLD start_time in both new start and end (SET exprs evaluate against
  -- the pre-update row), so end = (old_start + shift) + duration — the client's csEnd. Real-minute
  -- interval math equals the client's JS setMinutes for all normal times (epoch-equivalent); only a
  -- shift landing inside a DST gap/overlap is ambiguous, which lesson times never do.
  WITH upd AS (
    UPDATE public.availability_slots s SET
      start_time = CASE WHEN v_shift
                        THEN s.start_time + (round((_patch->>'start_shift_minutes')::numeric) || ' minutes')::interval
                        ELSE s.start_time END,
      end_time   = CASE WHEN v_shift
                        THEN s.start_time + (round((_patch->>'start_shift_minutes')::numeric) || ' minutes')::interval
                                          + (round((_patch->>'duration_minutes')::numeric)    || ' minutes')::interval
                        ELSE s.end_time END,
      trainer_id       = CASE WHEN (_patch ? 'trainer_id')       AND (_patch->>'trainer_id')       IS NOT NULL THEN (_patch->>'trainer_id')::uuid                  ELSE s.trainer_id END,
      max_participants = CASE WHEN (_patch ? 'max_participants') AND (_patch->>'max_participants') IS NOT NULL THEN round((_patch->>'max_participants')::numeric)::int ELSE s.max_participants END,
      is_public        = CASE WHEN (_patch ? 'is_public')        AND (_patch->>'is_public')        IS NOT NULL THEN (_patch->>'is_public')::boolean                 ELSE s.is_public END,
      location_id      = CASE WHEN _patch ? 'location_id'      THEN (_patch->>'location_id')::uuid    ELSE s.location_id END,
      rating_system    = CASE WHEN _patch ? 'rating_system'    THEN  _patch->>'rating_system'         ELSE s.rating_system END,
      min_rating       = CASE WHEN _patch ? 'min_rating'       THEN (_patch->>'min_rating')::numeric  ELSE s.min_rating END,
      max_rating       = CASE WHEN _patch ? 'max_rating'       THEN (_patch->>'max_rating')::numeric  ELSE s.max_rating END,
      cyclus_name      = CASE WHEN _patch ? 'cyclus_name'      THEN  _patch->>'cyclus_name'           ELSE s.cyclus_name END
    WHERE s.id = ANY(_slot_ids)
    RETURNING s.id
  )
  SELECT COALESCE(array_agg(id), '{}'::uuid[]) INTO v_updated FROM upd;

  RETURN QUERY SELECT COALESCE(array_length(v_updated, 1), 0), 0, '{}'::uuid[];
END;
$$;

REVOKE ALL ON FUNCTION public.apply_slot_delete_to_cycle(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_slot_delete_to_cycle(uuid, uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.apply_slot_edit_to_cycle(uuid, uuid[], jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_slot_edit_to_cycle(uuid, uuid[], jsonb) TO authenticated, service_role;
