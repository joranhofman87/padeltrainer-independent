-- PR 10b: an ACTOR-CALLABLE enqueue RPC for the booking notifications that still live on the
-- legacy send-email path (booking_request, manual_booking_confirmation, booking_cancelled).
--
-- WHY AN RPC AND NOT A TRIGGER ON bookings
-- ----------------------------------------
-- A trigger fires on EVERY booking insert, including paid ones whose confirmation
-- mollie-booking-paid-side-effects already enqueues. Telling "manual" from "paid" inside a
-- trigger means encoding payment-flow knowledge in the database, and a subtly wrong guess
-- sends duplicate mail to real customers — the exact failure this PR removed from the review
-- path. So the enqueue stays where the DECISION is: the code that knows it just did something
-- notification-worthy calls this once, explicitly.
--
-- THE CLIENT IS TRUSTED WITH BOOKING IDS AND AN INTENT. NOTHING ELSE.
-- Recipients, addresses, tenant refs and copy are derived here by re-reading the bookings
-- under the function's own privileges.
--
-- THE FIRST VERSION OF THIS FUNCTION WAS WRONG IN WAYS WORTH RECORDING, because each is a
-- shape that will look reasonable again:
--
--   * it authorized the FIRST booking id and then processed the whole array — so appending
--     other people's booking ids after one you own was a privilege escalation;
--   * `IF NOT (actor = trainer_user OR ...)` FAILS OPEN when trainer_user IS NULL: NOT NULL
--     is NULL, the RAISE is skipped, the caller is authorized. Every gate below is written
--     `IS NOT TRUE` for this reason. A NULL p_kind likewise slipped past `NOT IN` and landed
--     in the cancellation branch;
--   * one session table was built from ALL bookings and then emitted once PER booking, which
--     is both an email storm and a privacy leak across players in a mixed array;
--   * intent was never checked against booking STATE, so a caller could announce a
--     cancellation for a live booking;
--   * idempotency keyed on the first id, so reordering the array duplicated the mail;
--   * names went into HTML unescaped, ignoring the escape-once discipline the shared
--     renderers already follow.

