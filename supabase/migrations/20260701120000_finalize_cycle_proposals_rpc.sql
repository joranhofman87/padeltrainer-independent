-- Robustness #2 — atomic proposal finalization (owner-deployed; consumed by finalize-proposals).
--
-- THE BUG THIS CLOSES. finalize-proposals/index.ts ran three writes in SEPARATE, untransacted
-- round-trips:
--   (1) the atomic claim:   UPDATE intake_requests SET status='booked' WHERE status='proposed'
--   (2) per assignment:     INSERT INTO bookings(...)  +  UPDATE proposed_assignments SET 'confirmed'
--   (3) invoicing (HTTP).
-- Because the claim (1) flips the intakes to 'booked' FIRST and consumes status='proposed', a crash,
-- timeout, or a single failing booking INSERT *after* (1) but *during* (2) left intakes marked
-- 'booked' with NO bookings — and a re-run found nothing to claim (status no longer 'proposed'), so
-- the player was silently dropped (booked intake, no booking, no invoice) with no recovery short of
-- manual DB surgery.
--
-- THE FIX. This RPC performs the claim + booking creation + assignment-confirm as ONE statement (one
-- transaction). It is all-or-nothing: if any booking INSERT fails, the WHOLE thing rolls back —
-- intakes stay 'proposed', no bookings are created, and the caller can safely re-run once the bad
-- data is fixed. Invoicing (step 3) deliberately STAYS on the caller: it is an HTTP invoke to
-- auto-create-invoice and cannot join a SQL transaction; it is already best-effort + re-runnable
-- (it bills only the bookings this run created and reconciles against sign-up invoices), so a booking
-- that lands without its invoice is a far milder, visible, recoverable state than a missing booking.
--
-- CONCURRENCY. Two admins finalizing the same cycle at once both contend on the same proposed
-- intake_requests rows in the claim UPDATE: under READ COMMITTED the first commits and the second
-- re-evaluates status='proposed' → matches nothing → claims nothing → creates nothing. No
-- double-booking — exactly the property the previous claim-first UPDATE provided, now extended
-- atomically across the booking inserts. proposed_assignments.slot_id is ON DELETE CASCADE, so a slot
-- deleted concurrently removes its assignment from `to_book` rather than poisoning the INSERT.
--
-- AUTH MODEL. SECURITY DEFINER + EXECUTE granted to service_role ONLY. The finalize-proposals edge
-- function is the gatekeeper: it authorizes the caller (isAdminUser / canManageCycle) and only then
-- calls this RPC with its service-role client. Granting authenticated would let any signed-in user
-- finalize ANY cycle (SECURITY DEFINER bypasses RLS) — so it is deliberately withheld.
--
-- RETURN. jsonb { booked_intakes: int, bookings: [{ id, player_id, guest_player_id, slot_id }] } —
-- booked_intakes is every claimed intake (some may have no proposed_assignment → no booking), so the
-- caller still reports `booked` and `bookings_created` separately exactly as before.
CREATE OR REPLACE FUNCTION public.finalize_cycle_proposals(p_cycle_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH claimed AS (
    -- (1) Atomic claim — flip every still-proposed intake for this cycle to 'booked', capture which
    -- rows THIS call transitioned (row locks make concurrent calls disjoint).
    UPDATE public.intake_requests
       SET status = 'booked'
     WHERE cycle_id = p_cycle_id
       AND status = 'proposed'
    RETURNING id, player_id, guest_player_id
  ),
  to_book AS (
    -- The proposed assignments belonging to the just-claimed intakes — one booking per assignment.
    -- All CTEs read the pre-statement snapshot, so this sees the assignments as 'proposed' regardless
    -- of the confirm UPDATE below.
    SELECT pa.id AS assignment_id, pa.slot_id, c.player_id, c.guest_player_id
      FROM public.proposed_assignments pa
      JOIN claimed c ON c.id = pa.intake_request_id
     WHERE pa.status = 'proposed'
  ),
  confirmed AS (
    -- Mark those assignments confirmed in the same transaction.
    UPDATE public.proposed_assignments pa
       SET status = 'confirmed'
      FROM to_book tb
     WHERE pa.id = tb.assignment_id
    RETURNING pa.id
  ),
  inserted AS (
    -- Create the bookings — identical column set + values to the edge function's per-row INSERT
    -- (slot_id, status='confirmed', payment_status='pending', and the intake's player/guest id, one
    -- of which is null). All defaults (id, created_at, updated_at, payment_amount) apply as before.
    INSERT INTO public.bookings (slot_id, status, payment_status, player_id, guest_player_id)
    SELECT slot_id, 'confirmed', 'pending', player_id, guest_player_id
      FROM to_book
    RETURNING id, player_id, guest_player_id, slot_id
  )
  SELECT jsonb_build_object(
    'booked_intakes', (SELECT count(*) FROM claimed),
    'bookings', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
         'id', id,
         'player_id', player_id,
         'guest_player_id', guest_player_id,
         'slot_id', slot_id
       )) FROM inserted),
      '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.finalize_cycle_proposals(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_cycle_proposals(uuid) TO service_role;

COMMENT ON FUNCTION public.finalize_cycle_proposals(uuid) IS
  'Robustness #2: atomically claim proposed intakes (→booked), create their bookings, and confirm '
  'their assignments in ONE transaction (all-or-nothing → safe to re-run after a failure). Invoicing '
  'stays on the caller (HTTP). SECURITY DEFINER, service_role-only; the finalize-proposals edge '
  'function is the gatekeeper. Returns jsonb { booked_intakes, bookings[] }.';
