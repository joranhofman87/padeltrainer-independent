-- PR 10b: an ACTOR-CALLABLE enqueue RPC for the booking notifications that still live on the
-- legacy send-email path (booking_request, manual_booking_confirmation, booking_cancelled).
--
-- WHY AN RPC AND NOT A TRIGGER ON bookings
-- ----------------------------------------
-- A trigger fires on EVERY booking insert, including the paid ones whose confirmation is
-- already enqueued by mollie-booking-paid-side-effects. Distinguishing "manual" from "paid"
-- inside a trigger means encoding payment-flow knowledge in the database, and getting it
-- subtly wrong sends duplicate mail to real customers. That is precisely the failure PR 10b
-- just removed from the review path (a pilot trigger AND a client send, both firing).
--
-- So the enqueue stays where the DECISION is: the code that knows it just took an action that
-- warrants a notification calls this once, explicitly.
--
-- WHAT THE CLIENT IS TRUSTED WITH: booking ids and an intent. NOTHING ELSE.
-- Recipients, addresses, tenant refs and copy are all derived here from the booking row. A
-- client-supplied recipient address deciding where mail goes is exactly the shape this
-- migration exists to remove.
--
-- IDEMPOTENCY: each kind uses a DISTINCT subject prefix over the booking id, so a manual
-- confirmation can never collide with the paid path's booking_confirmed_player (which keys on
-- the Mollie payment id). A double-click, a retry, or a re-render enqueues the same key and
-- the resolver no-ops.

