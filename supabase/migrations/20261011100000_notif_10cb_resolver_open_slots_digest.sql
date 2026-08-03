-- 10c-b C — RESOLVER COMPLETION for the open-slots digest cutover.
--
-- What this migration adds, and the ONE rule that shapes all of it:
--
-- THE BLAST-RADIUS RULE. `supports_digest` is NOT a cutover marker. Eight events
-- already carry supports_digest=true (booking_confirmed_staff, booking_request_staff,
-- booking_cancelled_staff, session_reminder_player, payment_received_staff,
-- invoice_paid_staff, rebook_paid_staff, review_received_trainer) and the settings UI
-- lets a user store 'daily'/'weekly' against any of them TODAY. Those preferences
-- currently produce a delayed INSTANT outbox row (resolver §6d). Re-routing behavior on
-- `supports_digest` would silently stop mail for every existing daily/weekly subscriber
-- on those eight events — a live-delivery regression that is not part of 10c-b.
--
-- So digest routing is gated on an EXPLICIT per-event cutover flag, `digest_cutover`,
-- set true for `open_slots_player` ONLY. Every other event keeps its byte-for-byte
-- existing behavior, including the delayed-instant daily/weekly path. Whether that
-- delayed-instant behavior is the right product answer for those eight events is a
-- real question, but it is PRE-EXISTING and belongs to 10c-c; it is not decided here.
--
-- ENGINE-OFF SEMANTICS (owner-resolved). For a cutover event on a daily/weekly
-- preference while `digest_engine_enabled = false`:
--   * NOT downgraded to an instant email (that would spam a user who asked for a digest);
--   * NO pending digest row, NO delayed instant row, NO backlog that can burst later —
--     the row is written `status='skipped'` with `delivery_mode` left NULL, so it is
--     invisible to BOTH the instant email worker (claims status='pending') AND the
--     materializer (scans delivery_mode='digest'). There is nothing to drain on enablement.
--   * an EXPLICIT, auditable outcome: skip_reason='digest_engine_disabled'.
--   * enablement therefore affects FUTURE events only, by construction.
--
-- 'off' still means no delivery. 'instant' still produces a normal instant row with no
-- digest fields. Required-delivery, consent, suppression, contact, tenant, idempotency,
-- grant and public-surface behavior are all unchanged.

-- ===========================================================================
-- 1. The explicit per-event cutover gate + the template version that participates in
--    the canonical grouping key.
ALTER TABLE public.notification_event_types
  ADD COLUMN IF NOT EXISTS digest_cutover   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS template_version int     NOT NULL DEFAULT 1;

-- A cutover event must at minimum be digest-capable. (The converse is deliberately NOT
-- constrained: supports_digest without cutover is exactly the eight untouched events.)
ALTER TABLE public.notification_event_types
  DROP CONSTRAINT IF EXISTS chk_event_types_cutover_implies_supports_digest;
ALTER TABLE public.notification_event_types
  ADD CONSTRAINT chk_event_types_cutover_implies_supports_digest
  CHECK (NOT digest_cutover OR supports_digest);

-- open_slots_player is the ONE cutover event in 10c-b. Its engine stays disabled.
UPDATE public.notification_event_types
   SET digest_cutover = true, template_version = 1, updated_at = now()
 WHERE key = 'open_slots_player';

COMMENT ON COLUMN public.notification_event_types.digest_cutover IS
  'Explicit per-event digest-cutover gate. ONLY a cutover event is routed through the v2 digest engine (or given the engine-off skipped outcome). Never infer cutover from supports_digest: eight pre-existing events carry supports_digest and must keep their legacy delayed-instant daily/weekly behavior.';