-- Minimal HTML escape for values that reach an email body. Deliberately its own function so
-- there is one place to audit, and so a future renderer cannot "forget" it silently.
CREATE OR REPLACE FUNCTION public.notification_html_escape(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT replace(replace(replace(replace(replace(
           coalesce(p_text, ''),
           '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;');
$$;

REVOKE ALL ON FUNCTION public.notification_html_escape(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notification_html_escape(text) TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_booking_notification(
  p_booking_ids uuid[],
  p_kind        text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor     uuid := auth.uid();
  v_ids       uuid[];
  v_n         int;
  v_trainer   uuid;
  v_academy   uuid;
  v_owner     boolean;
  v_trn_user  uuid;
  v_trn_name  text;
  v_subject   text;
  v_html      text;
  v_rows      text;
  v_key       text;
  v_count     int := 0;
  r           record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'enqueue_booking_notification: no authenticated actor';
  END IF;

  -- coalesce so a NULL kind cannot slip past NOT IN and fall through to a branch.
  IF coalesce(p_kind, '') NOT IN ('request_staff', 'confirmation_player', 'cancelled_player') THEN
    RAISE EXCEPTION 'enqueue_booking_notification: unknown kind %', coalesce(p_kind, '<null>');
  END IF;

  -- CANONICAL SET: distinct + sorted. Everything downstream (validation, idempotency) uses
  -- this, so argument order and duplicates cannot change the outcome.
  SELECT array_agg(DISTINCT b ORDER BY b) INTO v_ids
    FROM unnest(coalesce(p_booking_ids, ARRAY[]::uuid[])) AS b
   WHERE b IS NOT NULL;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;
  v_n := array_length(v_ids, 1);

  -- EVERY id must exist. A missing id means the caller is describing bookings that are not
  -- there, and we must not silently notify about the subset that happens to resolve.
  IF (SELECT count(*) FROM public.bookings WHERE id = ANY(v_ids)) <> v_n THEN
    RAISE EXCEPTION 'enqueue_booking_notification: unknown booking id in set';
  END IF;

  -- SINGLE TENANT. A cyclus spans several slots but one owner; a set spanning owners is
  -- either a mistake or an attempt to borrow authorization from the one slot you do own.
  -- NOTE: there is no min(uuid) in Postgres — take the first element of the DISTINCT
  -- aggregate instead. (The CREATE succeeds either way: a plpgsql body is not executed at
  -- definition time, so `supabase db reset` would never have surfaced this.)
  SELECT count(DISTINCT s.trainer_id),
         count(DISTINCT coalesce(s.academy_profile_id, '00000000-0000-0000-0000-000000000000'::uuid)),
         (array_agg(DISTINCT s.trainer_id))[1],
         (array_agg(DISTINCT s.academy_profile_id))[1]
    INTO v_n, v_count, v_trainer, v_academy
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
   WHERE b.id = ANY(v_ids);
  IF v_n <> 1 OR v_count <> 1 THEN
    RAISE EXCEPTION 'enqueue_booking_notification: booking set spans multiple tenants';
  END IF;
  v_count := 0;

  SELECT tp.user_id INTO v_trn_user FROM public.trainer_profiles tp WHERE tp.id = v_trainer;
  SELECT pr.full_name INTO v_trn_name FROM public.profiles pr WHERE pr.user_id = v_trn_user;

  -- Does the actor OWN this slot's tenant?
  --
  -- The thing doing the real work here is the explicit `IS NOT NULL` on each side, NOT the
  -- trailing `IS TRUE` — mutation testing showed the gate still denies with the `IS TRUE`
  -- removed, but FAILS OPEN the moment `v_trn_user IS NOT NULL AND` is dropped. Without it,
  -- an orphan trainer_profile (user_id NULL) makes the comparison NULL, and a NULL sails
  -- through `IF NOT ...` as "not rejected". The `IS TRUE`/`IS NOT TRUE` pair stays as
  -- belt-and-braces, but the NULL guards are the load-bearing part.
  v_owner := (
    (v_trn_user IS NOT NULL AND v_actor = v_trn_user)
    OR (v_academy IS NOT NULL AND public.is_academy_manager(v_actor, v_academy) IS TRUE)
  ) IS TRUE;

  -- ── AUTH MATRIX + STATE VALIDATION, over the WHOLE set ────────────────────────────────
  IF p_kind = 'request_staff' THEN
    -- Player self-service only: the actor must be the player on EVERY booking, and every
    -- booking must actually be awaiting approval.
    IF EXISTS (
      SELECT 1 FROM public.bookings b
      LEFT JOIN public.profiles pr ON pr.id = b.player_id
      WHERE b.id = ANY(v_ids)
        AND ((pr.user_id IS NOT NULL AND pr.user_id = v_actor) IS NOT TRUE)
    ) THEN
      RAISE EXCEPTION 'enqueue_booking_notification: actor is not the player on every booking';
    END IF;
    IF EXISTS (SELECT 1 FROM public.bookings WHERE id = ANY(v_ids) AND status IS DISTINCT FROM 'pending_approval') THEN
      RAISE EXCEPTION 'enqueue_booking_notification: request_staff needs pending_approval bookings';
    END IF;

  ELSIF p_kind = 'confirmation_player' THEN
    -- Either the player booking for THEMSELVES, or STAFF booking on their behalf (which is
    -- how BookForPlayerDialog reaches this, including for guest players who have no account).
    IF v_owner IS NOT TRUE AND EXISTS (
      SELECT 1 FROM public.bookings b
      LEFT JOIN public.profiles pr ON pr.id = b.player_id
      WHERE b.id = ANY(v_ids)
        AND ((pr.user_id IS NOT NULL AND pr.user_id = v_actor) IS NOT TRUE)
    ) THEN
      RAISE EXCEPTION 'enqueue_booking_notification: actor is neither the player nor the slot owner';
    END IF;
    -- One recipient per confirmation: a set covering several players is not one confirmation.
    IF (SELECT count(*) FROM (
          SELECT DISTINCT b.player_id, b.guest_player_id
            FROM public.bookings b WHERE b.id = ANY(v_ids)
        ) d) <> 1 THEN
      RAISE EXCEPTION 'enqueue_booking_notification: confirmation set covers multiple recipients';
    END IF;
    -- Not for PAID bookings: those are the paid path's booking_confirmed_player.
    IF EXISTS (
      SELECT 1 FROM public.bookings
       WHERE id = ANY(v_ids)
         AND (status NOT IN ('confirmed', 'pending') OR payment_status = 'paid')
    ) THEN
      RAISE EXCEPTION 'enqueue_booking_notification: confirmation needs unpaid confirmed/pending bookings';
    END IF;

  ELSE  -- cancelled_player
    IF v_owner IS NOT TRUE THEN
      RAISE EXCEPTION 'enqueue_booking_notification: actor does not own this slot';
    END IF;
    IF EXISTS (SELECT 1 FROM public.bookings WHERE id = ANY(v_ids) AND status NOT IN ('cancelled', 'cancelled_swap')) THEN
      RAISE EXCEPTION 'enqueue_booking_notification: cancelled_player needs cancelled bookings';
    END IF;
  END IF;

  -- Idempotency over the CANONICAL set, not the first id: reordering or de-duplicating the
  -- argument cannot produce a second notification.
  v_key := p_kind || ':' || md5(array_to_string(v_ids, ','));

  IF p_kind = 'request_staff' THEN
    IF v_trn_user IS NULL THEN RETURN 0; END IF;   -- orphan trainer: nobody to notify
    SELECT string_agg(
             '<tr><td style="padding:4px 12px 4px 0">' || to_char(s.start_time AT TIME ZONE 'Europe/Amsterdam', 'DD-MM-YYYY')
             || '</td><td style="padding:4px 12px 4px 0">' || to_char(s.start_time AT TIME ZONE 'Europe/Amsterdam', 'HH24:MI')
             || '–' || to_char(s.end_time AT TIME ZONE 'Europe/Amsterdam', 'HH24:MI')
             || '</td><td style="padding:4px 0">' || public.notification_html_escape(l.name) || '</td></tr>',
             '' ORDER BY s.start_time)
      INTO v_rows
      FROM public.bookings b
      JOIN public.availability_slots s ON s.id = b.slot_id
      LEFT JOIN public.locations l ON l.id = s.location_id
     WHERE b.id = ANY(v_ids);

    SELECT public.notification_html_escape(coalesce(pr.full_name, gp.full_name, 'Een speler'))
      INTO v_subject
      FROM public.bookings b
      LEFT JOIN public.profiles pr ON pr.id = b.player_id
      LEFT JOIN public.guest_players gp ON gp.id = b.guest_player_id
     WHERE b.id = v_ids[1];

    v_html := '<div style="font-family:sans-serif"><h2>Nieuwe boekingsaanvraag</h2><p>Hoi '
      || public.notification_html_escape(v_trn_name) || ',</p><p>' || v_subject
      || ' heeft een aanvraag gedaan:</p><table>' || coalesce(v_rows, '') || '</table>'
      || '<p>Je kunt de aanvraag goedkeuren of afwijzen in je agenda.</p></div>';

    PERFORM public.enqueue_notification(
      p_event_key                 => 'booking_request_staff',
      p_recipient_user_id         => v_trn_user,
      p_tenant_trainer_id         => v_trainer,
      p_tenant_academy_profile_id => v_academy,
      p_idempotency_subject       => v_key,
      p_related_booking_ids       => v_ids,
      p_payload                   => jsonb_build_object('subject', 'Nieuwe boekingsaanvraag', 'html', v_html),
      p_public_summary            => jsonb_build_object('event_type', 'booking_request_staff', 'sessions', array_length(v_ids, 1))
    );
    v_count := 1;

  ELSE
    -- confirmation_player and cancelled_player both fan out PER RECIPIENT, and each recipient
    -- sees ONLY their own sessions. (confirmation_player is validated above to be exactly one
    -- recipient; cancellation may legitimately cover many.)
    FOR r IN
      SELECT pr.user_id AS ruser, b.guest_player_id AS rguest,
             coalesce(pr.full_name, gp.full_name, '') AS rname,
             array_agg(b.id ORDER BY b.id) AS ids,
             string_agg(
               '<tr><td style="padding:4px 12px 4px 0">' || to_char(s.start_time AT TIME ZONE 'Europe/Amsterdam', 'DD-MM-YYYY')
               || '</td><td style="padding:4px 12px 4px 0">' || to_char(s.start_time AT TIME ZONE 'Europe/Amsterdam', 'HH24:MI')
               || '–' || to_char(s.end_time AT TIME ZONE 'Europe/Amsterdam', 'HH24:MI')
               || '</td><td style="padding:4px 0">' || public.notification_html_escape(l.name) || '</td></tr>',
               '' ORDER BY s.start_time) AS rows
        FROM public.bookings b
        JOIN public.availability_slots s ON s.id = b.slot_id
        LEFT JOIN public.locations l ON l.id = s.location_id
        LEFT JOIN public.profiles pr ON pr.id = b.player_id
        LEFT JOIN public.guest_players gp ON gp.id = b.guest_player_id
       WHERE b.id = ANY(v_ids)
       GROUP BY pr.user_id, b.guest_player_id, coalesce(pr.full_name, gp.full_name, '')
    LOOP
      CONTINUE WHEN r.ruser IS NULL AND r.rguest IS NULL;   -- nobody to address

      IF p_kind = 'confirmation_player' THEN
        v_subject := 'Je boeking is bevestigd';
        v_html := '<div style="font-family:sans-serif"><h2>Je boeking is bevestigd</h2><p>Hoi '
          || public.notification_html_escape(r.rname) || ',</p><p>Je sessie(s) staan klaar. '
          || 'Betaling regel je met ' || public.notification_html_escape(coalesce(v_trn_name, 'je trainer'))
          || '.</p><table>' || coalesce(r.rows, '') || '</table></div>';
      ELSE
        v_subject := 'Je sessie is geannuleerd';
        v_html := '<div style="font-family:sans-serif"><h2>Je sessie is geannuleerd</h2><p>'
          || public.notification_html_escape(coalesce(v_trn_name, 'Je trainer'))
          || ' heeft de volgende sessie(s) geannuleerd:</p><table>' || coalesce(r.rows, '')
          || '</table><p>Neem contact op met je trainer voor een alternatief.</p></div>';
      END IF;

      PERFORM public.enqueue_notification(
        p_event_key                 => CASE WHEN p_kind = 'confirmation_player'
                                            THEN 'booking_confirmed_player' ELSE 'booking_cancelled_player' END,
        p_recipient_user_id         => r.ruser,
        p_recipient_guest_player_id => r.rguest,
        p_tenant_trainer_id         => v_trainer,
        p_tenant_academy_profile_id => v_academy,
        -- Per-recipient key: the canonical set for THAT recipient, so one person's retry
        -- cannot suppress another's notification.
        p_idempotency_subject       => v_key || ':' || md5(array_to_string(r.ids, ',')),
        p_related_booking_ids       => r.ids,
        p_payload                   => jsonb_build_object('subject', v_subject, 'html', v_html),
        p_public_summary            => jsonb_build_object(
                                         'event_type', CASE WHEN p_kind = 'confirmation_player'
                                           THEN 'booking_confirmed_player' ELSE 'booking_cancelled_player' END,
                                         'sessions', array_length(r.ids, 1))
      );
      v_count := v_count + 1;
    END LOOP;
  END IF;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.enqueue_booking_notification(uuid[], text) IS
  'PR 10b: actor-callable enqueue for booking notifications that used to go through legacy '
  'send-email. Takes booking ids + intent ONLY. Validates the ENTIRE canonical set: every id '
  'must exist, the set must be single-tenant, the actor must be authorized for the intent '
  '(player for request; player OR slot owner for confirmation, which is how staff book for '
  'registered and guest players; slot owner for cancellation), and each booking status must '
  'match the intent. Fans out per recipient with only that recipient sessions. Idempotency is '
  'derived from the canonical sorted set, prefixed per kind, so it cannot collide with the '
  'paid path booking_confirmed_player (which keys on the Mollie payment id). All interpolated '
  'values are HTML-escaped.';

-- ALTER DEFAULT PRIVILEGES in this project grants EXECUTE on new functions to anon and
-- authenticated, and a bare REVOKE FROM PUBLIC does NOT undo it. Revoke explicitly, then grant
-- back only to authenticated: reachable by a logged-in actor by design, never by anon.
REVOKE ALL ON FUNCTION public.enqueue_booking_notification(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_booking_notification(uuid[], text) TO authenticated, service_role;
