-- ============================================================================
-- Phase 3.3-attendance (person-unification): a guest-seated session is REPORTABLE
-- ============================================================================
-- The player attendance write path (session_reports INSERT/UPDATE) and the
-- player-facing trainer-summary view both gate on "the caller has a booking on
-- this slot" via  b.player_id = get_profile_id_for_user(auth.uid())  — a
-- PURE-PROFILE check. A player seated under their linked GUEST twin (academy
-- add / group rebook: guest_player_id set, player_id NULL) therefore has no
-- matching booking, so:
--   * they cannot submit an attendance report for that session (INSERT dead-end
--     — the exact reason PendingAttendanceCard's person-keying was pulled from
--     Phase 3.3a: surfacing the prompt without this would be a dead-end);
--   * they cannot see the trainer's summary for it (the summaries view).
--
-- This migration person-keys those checks. A new SECURITY DEFINER helper
-- can_report_attendance_on_slot(slot, require_active) answers "does the caller's
-- PERSON hold a (optionally active) booking on this slot?" — their own profile
-- seat OR a linked-guest seat, resolved EXACTLY like the get_my_linked_guest_
-- bookings reader (person-stamp arm OR Phase-0c twin/link bridge, split-frozen
-- guests excluded) so that every session the player can SEE is one they can
-- WRITE (no surface-vs-write skew). person_links is RLS-locked → DEFINER.
--
-- The profile arm (b.player_id = me) is kept verbatim, so the check is a strict
-- SUPERSET for account holders — nothing that was reportable stops being so.
-- reporter_id / reporter_role clauses are re-emitted unchanged. NO frontend
-- change here: this only ENABLES guest-seated reporting; PendingAttendanceCard's
-- surfacing re-lands in a follow-up so nothing new appears in the UI before this
-- capability is deployed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.can_report_attendance_on_slot(
  _slot_id uuid,
  _require_active boolean DEFAULT false
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ctx AS (
    SELECT public.get_profile_id_for_user(auth.uid()) AS profile,
           public.get_my_person_id() AS person
  )
  SELECT EXISTS (
    SELECT 1
    FROM public.bookings b, ctx
    WHERE b.slot_id = _slot_id
      AND (NOT _require_active
           OR COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap'))
      AND (
        -- my own profile seat (verbatim original predicate — account holders unchanged)
        b.player_id = ctx.profile
        -- OR a linked-GUEST seat that is MY person — mirrors get_my_linked_guest_bookings:
        -- split-frozen guests (uncertain identity) excluded; person-stamp arm OR the
        -- Phase-0c twin-precedence bridge for linked-but-unmerged guests pending owner review.
        OR (
          b.guest_player_id IS NOT NULL
          AND NOT public.is_guest_split_frozen(b.guest_player_id)
          AND (
            (ctx.person IS NOT NULL AND b.person_id = ctx.person)
            OR b.guest_player_id IN (
              SELECT gp.id FROM public.guest_players gp
              WHERE gp.twin_of_profile_id = ctx.profile
                 OR (gp.twin_of_profile_id IS NULL AND gp.linked_profile_id = ctx.profile)
            )
          )
        )
      )
  );
$$;

COMMENT ON FUNCTION public.can_report_attendance_on_slot(uuid, boolean) IS
  'Does the CALLER''s person hold a booking on this slot (their profile seat OR a linked-guest seat)? Mirrors get_my_linked_guest_bookings exactly (person-stamp arm OR twin/link bridge, split-frozen excluded) so a player can report/see attendance for a guest-seated session (person-unification Phase 3.3-attendance). _require_active=true additionally requires the booking to be non-cancelled (used by the summaries view). SECURITY DEFINER — person_links is RLS-locked. Keyed on auth.uid(): reveals only the caller''s own seating.';

REVOKE ALL ON FUNCTION public.can_report_attendance_on_slot(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_report_attendance_on_slot(uuid, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- player INSERT / UPDATE — person-keyed booking check (reporter clauses verbatim)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Players can insert their own session reports" ON public.session_reports;
CREATE POLICY "Players can insert their own session reports"
  ON public.session_reports
  FOR INSERT
  TO authenticated
  WITH CHECK (
    session_reports.reporter_id = public.get_profile_id_for_user(auth.uid())
    AND session_reports.reporter_role = 'player'
    AND public.can_report_attendance_on_slot(session_reports.slot_id)
  );

DROP POLICY IF EXISTS "Players can update their own session reports" ON public.session_reports;
CREATE POLICY "Players can update their own session reports"
  ON public.session_reports
  FOR UPDATE
  TO authenticated
  USING (
    session_reports.reporter_id = public.get_profile_id_for_user(auth.uid())
    AND session_reports.reporter_role = 'player'
    AND public.can_report_attendance_on_slot(session_reports.slot_id)
  )
  WITH CHECK (
    session_reports.reporter_id = public.get_profile_id_for_user(auth.uid())
    AND session_reports.reporter_role = 'player'
    AND public.can_report_attendance_on_slot(session_reports.slot_id)
  );

-- ---------------------------------------------------------------------------
-- player-facing trainer-summary view — person-keyed, active-only (re-emit of
-- 20260713100000, booking check replaced; columns + privacy scope unchanged)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.session_reports_player_summaries AS
SELECT
  sr.id,
  sr.slot_id,
  sr.reporter_role,
  sr.session_happened,
  sr.public_notes,
  sr.created_at
FROM public.session_reports sr
WHERE sr.reporter_role = 'trainer'
  AND public.can_report_attendance_on_slot(sr.slot_id, true);

REVOKE ALL ON public.session_reports_player_summaries FROM anon;
GRANT SELECT ON public.session_reports_player_summaries TO authenticated;
