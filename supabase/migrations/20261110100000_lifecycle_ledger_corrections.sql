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

-- ── 3/5. one read, a conservative aggregate, a SET-WIDE discriminator, and fail-closed ─────
-- Two further defects in the aggregate above, both found in review:
--
--   * returning ONE row's `seq` does not identify the set's state. A paid at t1/seq 10, B paid at
--     t2/seq 20: the oldest is A, so the subject ends `:10`. B then unpays and re-pays at seq 30 —
--     A is still the oldest, the subject is still `:10`, and a genuine second payment is suppressed
--     as a duplicate. The discriminator has to move when ANY member's latest transition moves.
--   * a set where only SOME members have ledger evidence returned the events it found. A message
--     covering A (dated) and B (no ledger row, e.g. a pre-ledger `paid` with no `paid_at`) was
--     treated as dateable. The contract is fail-closed: if any member of the set cannot be dated,
--     the set cannot be dated.
CREATE OR REPLACE FUNCTION public.booking_transition_event(
  p_booking_ids uuid[],
  p_event_type text
) RETURNS TABLE (occurred_at timestamptz, seq bigint, set_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH requested AS (
    SELECT DISTINCT b AS booking_id FROM unnest(p_booking_ids) AS b WHERE b IS NOT NULL
  ), latest_per_booking AS (
    SELECT DISTINCT ON (e.booking_id) e.booking_id, e.occurred_at, e.seq
      FROM public.booking_lifecycle_events e
      JOIN requested r ON r.booking_id = e.booking_id
     WHERE e.event_type = p_event_type
     ORDER BY e.booking_id, e.occurred_at DESC, e.seq DESC
  )
  SELECT
    -- the OLDEST member's transition: a set is only as recent as its least-recently-transitioned
    -- member, so a fresh member cannot drag historical ones into the sendable window
    min(l.occurred_at),
    min(l.seq),
    -- …and a discriminator over EVERY member's latest transition, so the subject changes whenever
    -- any one of them moves. Ordered by booking id, so the same set always renders identically.
    string_agg(l.booking_id::text || ':' || l.seq::text, ',' ORDER BY l.booking_id)
    FROM latest_per_booking l
   HAVING count(*) = (SELECT count(*) FROM requested)   -- FAIL CLOSED: every member, or none
      AND count(*) > 0;
$$;
COMMENT ON FUNCTION public.booking_transition_event(uuid[], text) IS
  'The transition a message about this booking set reports. Returns NO ROWS unless EVERY requested booking has a matching ledger event — a set one member of which cannot be dated is a set that cannot be dated. occurred_at is the OLDEST of the members latest events (conservative: a fresh member cannot re-date historical ones); set_key is a discriminator over every members latest sequence, so the idempotency subject changes whenever ANY member transitions again.';
REVOKE ALL ON FUNCTION public.booking_transition_event(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_transition_event(uuid[], text) TO service_role;

-- the wrappers follow it, and keep their service-role-only ACL
CREATE OR REPLACE FUNCTION public.booking_transition_occurred_at(
  p_booking_ids uuid[], p_event_type text
) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.occurred_at FROM public.booking_transition_event(p_booking_ids, p_event_type) e;
$$;
CREATE OR REPLACE FUNCTION public.booking_transition_seq(
  p_booking_ids uuid[], p_event_type text
) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.seq FROM public.booking_transition_event(p_booking_ids, p_event_type) e;
$$;
REVOKE ALL ON FUNCTION public.booking_transition_occurred_at(uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.booking_transition_seq(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_transition_occurred_at(uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.booking_transition_seq(uuid[], text) TO service_role;