CREATE OR REPLACE FUNCTION public.enqueue_booking_notification(
  p_booking_ids uuid[],
  p_kind        text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_first        uuid;
  v_slot         record;
  v_player_user  uuid;
  v_guest        uuid;
  v_player_name  text;
  v_trainer_user uuid;
  v_trainer_name text;
  v_subject      text;
  v_html         text;
  v_sessions     text := '';
  v_count        int  := 0;
  r              record;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'enqueue_booking_notification: no authenticated actor';
  END IF;
  IF p_kind NOT IN ('request_staff', 'manual_confirmation_player', 'cancelled_player') THEN
    RAISE EXCEPTION 'enqueue_booking_notification: unknown kind %', p_kind;
  END IF;
  IF p_booking_ids IS NULL OR array_length(p_booking_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  v_first := p_booking_ids[1];

  -- Booking + slot context. NOTE the bookings are re-read here under the function's own
  -- privileges: the caller does not get to describe the booking, only to name it.
  SELECT b.player_id, b.guest_player_id,
         s.trainer_id, s.academy_profile_id, s.start_time, s.end_time, s.cyclus_name,
         l.name AS location_name, l.city AS location_city
    INTO v_slot
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    LEFT JOIN public.locations l ON l.id = s.location_id
   WHERE b.id = v_first;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'enqueue_booking_notification: booking % not found', v_first;
  END IF;

  SELECT pr.user_id, pr.full_name INTO v_player_user, v_player_name
    FROM public.profiles pr WHERE pr.id = v_slot.player_id;
  v_guest := v_slot.guest_player_id;
  IF v_player_name IS NULL AND v_guest IS NOT NULL THEN
    SELECT gp.full_name INTO v_player_name FROM public.guest_players gp WHERE gp.id = v_guest;
  END IF;

  SELECT tp.user_id INTO v_trainer_user
    FROM public.trainer_profiles tp WHERE tp.id = v_slot.trainer_id;
  SELECT pr.full_name INTO v_trainer_name
    FROM public.profiles pr WHERE pr.user_id = v_trainer_user;

  -- ── ACTOR VALIDATION ───────────────────────────────────────────────────────────────────
  -- Player-initiated kinds: the caller must BE the player on the booking. Staff-initiated
  -- cancellation: the caller must own the slot's tenant. Anything else is refused loudly —
  -- an unauthorised enqueue is a stranger addressing mail to someone else's player.
  IF p_kind IN ('request_staff', 'manual_confirmation_player') THEN
    IF v_player_user IS NULL OR v_player_user <> v_actor THEN
      RAISE EXCEPTION 'enqueue_booking_notification: actor is not the booking player';
    END IF;
  ELSE
    IF NOT (
      v_actor = v_trainer_user
      OR (v_slot.academy_profile_id IS NOT NULL
          AND public.is_academy_manager(v_actor, v_slot.academy_profile_id))
    ) THEN
      RAISE EXCEPTION 'enqueue_booking_notification: actor does not own this slot';
    END IF;
  END IF;

  -- Session lines, chronological, over the whole set (a cyclus books N rows at once).
  FOR r IN
    SELECT s.start_time, s.end_time, l.name AS loc
      FROM public.bookings b
      JOIN public.availability_slots s ON s.id = b.slot_id
      LEFT JOIN public.locations l ON l.id = s.location_id
     WHERE b.id = ANY(p_booking_ids)
     ORDER BY s.start_time
  LOOP
    v_sessions := v_sessions
      || '<tr><td style="padding:4px 12px 4px 0">'
      || to_char(r.start_time AT TIME ZONE 'Europe/Amsterdam', 'DD-MM-YYYY')
      || '</td><td style="padding:4px 12px 4px 0">'
      || to_char(r.start_time AT TIME ZONE 'Europe/Amsterdam', 'HH24:MI')
      || '–' || to_char(r.end_time AT TIME ZONE 'Europe/Amsterdam', 'HH24:MI')
      || '</td><td style="padding:4px 0">' || coalesce(r.loc, '') || '</td></tr>';
  END LOOP;

  IF p_kind = 'request_staff' THEN
    IF v_trainer_user IS NULL THEN RETURN 0; END IF;   -- trainer has no account to notify
    v_subject := 'Nieuwe boekingsaanvraag';
    v_html := '<div style="font-family:sans-serif">'
      || '<h2>Nieuwe boekingsaanvraag</h2><p>Hoi ' || coalesce(v_trainer_name, '') || ',</p>'
      || '<p>' || coalesce(v_player_name, 'Een speler') || ' heeft een aanvraag gedaan:</p>'
      || '<table>' || v_sessions || '</table>'
      || '<p>Je kunt de aanvraag goedkeuren of afwijzen in je agenda.</p></div>';
    PERFORM public.enqueue_notification(
      p_event_key           => 'booking_request_staff',
      p_recipient_user_id   => v_trainer_user,
      p_tenant_trainer_id   => v_slot.trainer_id,
      p_tenant_academy_profile_id => v_slot.academy_profile_id,
      p_idempotency_subject => 'request:' || v_first::text,
      p_related_booking_ids => p_booking_ids,
      p_payload             => jsonb_build_object('subject', v_subject, 'html', v_html),
      p_public_summary      => jsonb_build_object('event_type', 'booking_request_staff',
                                                  'sessions', array_length(p_booking_ids, 1))
    );
    v_count := 1;

  ELSIF p_kind = 'manual_confirmation_player' THEN
    v_subject := 'Je boeking is bevestigd';
    v_html := '<div style="font-family:sans-serif">'
      || '<h2>Je boeking is bevestigd</h2><p>Hoi ' || coalesce(v_player_name, '') || ',</p>'
      || '<p>Je sessie(s) staan klaar. Betaling regel je met '
      || coalesce(v_trainer_name, 'je trainer') || '.</p>'
      || '<table>' || v_sessions || '</table></div>';
    PERFORM public.enqueue_notification(
      p_event_key           => 'booking_confirmed_player',
      p_recipient_user_id   => v_player_user,
      p_tenant_trainer_id   => v_slot.trainer_id,
      p_tenant_academy_profile_id => v_slot.academy_profile_id,
      -- 'manual:' prefix — the paid path keys on the Mollie payment id, so these two can
      -- never produce the same idempotency key for the same booking.
      p_idempotency_subject => 'manual:' || v_first::text,
      p_related_booking_ids => p_booking_ids,
      p_payload             => jsonb_build_object('subject', v_subject, 'html', v_html),
      p_public_summary      => jsonb_build_object('event_type', 'booking_confirmed_player',
                                                  'sessions', array_length(p_booking_ids, 1))
    );
    v_count := 1;

  ELSE  -- cancelled_player: one row per cancelled booking, guests included
    FOR r IN
      SELECT b.id, b.player_id, b.guest_player_id, pr.user_id AS puser
        FROM public.bookings b
        LEFT JOIN public.profiles pr ON pr.id = b.player_id
       WHERE b.id = ANY(p_booking_ids)
    LOOP
      IF r.puser IS NULL AND r.guest_player_id IS NULL THEN CONTINUE; END IF;
      v_subject := 'Je sessie is geannuleerd';
      v_html := '<div style="font-family:sans-serif">'
        || '<h2>Je sessie is geannuleerd</h2>'
        || '<p>' || coalesce(v_trainer_name, 'Je trainer')
        || ' heeft de volgende sessie geannuleerd:</p>'
        || '<table>' || v_sessions || '</table>'
        || '<p>Neem contact op met je trainer voor een alternatief.</p></div>';
      PERFORM public.enqueue_notification(
        p_event_key                 => 'booking_cancelled_player',
        p_recipient_user_id         => r.puser,
        p_recipient_guest_player_id => r.guest_player_id,
        p_tenant_trainer_id         => v_slot.trainer_id,
        p_tenant_academy_profile_id => v_slot.academy_profile_id,
        p_idempotency_subject       => 'cancel:' || r.id::text,
        p_related_booking_ids       => ARRAY[r.id],
        p_payload                   => jsonb_build_object('subject', v_subject, 'html', v_html),
        p_public_summary            => jsonb_build_object('event_type', 'booking_cancelled_player')
      );
      v_count := v_count + 1;
    END LOOP;
  END IF;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.enqueue_booking_notification(uuid[], text) IS
  'PR 10b: actor-callable enqueue for booking notifications that used to go through the legacy '
  'send-email path. Takes booking ids + an intent ONLY; recipients, tenant refs and copy are '
  'derived server-side. Validates the actor (player for request/manual, slot owner for '
  'cancellation). Idempotency subjects are prefixed per kind so a manual confirmation can never '
  'collide with the paid path booking_confirmed_player, which keys on the Mollie payment id.';

-- This project runs ALTER DEFAULT PRIVILEGES granting EXECUTE on new functions to anon and
-- authenticated, and a bare REVOKE FROM PUBLIC does NOT undo it. Revoke explicitly, then grant
-- back only to authenticated: this RPC is deliberately reachable by a logged-in actor (that is
-- the point), but never by anon.
REVOKE ALL ON FUNCTION public.enqueue_booking_notification(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_booking_notification(uuid[], text) TO authenticated, service_role;
