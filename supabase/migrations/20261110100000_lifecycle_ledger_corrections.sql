-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- CORRECTIONS to the lifecycle ledger, from the review of 2350373a. Four defects, three of them
-- introduced by the ledger itself.
--
-- 1. CROSS-TENANT DISCLOSURE (high). `booking_transition_occurred_at` and `booking_transition_seq`
--    are SECURITY DEFINER, take arbitrary booking ids, and were granted to `authenticated`. Any
--    logged-in player who learns a booking uuid could ask when it was created, confirmed,
--    cancelled, paid or rejected — the table's RLS and REVOKE defeated by the readers meant to sit
--    on top of them. Every caller is service-role (the resolver and the edge producers), so the
--    grant is simply wrong. Revoked.
--
-- 2. THE LEDGER CASCADED WITH THE BOOKING (medium-high). `booking_id … ON DELETE CASCADE` beside a
--    trigger that refuses every DELETE: deleting a booking would either fail outright or make the
--    "append-only" property depend on cascade semantics. Both are wrong, and the second is worse.
--    An audit row should outlive the row it describes — the account-deletion audit already made
--    that argument with a deliberately FK-free subject. The FK is dropped; `booking_id` stays a
--    plain uuid.
--
-- 3. A MIXED SET COULD STILL BE RE-DATED (medium). `max(occurred_at)` over a booking set let ONE
--    newly transitioned member make the whole set current — the same shape as the max(updated_at)
--    defect, arriving through the aggregate instead of the column. The floor must be conservative:
--    a set is only as new as its OLDEST member's transition. And occurrence and sequence are read
--    from ONE call now, so a transition landing between two separate reads cannot pair the first
--    occurrence with the second sequence.
--
-- 4. (Producer-side, in the same slice) the edge producers never passed the discriminator, so a
--    genuine second `paid` transition could still collapse onto the first.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. the readers are service-role only ────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.booking_transition_occurred_at(uuid[], text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.booking_transition_seq(uuid[], text) FROM authenticated;

-- ── 2. the ledger outlives the booking ──────────────────────────────────────────────────────
ALTER TABLE public.booking_lifecycle_events
  DROP CONSTRAINT booking_lifecycle_events_booking_id_fkey;
COMMENT ON COLUMN public.booking_lifecycle_events.booking_id IS
  'The booking this transition happened to. Deliberately FK-free: a cascade would erase the record of an erasure, and an append-only guard beside ON DELETE CASCADE makes deleting a booking either fail or quietly win. The audit outlives its subject, exactly as account_deletion_audit does.';

-- ── 3. one read, and a conservative aggregate ───────────────────────────────────────────────
-- Per booking take its LATEST matching transition; across the set take the OLDEST of those. A set
-- is therefore only as recent as its least-recently-transitioned member, so adding a fresh
-- cancellation to a set of old ones cannot drag the old ones into the sendable window.
CREATE OR REPLACE FUNCTION public.booking_transition_event(
  p_booking_ids uuid[],
  p_event_type text
) RETURNS TABLE (occurred_at timestamptz, seq bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH latest_per_booking AS (
    SELECT DISTINCT ON (e.booking_id) e.booking_id, e.occurred_at, e.seq
      FROM public.booking_lifecycle_events e
     WHERE e.booking_id = ANY (p_booking_ids)
       AND e.event_type = p_event_type
     ORDER BY e.booking_id, e.occurred_at DESC, e.seq DESC
  )
  -- the oldest of those latest events, and ITS sequence — from the same row, so an occurrence can
  -- never be paired with a different transition's discriminator
  SELECT l.occurred_at, l.seq
    FROM latest_per_booking l
   ORDER BY l.occurred_at ASC, l.seq ASC
   LIMIT 1;
$$;
COMMENT ON FUNCTION public.booking_transition_event(uuid[], text) IS
  'The transition a message about this booking set reports: each booking''s latest matching event, then the OLDEST of those — conservative, so one freshly transitioned member cannot re-date a set of historical ones. Returns occurrence and discriminator from the SAME ledger row, so the two cannot be read from different transitions. No rows = the transition never happened for this set, which every caller must treat as "do not enqueue".';
REVOKE ALL ON FUNCTION public.booking_transition_event(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_transition_event(uuid[], text) TO service_role;

-- the two single-value readers become thin wrappers over it, so there is one aggregate rule
CREATE OR REPLACE FUNCTION public.booking_transition_occurred_at(
  p_booking_ids uuid[],
  p_event_type text
) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.occurred_at FROM public.booking_transition_event(p_booking_ids, p_event_type) e;
$$;
CREATE OR REPLACE FUNCTION public.booking_transition_seq(
  p_booking_ids uuid[],
  p_event_type text
) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.seq FROM public.booking_transition_event(p_booking_ids, p_event_type) e;
$$;
REVOKE ALL ON FUNCTION public.booking_transition_occurred_at(uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.booking_transition_seq(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_transition_occurred_at(uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.booking_transition_seq(uuid[], text) TO service_role;
