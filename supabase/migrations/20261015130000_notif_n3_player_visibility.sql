-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N3 M4 — the player's view of academy caps: ONE canonical membership reader, current caps,
-- and change history (design contract findings 5 + 6, thread 019fd175-f39e-73a3-80c3-7c43f6b13f97).
--
-- FINDING 6's warning, honoured: this repo has no simple membership table, and
-- `is_player_of_academy` is MANAGER-pinned — calling it as an oracle from a player session
-- answers false for everyone. The reader below is the SAME relationship arms (booking at an
-- ACTIVE academy trainer with the canonical inactive-booking filter; guest linkage through the
-- twin-precedence bridge or the person arm, split-freeze-gated), TRANSPOSED to "which academies
-- is the CALLING account a player of" and self-pinned to auth.uid(). One reader, used by both
-- the caps RPC and the history RPC, so the two surfaces can never disagree about membership.
--
-- HISTORICAL VISIBILITY, decided deliberately (the contract demanded a stated answer): cap
-- visibility FOLLOWS THE RELATIONSHIP, symmetric with the manager-side predicate. When the
-- relationship ends (trainer leaves the academy, bookings cancelled, guest split-frozen), the
-- academy's caps and their history stop being visible — the player is no longer subject to
-- them, and a stale window into a former academy's operations would be a leak, not a feature.
--
-- ACTOR IDENTITY, decided deliberately (finding 5): the player sees THAT their academy changed
-- a cap, WHAT changed, and WHY (the mandatory reason) — never WHICH manager. Actor identity
-- stays on the manager-side audit RPC; exposing it to players invites interpersonal disputes
-- the notification system has no business creating.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.notif_my_academy_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- (1) booking arm: a non-cancelled seat at one of the academy's ACTIVE trainers.
  SELECT DISTINCT at.academy_profile_id
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    JOIN public.academy_trainers at ON at.trainer_profile_id = s.trainer_id
    JOIN public.profiles pr ON pr.id = b.player_id
   WHERE pr.user_id = auth.uid()
     AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
     AND at.status = 'active'
  UNION
  -- (2) guest arm: a guest identity linked to MY profile — twin-precedence bridge OR person
  --     arm — never split-frozen. BOTH relationship legs, unioned, exactly as the canonical
  --     manager-side helper ORs them: the guest's DIRECT academy AND every academy where the
  --     guest's trainer is active. A coalesce here (first draft) suppressed the trainer leg
  --     whenever a direct academy existed — hiding a B-attributed cap from a player whose
  --     guest row named A. Review caught it.
  SELECT ga.academy_id
    FROM public.guest_players gp
    JOIN public.profiles pr ON pr.user_id = auth.uid()
    CROSS JOIN LATERAL (
      SELECT gp.academy_profile_id AS academy_id
       WHERE gp.academy_profile_id IS NOT NULL
      UNION
      SELECT at2.academy_profile_id
        FROM public.academy_trainers at2
       WHERE at2.trainer_profile_id = gp.trainer_id AND at2.status = 'active'
    ) ga
   WHERE (
       gp.twin_of_profile_id = pr.id
       OR (gp.twin_of_profile_id IS NULL AND gp.linked_profile_id = pr.id)
       OR EXISTS (
         SELECT 1 FROM public.person_links plg
           JOIN public.person_links plp ON plp.person_id = plg.person_id
          WHERE plg.guest_player_id = gp.id AND plp.profile_id = pr.id)
     )
     AND NOT public.is_guest_split_frozen(gp.id)
$$;

COMMENT ON FUNCTION public.notif_my_academy_ids() IS
  'N3: the CANONICAL "which academies am I a player of" reader — is_player_of_academy''s relationship arms (booking at active trainers, canonical inactive filter; guest linkage via twin bridge or person arm, split-freeze-gated) transposed to the calling account and self-pinned to auth.uid(). Both player-facing cap surfaces read membership HERE, so they cannot disagree. Visibility follows the live relationship by design.';

REVOKE ALL ON FUNCTION public.notif_my_academy_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notif_my_academy_ids() TO authenticated;

-- ── current caps affecting me ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_my_notification_restrictions()
RETURNS TABLE (
  academy_profile_id uuid,
  academy_name text,
  event_type text,
  channel text,
  max_frequency text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'get_my_notification_restrictions: authentication required';
  END IF;
  RETURN QUERY
  SELECT r.academy_profile_id, a.name, r.event_type, r.channel, r.max_frequency
    FROM public.academy_notification_restrictions r
    JOIN public.academy_profiles a ON a.id = r.academy_profile_id
   WHERE r.academy_profile_id IN (SELECT public.notif_my_academy_ids())
   ORDER BY a.name, r.event_type, r.channel;
END;
$$;

COMMENT ON FUNCTION public.get_my_notification_restrictions() IS
  'N3: the caps currently affecting the CALLING account, through the canonical membership reader. Powers the "capped by {academy}" marker on the settings page. No manager identity; academy name only.';

REVOKE ALL ON FUNCTION public.get_my_notification_restrictions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_notification_restrictions() TO authenticated;

-- ── change history affecting me ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_my_notification_restriction_history(
  p_limit int DEFAULT 50
) RETURNS TABLE (
  academy_profile_id uuid,
  academy_name text,
  event_type text,
  channel text,
  old_max_frequency text,
  new_max_frequency text,
  reason text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'get_my_notification_restriction_history: authentication required';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 THEN
    RAISE EXCEPTION 'get_my_notification_restriction_history: limit must be 1..200';
  END IF;
  -- FINDING 5: current caps alone cannot satisfy "every manager change is visible to the
  -- player" — a set→off→inherit sequence leaves no current row. The history shows the CHANGES:
  -- what, when, old→new, and the mandatory reason. NO actor identity (see header).
  RETURN QUERY
  SELECT au.academy_profile_id, a.name, au.event_type, au.channel,
         au.old_max_frequency, au.new_max_frequency, au.reason, au.created_at
    FROM public.academy_notification_restriction_audit au
    JOIN public.academy_profiles a ON a.id = au.academy_profile_id
   WHERE au.academy_profile_id IN (SELECT public.notif_my_academy_ids())
   ORDER BY au.created_at DESC
   LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.get_my_notification_restriction_history(int) IS
  'N3: the audit trail of cap changes in the CALLING account''s academies — academy name, event/channel, old→new, reason, timestamp. Actor identity is deliberately withheld from players (it lives on the manager-side audit RPC). Membership via the canonical reader; visibility follows the live relationship.';

REVOKE ALL ON FUNCTION public.get_my_notification_restriction_history(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_notification_restriction_history(int) TO authenticated;
