-- Phase 4 F2 — atomic, set-based slot EDIT / apply-to-cycle (owner-deployed, INERT until Slice 7b).
--
-- Replaces the per-role "apply to whole cyclus" edit, which today loops slot-by-slot and UPDATEs each
-- in its own round-trip (AcademySlotDetail.handleSave ~413-450, TrainerSlotDetail.handleSave ~247-265)
-- — non-atomic, so a mid-loop failure leaves the cycle half-edited (some sessions moved, some not).
-- This applies the same change to every requested slot in ONE statement.
--
-- WHAT IT EDITS (non-price fields only): a RELATIVE time shift (each session keeps its own date; its
-- time-of-day shifts by the same delta and its duration is reset — exactly the client's
-- `timeOfDayDiff` + `editDuration`) plus absolute trainer / location / capacity / rating / name /
-- visibility. PRICE is deliberately OUT OF SCOPE: the client skips price fields for cycle slots
-- (`if (!isCycleSlot)`), routing them through update_cycle_pricing (the price-source-of-truth path).
-- So this RPC never touches price_per_session / total_price / split_payment / prices_include_vat /
-- extra_costs, and therefore needs no invoice/split resync (amounts are unchanged).
--
-- CAPACITY-SHRINK GUARD (a NEW safety — the client has none): you cannot shrink a session's
-- max_participants below the number of players already occupying it. The check is ALL-OR-NOTHING for
-- the batch: if ANY requested slot's occupancy exceeds the new max, NOTHING is updated and the
-- offending slots are returned, so an "apply to whole cycle" can't silently desync (some slots
-- shrunk, some refused). The caller surfaces blocked_slot_ids and the admin adjusts.
--
-- SECURITY INVOKER: every read/write stays under the caller's RLS (academy/trainer edit only their
-- own slots), exactly as the client did. WHICH slots stays the caller's decision — it passes the
-- explicit _slot_ids it resolved (a cycle's future slots, a now()/timezone choice); the RPC never
-- expands the set.
--   INVARIANT (same as apply_slot_delete_to_cycle): the capacity guard reads bookings under the
--   caller's RLS, so it relies on every owner role's bookings-SELECT RLS covering at least the slots
--   its slot-UPDATE RLS covers. This is NOT exactly true for academy today — slot-UPDATE keys off
--   academy_profile_id but bookings-SELECT keys off ACTIVE academy_trainers — so a slot whose trainer
--   has left the academy is editable while its bookings are hidden, and the guard would under-count
--   its occupancy. The robust fix is an RLS-policy alignment (cover the same slot set) and should be
--   applied to BOTH this guard and the delete RPC together; until then this guard is best-effort for
--   orphaned-trainer slots. Re-audit on any new slot-editing role.
--
-- ADOPTION CONTRACT (Slice 7b): omitted keys are KEPT PER-SLOT (no normalization). The client loop
-- spreads ALL non-price fields onto every cyclus slot, normalizing the whole cycle to the edited
-- slot — so to reproduce that, the caller must populate the patch with EVERY non-price form field,
-- not a changed-only diff. This RPC is RELATIVE-shift + CYCLE-scope + NON-PRICE only: the single-slot
-- ABSOLUTE-time edit and any price write stay on the existing path / update_cycle_pricing.
--
-- _patch keys (ALL optional — only present keys are written):
--   start_shift_minutes int + duration_minutes int  (time edit; BOTH-or-NEITHER; duration > 0)
--   trainer_id uuid · max_participants int · is_public boolean  — present-but-null is a NO-OP (kept;
--     these columns are never cleared by an edit, and writing NULL max would silently uncap to 4)
--   location_id uuid · rating_system text · min_rating numeric · max_rating numeric · cyclus_name text
--     — nullable; a present-but-null value CLEARS the column (matches the client sending location=null)
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
        AND b.status IN ('confirmed', 'pending', 'pending_approval')
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

REVOKE ALL ON FUNCTION public.apply_slot_edit_to_cycle(uuid, uuid[], jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_slot_edit_to_cycle(uuid, uuid[], jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.apply_slot_edit_to_cycle(uuid, uuid[], jsonb) IS
  'Phase 4 F2: atomic set-based slot edit / apply-to-cycle (non-price fields + relative time shift). '
  'Capacity-shrink guard (all-or-nothing). Price stays with update_cycle_pricing. SECURITY INVOKER.';