-- ===========================================================================
-- 2. §TZ — recipient timezone: academy → trainer → Europe/Amsterdam.
CREATE OR REPLACE FUNCTION public.notif_digest_recipient_timezone(
  p_tenant_academy_profile_id uuid,
  p_tenant_trainer_id         uuid
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_tz text;
BEGIN
  IF p_tenant_academy_profile_id IS NOT NULL THEN
    SELECT nullif(btrim(a.timezone), '') INTO v_tz
      FROM public.academy_profiles a WHERE a.id = p_tenant_academy_profile_id;
    IF v_tz IS NOT NULL THEN RETURN v_tz; END IF;
  END IF;
  IF p_tenant_trainer_id IS NOT NULL THEN
    SELECT nullif(btrim(t.timezone), '') INTO v_tz
      FROM public.trainer_profiles t WHERE t.id = p_tenant_trainer_id;
    IF v_tz IS NOT NULL THEN RETURN v_tz; END IF;
  END IF;
  RETURN 'Europe/Amsterdam';
END $$;

COMMENT ON FUNCTION public.notif_digest_recipient_timezone(uuid,uuid) IS
  'ADR 0008 §TZ: resolve the digest recipient timezone academy -> trainer -> Europe/Amsterdam.';

-- ===========================================================================
-- 3. §BND — the immutable digest boundary, DST-correct.
--
-- daily  = the next 09:00 LOCAL at or after enqueue.
-- weekly = the next MONDAY 09:00 LOCAL at or after enqueue (Monday is fixed in 10c-a).
--
-- Correctness note: the arithmetic is done on the LOCAL WALL CLOCK (`AT TIME ZONE tz`
-- yields a plain timestamp), then converted back exactly once. Adding '1 day'/'7 days'
-- to a timestamptz would add 24/168 fixed hours and drift by an hour across a DST
-- transition; adding them to a local timestamp lands on the same wall-clock time on the
-- target day, which is what "next 09:00 local" means. 09:00 is never an ambiguous or
-- non-existent local time in the European DST regime (transitions happen at 02:00/03:00).
CREATE OR REPLACE FUNCTION public.notif_digest_boundary_at(
  p_now       timestamptz,
  p_frequency text,
  p_timezone  text
) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_tz     text := coalesce(nullif(btrim(p_timezone), ''), 'Europe/Amsterdam');
  v_local  timestamp;
  v_cand   timestamp;
  v_try    timestamptz;
  v_result timestamptz;
  v_step   interval;
  v_i      int;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'notif_digest_boundary_at: p_now is required';
  END IF;
  IF p_frequency IS NULL OR p_frequency NOT IN ('daily','weekly') THEN
    RAISE EXCEPTION 'notif_digest_boundary_at: frequency must be daily or weekly (got %)', p_frequency;
  END IF;

  v_local := p_now AT TIME ZONE v_tz;
  -- The cadence step IS the contract: daily advances a day, weekly advances a WEEK so the
  -- boundary stays a Monday. Advancing weekly by a day would silently break "weekly = Monday".
  v_step := CASE WHEN p_frequency = 'daily' THEN interval '1 day' ELSE interval '7 days' END;

  IF p_frequency = 'daily' THEN
    v_cand := date_trunc('day', v_local) + interval '9 hours';
  ELSE
    -- date_trunc('week', ...) is ISO: it lands on Monday 00:00 local.
    v_cand := date_trunc('week', v_local) + interval '9 hours';
  END IF;

  -- EXPLICIT cadence-aware advancement. Two things can make a candidate unusable:
  --   * it is already past (the common case — today's 09:00 has been and gone), or
  --   * the wall time DOES NOT EXIST (a gap swallowed it; Pacific/Apia skipped all of
  --     2011-12-30, and a future DST rule could put a gap over 09:00).
  -- Relying on PostgreSQL's silent normalization for the second case is what would break the
  -- fixed-Monday contract: a skipped Monday normalizes to TUESDAY 09:00, which still reads as
  -- 09:00 local and is still >= p_now, so post-conditions alone cannot catch it. Stepping by
  -- the cadence instead keeps the weekday invariant true by construction.
  --
  -- AMBIGUOUS 09:00 (a fall-back that repeated the hour) is a documented, bounded imprecision:
  -- PostgreSQL resolves the pair to one instant, and if that one precedes p_now we advance a
  -- whole cadence step rather than using the second occurrence. That fails LATE, never early —
  -- monotonicity, the 09:00 wall time and the weekday all still hold. No current IANA rule
  -- makes 09:00 ambiguous in any zone this product serves.
  v_result := NULL;
  FOR v_i IN 1..8 LOOP
    v_try := v_cand AT TIME ZONE v_tz;
    -- round-trip equality is the existence test: a gap-swallowed wall time comes back different
    IF (v_try AT TIME ZONE v_tz) = v_cand AND v_try >= p_now THEN
      v_result := v_try;
      EXIT;
    END IF;
    v_cand := v_cand + v_step;
  END LOOP;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'notif_digest_boundary_at: no valid % boundary within 8 steps of % in timezone %',
      p_frequency, p_now, v_tz;
  END IF;

  v_result := v_cand AT TIME ZONE v_tz;

  -- FAIL-CLOSED POST-CONDITIONS.
  --
  -- The candidate wall time may NOT EXIST. The worked case is Pacific/Apia, which skipped
  -- the whole of 2011-12-30 when it crossed the date line: `2011-12-30 09:00` is not a real
  -- instant there, and `AT TIME ZONE` silently resolves it forward to 2011-12-31 09:00.
  -- (A DST gap covering 09:00 would do the same on a smaller scale.) Resolving FORWARD is
  -- the behaviour we want — §BND asks for the next 09:00 local at or after enqueue, and the
  -- next 09:00 that actually exists is exactly that — so the post-conditions assert the two
  -- properties the state machine genuinely depends on, and deliberately do NOT require the
  -- result to land on the candidate's calendar date:
  --
  --   1. MONOTONICITY. digest_boundary_at is both the immutable group identity and the
  --      initial available_at, so a boundary before p_now would make a group instantly due
  --      and defeat batching entirely.
  --   2. The result reads as exactly 09:00 LOCAL, so every member of a group shares one
  --      coherent boundary rather than a value silently shifted into a different hour.
  --
  -- Swept over 8400 (zone, date, frequency) samples across Europe/Amsterdam, Pacific/Apia,
  -- Australia/Lord_Howe (30-minute DST), Pacific/Chatham (:45 offset), Asia/Kathmandu,
  -- Asia/Tehran, America/Santiago, America/Havana, Antarctica/Troll (2-hour jump) and
  -- Pacific/Kiritimati: both hold, including across Apia's skipped day. They raise rather
  -- than mint an incoherent group identity if a future zone rule ever breaks them.
  IF v_result < p_now THEN
    RAISE EXCEPTION 'notif_digest_boundary_at: computed boundary % precedes p_now % (timezone %)',
      v_result, p_now, v_tz;
  END IF;
  IF to_char(v_result AT TIME ZONE v_tz, 'HH24:MI') <> '09:00' THEN
    RAISE EXCEPTION 'notif_digest_boundary_at: boundary % is not 09:00 local in timezone % (got %)',
      v_result, v_tz, to_char(v_result AT TIME ZONE v_tz, 'HH24:MI');
  END IF;
  -- weekly = MONDAY, fixed in 10c-a. Asserted, not merely intended: this is the invariant a
  -- silent normalization would break, and the cadence-aware step above is what keeps it true.
  IF p_frequency = 'weekly' AND extract(isodow FROM (v_result AT TIME ZONE v_tz)) <> 1 THEN
    RAISE EXCEPTION 'notif_digest_boundary_at: weekly boundary % is not a Monday in timezone % (isodow %)',
      v_result, v_tz, extract(isodow FROM (v_result AT TIME ZONE v_tz));
  END IF;

  RETURN v_result;
END $$;

COMMENT ON FUNCTION public.notif_digest_boundary_at(timestamptz,text,text) IS
  'ADR 0008 §BND: the immutable digest boundary — next 09:00 local (daily) or next Monday 09:00 local (weekly), at or after p_now. DST-correct: arithmetic runs on the local wall clock, converted back once.';

-- ===========================================================================
-- 4. Group locale — binary nl/en, matching notif_digest_item_open_slots_v1's own
--    deterministic fallback so the item locale and the GROUP locale can never diverge
--    (they are both canonical-key inputs; a divergence would split or mis-merge groups).
CREATE OR REPLACE FUNCTION public.notif_digest_group_locale(
  p_person_id uuid,
  p_user_id   uuid
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_lang text;
BEGIN
  IF p_person_id IS NOT NULL THEN
    SELECT nullif(btrim(p.preferred_language), '') INTO v_lang
      FROM public.persons p WHERE p.id = p_person_id;
  END IF;
  IF v_lang IS NULL AND p_user_id IS NOT NULL THEN
    SELECT nullif(btrim(pr.preferred_language), '') INTO v_lang
      FROM public.profiles pr WHERE pr.user_id = p_user_id;
  END IF;
  RETURN CASE WHEN lower(coalesce(v_lang, '')) LIKE 'nl%' THEN 'nl' ELSE 'en' END;
END $$;

COMMENT ON FUNCTION public.notif_digest_group_locale(uuid,uuid) IS
  'Binary nl/en digest group locale (persons.preferred_language -> profiles.preferred_language -> en). Mirrors notif_digest_item_open_slots_v1 so item locale and group locale never diverge.';

-- ===========================================================================
-- 5. TRUSTED item minting. The digest item is rendered by service-role SQL from
--    STRUCTURED caller fields — never by the edge function, and never accepted as
--    pre-rendered content. This is the only path a digest item may enter the outbox.
CREATE OR REPLACE FUNCTION public.notif_digest_item_for_event(
  p_event_key text,
  p_locale    text,
  p_payload   jsonb
) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE v_subtype text;
BEGIN
  IF p_event_key = 'open_slots_player' THEN
    v_subtype := nullif(btrim(coalesce(p_payload->>'subtype', '')), '');
    IF v_subtype IS NULL THEN
      RAISE EXCEPTION 'notif_digest_item_for_event: open_slots_player payload needs a subtype';
    END IF;
    -- The renderer owns validation (subtype allow-list, ISO date/time, safety, URL shape)
    -- and determinism. `data` is the structured sub-object; a caller cannot inject copy.
    RETURN public.notif_digest_item_open_slots_v1(
      v_subtype, p_locale, coalesce(p_payload->'data', '{}'::jsonb));
  END IF;
  RAISE EXCEPTION 'notif_digest_item_for_event: no trusted item builder for event %', p_event_key;
END $$;

COMMENT ON FUNCTION public.notif_digest_item_for_event(text,text,jsonb) IS
  'Trusted server-side digest-item dispatch. Mints the immutable typed item from STRUCTURED payload fields via the event''s own validating renderer. Edge-rendered content is never trusted or accepted.';

-- ===========================================================================
-- 6. MANDATORY v1 -> v2 PREFERENCE BACKFILL, before producer cutover.
--
-- Why this is not optional (verified in code): send-email maps new_availability /
-- slot_reopened onto notification_preferences.open_slots_digest and ENFORCES it —
-- 'off' suppresses, 'daily'/'weekly' queue into the v1 notification_queue. The column
-- is NOT NULL DEFAULT 'weekly'. Cutting the producer over to enqueue_notification
-- without carrying those choices across would silently resume mail for every user who
-- had set 'off'.
--
-- Rules:
--   * an EXISTING explicit v2 row WINS (ON CONFLICT DO NOTHING) — a user who already
--     expressed a v2 cadence is never overwritten by their stale legacy value;
--   * off / instant / daily / weekly are carried across EXACTLY;
--   * any other legacy value is ignored rather than coerced (fail-safe: an unknown
--     cadence must not silently become 'instant' and start mailing);
--   * re-running creates no duplicates and no drift — it is a pure no-op the second time;
--   * a user with NO legacy row keeps the reviewed catalog default (weekly) by having
--     no v2 row at all, which is exactly how the resolver reads a default.
INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
SELECT np.user_id, 'open_slots_player', np.open_slots_digest
  FROM public.notification_preferences np
 WHERE np.user_id IS NOT NULL
   AND np.open_slots_digest IN ('off','instant','daily','weekly')
   AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = np.user_id)
ON CONFLICT (user_id, event_type) DO NOTHING;

-- ===========================================================================
-- 7. §PS EVENT POLICY HOOK — the open-slots stop checks.
--
-- ADR §PS reserved an "event policy hook [10c-b]" alongside the generic live checks.
-- The generic notif_digest_member_stop_reason already re-runs the resolver's live email
-- lookup and covers: contact revoked/opted-out/out-of-scope, no destination, LIVE
-- destination no longer fingerprinting to the frozen value, hard suppression, and
-- preference 'off'. This adds what is specific to open slots:
--   * the follower row still EXISTS, and
--   * notify_new_availability is still TRUE.
-- Both are evaluated at prepare AND before every attempt, because a player can unfollow
-- (or mute) a trainer between enqueue and send, and a frozen digest must not go out to
-- someone who has since opted out of exactly this notification.
CREATE OR REPLACE FUNCTION public.notif_digest_event_stop_reason(p_member_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE o record;
BEGIN
  SELECT o2.event_type, o2.recipient_user_id, o2.tenant_trainer_id
    INTO o FROM public.notification_outbox o2 WHERE o2.id = p_member_id;
  IF NOT FOUND THEN RETURN 'missing_member'; END IF;

  IF o.event_type = 'open_slots_player' THEN
    -- The follow relationship is keyed by profiles.id; the outbox freezes the auth user.
    -- No live profile / no follow row / muted flag all STOP the member.
    IF o.tenant_trainer_id IS NULL OR o.recipient_user_id IS NULL THEN
      RETURN 'follow_revoked';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.trainer_followers tf
        JOIN public.profiles pr ON pr.id = tf.player_id
       WHERE tf.trainer_id = o.tenant_trainer_id
         AND pr.user_id = o.recipient_user_id
         AND tf.notify_new_availability IS TRUE
    ) THEN
      RETURN 'follow_revoked';
    END IF;
  END IF;

  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.notif_digest_event_stop_reason(uuid) IS
  'ADR 0008 §PS event policy hook (10c-b): per-event stop checks layered on the generic live checks. open_slots_player stops when the follower row is gone or notify_new_availability is false.';

-- Layer the hook into the ONE stop predicate both prepare and begin already call, so a
-- new check cannot be wired into one path and forgotten in the other.
CREATE OR REPLACE FUNCTION public.notif_digest_member_stop_reason(p_member_id uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o record; v_required boolean; v_dest text; v_event_stop text;
BEGIN
  SELECT o2.destination_fingerprint, o2.recipient_person_id, o2.recipient_user_id, o2.recipient_guest_player_id,
         o2.tenant_academy_profile_id, o2.tenant_trainer_id, o2.event_type
    INTO o FROM public.notification_outbox o2 WHERE o2.id = p_member_id;
  IF NOT FOUND THEN RETURN 'missing_member'; END IF;
  SELECT coalesce(et.required_delivery, false) INTO v_required
    FROM public.notification_event_types et WHERE et.key = o.event_type;
  v_required := coalesce(v_required, false);

  -- RE-RUN the resolver's LIVE email lookup verbatim (never trust outbox.contact_id — its FK is ON DELETE
  -- SET NULL, so a deleted contact leaves NULL and any frozen fallback would fail OPEN): ownership
  -- (person/user/guest), revocation, opt-out, tenant consent scope, and global-only-for-account-holders.
  SELECT c.destination_normalized INTO v_dest
    FROM public.notification_contacts c
   WHERE c.channel = 'email' AND c.revoked_at IS NULL AND c.consent_status <> 'opted_out'
     AND (c.consent_scope <> 'global' OR o.recipient_user_id IS NOT NULL)
     AND public.is_notification_consent_in_scope(
           c.consent_scope, c.consent_academy_profile_id, c.consent_trainer_id,
           o.tenant_academy_profile_id, o.tenant_trainer_id)
     AND ( (o.recipient_person_id IS NOT NULL AND c.person_id = o.recipient_person_id)
        OR (o.recipient_user_id   IS NOT NULL AND c.user_id   = o.recipient_user_id)
        OR (o.recipient_guest_player_id IS NOT NULL AND c.guest_player_id = o.recipient_guest_player_id) )
   ORDER BY c.is_primary DESC, c.verified_at DESC NULLS LAST
   LIMIT 1;
  IF NOT FOUND THEN
    IF o.recipient_user_id IS NOT NULL THEN
      -- global fallback ONLY for account holders (their own login email) — resolver semantics.
      SELECT p.email INTO v_dest FROM public.persons p WHERE p.user_id = o.recipient_user_id;
      IF v_dest IS NULL OR length(btrim(v_dest)) = 0 THEN RETURN 'no_destination'; END IF;
    ELSE
      RETURN 'contact_revoked';   -- guest/person-only: no live in-scope owned contact → STOP. Frozen data
    END IF;                       -- is NEVER a live-deliverability substitute.
  END IF;
  IF v_dest IS NULL OR length(btrim(v_dest)) = 0 THEN RETURN 'no_destination'; END IF;

  -- the LIVE destination must still fingerprint to the member's frozen destination_fingerprint —
  -- a changed contact/account email means this frozen digest would go to the WRONG (old) address.
  IF o.destination_fingerprint IS NOT NULL
     AND notif_digest_destination_fingerprint(v_dest) <> o.destination_fingerprint THEN
    RETURN 'destination_changed';
  END IF;
  IF public.is_email_suppressed(v_dest) THEN RETURN 'suppressed'; END IF;   -- required never bypasses this

  IF NOT v_required AND o.recipient_user_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.notification_preferences_v2 p
        WHERE p.user_id = o.recipient_user_id AND p.event_type = o.event_type AND p.email_frequency = 'off') THEN
    RETURN 'preference_off';                                 -- ONLY this is required_delivery-exempt
  END IF;

  -- 10c-b: the per-event policy hook, evaluated LAST so the generic deliverability
  -- reasons stay the reported cause when both apply. Required-delivery does NOT bypass
  -- it: an event-specific opt-out (unfollow/mute) is a consent signal, not a cadence.
  v_event_stop := public.notif_digest_event_stop_reason(p_member_id);
  IF v_event_stop IS NOT NULL THEN RETURN v_event_stop; END IF;

  RETURN NULL;
END $$;

-- ===========================================================================
-- 8. Grants. Helpers are owner-invoked by the SECURITY DEFINER RPCs; they are NOT
--    part of the service_role RPC allow-list (ADR §Round-8: a forged direct call to a
--    helper must not be able to bypass run/ownership/ledger invariants).
REVOKE ALL ON FUNCTION public.notif_digest_recipient_timezone(uuid,uuid)          FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.notif_digest_boundary_at(timestamptz,text,text)     FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.notif_digest_group_locale(uuid,uuid)               FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.notif_digest_item_for_event(text,text,jsonb)        FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.notif_digest_event_stop_reason(uuid)                FROM PUBLIC, anon, authenticated, service_role;
-- ...with ONE exception. The INSTANT email worker must apply the same event stop policy before
-- it sends (10c-b D): enqueue and send are separated in time, so a player can unfollow between
-- them, and the digest path's pre-prepare/pre-attempt checks do not cover the instant path.
-- Unlike the other helpers this is a pure READ that returns a reason and mutates nothing, so
-- granting it cannot bypass any run/ownership/ledger invariant — the Round-8 concern that
-- motivates revoking the rest does not apply.
GRANT EXECUTE ON FUNCTION public.notif_digest_event_stop_reason(uuid)             TO service_role;
