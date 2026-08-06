-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- A1-A7 REVIEW ROUND 2 (P1) — the occurrence must be the TRANSITION, not the booking's birthday.
--
-- The occurrence-boundary correction dated every booking-related message from the booking's
-- `created_at`. That is truthful for "a booking was requested" and false for everything that
-- happens to a booking afterwards. A cancellation of a booking made three weeks ago is an event
-- that happened NOW; dating it three weeks back put it under the event-age floor and made the
-- cancellation email — the one a player most needs — permanently unsendable.
--
-- Trading a backlog risk for silent delivery loss is not a fix. So:
--
--   booking_request_staff      → min(created_at)   the request IS the creation
--   booking_confirmed_player   → max(updated_at)   the confirmation is a transition
--   booking_cancelled_player   → max(updated_at)   so is the cancellation
--
-- `max` for transitions because that is the change being reported; `min` for creation because the
-- floor should be conservative about a message covering several bookings. A webhook redelivered
-- days later still dates to the transition, which is the entire reason the column exists.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.enqueue_booking_notification(
  p_booking_ids uuid[],
  p_kind        text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_occurred timestamptz;
  v_actor     uuid := auth.uid();
  v_ids       uuid[];
  v_n         int;
  v_scopes    int;
  v_trn_count int;
  v_recips    int;
  v_maxper    int;
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
  v_guest_email text;
  v_price     numeric;
  v_title     text;
  v_contact   text;
  r           record;
  -- Bounds on caller-controlled work. Cancellation receives one booking ROW per session per
  -- player, so a 52-session cycle with several players is legitimately hundreds of rows — the
  -- old flat "60 bookings" cap mistook rows for sessions and rejected real cancellations.
  -- These are intent-aware: a hard total backstop, plus per-recipient and recipient-count
  -- caps, all comfortably above a real season (52) while keeping abuse bounded.
  MAX_TOTAL_ROWS            constant int := 2000;
  MAX_RECIPIENTS            constant int := 500;
  MAX_SESSIONS_PER_RECIPIENT constant int := 200;
  -- Guest-first canonical recipient key (FAM-02): a booking that carries a guest_player_id
  -- belongs to the GUEST regardless of any player_id, so it groups and addresses as the guest.
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'enqueue_booking_notification: no authenticated actor';
  END IF;

  IF coalesce(p_kind, '') NOT IN ('request_staff', 'confirmation_player', 'cancelled_player') THEN
    RAISE EXCEPTION 'enqueue_booking_notification: unknown kind %', coalesce(p_kind, '<null>');
  END IF;

  -- CANONICAL SET: distinct + sorted, so argument order/duplicates cannot change the outcome.
  SELECT array_agg(DISTINCT b ORDER BY b) INTO v_ids
    FROM unnest(coalesce(p_booking_ids, ARRAY[]::uuid[])) AS b
   WHERE b IS NOT NULL;
  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;
  v_n := array_length(v_ids, 1);

  -- Absolute backstop on the caller-controlled array size.
  IF v_n > MAX_TOTAL_ROWS THEN
    RAISE EXCEPTION 'enqueue_booking_notification: too many bookings in one call (% > %)', v_n, MAX_TOTAL_ROWS;
  END IF;

  -- EVERY id must exist — never notify about the subset that happens to resolve.
  IF (SELECT count(*) FROM public.bookings WHERE id = ANY(v_ids)) <> v_n THEN
    RAISE EXCEPTION 'enqueue_booking_notification: unknown booking id in set';
  END IF;

  -- TENANT = ACADEMY-FIRST. Cycle slots can move between trainers WITHIN one academy, so a
  -- multi-trainer set inside a single academy is ONE tenant (the academy) — an academy manager
  -- may act across its trainers. An INDEPENDENT set (no academy) must resolve to a single
  -- trainer. A set spanning academies, or academy + independent, has no coherent tenant.
  SELECT count(DISTINCT coalesce(s.academy_profile_id, '00000000-0000-0000-0000-000000000000'::uuid)),
         (array_agg(DISTINCT s.academy_profile_id))[1],
         count(DISTINCT s.trainer_id),
         (array_agg(DISTINCT s.trainer_id))[1]
    INTO v_scopes, v_academy, v_trn_count, v_trainer
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
   WHERE b.id = ANY(v_ids);
  IF v_scopes <> 1 THEN
    RAISE EXCEPTION 'enqueue_booking_notification: booking set spans multiple academy scopes';
  END IF;
  IF v_academy IS NULL AND v_trn_count <> 1 THEN
    RAISE EXCEPTION 'enqueue_booking_notification: independent slots span multiple trainers';
  END IF;
  -- Effective tenant trainer: the single trainer if the set has exactly one, else NULL (a
  -- multi-trainer academy cycle) — so no single trainer is named falsely in the copy.
  IF v_trn_count <> 1 THEN v_trainer := NULL; END IF;

  -- request_staff addresses ONE trainer; there is no coherent approver across several.
  IF p_kind = 'request_staff' AND v_trainer IS NULL THEN
    RAISE EXCEPTION 'enqueue_booking_notification: request_staff needs a single trainer';
  END IF;

  -- INTENT-AWARE BOUNDS. request_staff/confirmation address one recipient (v_n sessions);
  -- cancellation fans out to many. Prove-a-52x2-cancellation-succeeds sizing.
  IF p_kind = 'request_staff' THEN
    IF v_n > MAX_SESSIONS_PER_RECIPIENT THEN
      RAISE EXCEPTION 'enqueue_booking_notification: too many sessions for one request (% > %)', v_n, MAX_SESSIONS_PER_RECIPIENT;
    END IF;
  ELSE
    SELECT count(*), coalesce(max(cnt), 0) INTO v_recips, v_maxper FROM (
      SELECT CASE WHEN b.guest_player_id IS NOT NULL THEN 'g:' || b.guest_player_id::text
                  ELSE 'p:' || coalesce(pr.user_id::text, 'none') END AS rkey,
             count(*) AS cnt
        FROM public.bookings b
        LEFT JOIN public.profiles pr ON pr.id = b.player_id
       WHERE b.id = ANY(v_ids)
       GROUP BY 1
    ) g;
    IF v_recips > MAX_RECIPIENTS THEN
      RAISE EXCEPTION 'enqueue_booking_notification: too many recipients (% > %)', v_recips, MAX_RECIPIENTS;
    END IF;
    IF v_maxper > MAX_SESSIONS_PER_RECIPIENT THEN
      RAISE EXCEPTION 'enqueue_booking_notification: too many sessions for one recipient (% > %)', v_maxper, MAX_SESSIONS_PER_RECIPIENT;
    END IF;
  END IF;

  -- Content the LEGACY templates carried, derived here rather than accepted from the caller.
  SELECT sum(coalesce(b.payment_amount, s.price_per_session, 0)),
         max(nullif(btrim(coalesce(s.cyclus_name, '')), ''))
    INTO v_price, v_title
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
   WHERE b.id = ANY(v_ids);

  -- The trainer name is NULL for a multi-trainer academy cycle (v_trainer NULL), so the copy
  -- below degrades to a generic "je trainer" rather than naming one arbitrary trainer.
  SELECT tp.user_id INTO v_trn_user FROM public.trainer_profiles tp WHERE tp.id = v_trainer;
  SELECT pr.full_name INTO v_trn_name FROM public.profiles pr WHERE pr.user_id = v_trn_user;

  -- Ownership. An individual trainer may act only when the set is theirs (single trainer, and
  -- the actor owns it); an academy manager may act across the academy's trainers. Three
  -- redundant fail-closed layers (IS NOT NULL guards + IS TRUE + IS NOT TRUE at the use site)
  -- keep a NULL comparison from sailing through as "not rejected".
  v_owner := (
    (v_trainer IS NOT NULL AND v_trn_user IS NOT NULL AND v_actor = v_trn_user)
    OR (v_academy IS NOT NULL AND public.is_academy_manager(v_actor, v_academy) IS TRUE)
  ) IS TRUE;

  -- ── AUTH MATRIX + STATE VALIDATION, over the WHOLE set ────────────────────────────────
  IF p_kind = 'request_staff' THEN
    -- PURE-PROFILE ownership (FAM-02): the `b.guest_player_id IS NULL` guard is load-bearing.
    -- A DUAL-KEY booking belongs to the GUEST person, not the profile, so a parent/profile
    -- account whose user_id matches must NOT be able to request staff mail for a guest's
    -- booking. Without the guard, `pr.user_id = v_actor` alone would grant it.
    IF EXISTS (
      SELECT 1 FROM public.bookings b
      LEFT JOIN public.profiles pr ON pr.id = b.player_id
      WHERE b.id = ANY(v_ids)
        AND ((b.guest_player_id IS NULL AND pr.user_id IS NOT NULL AND pr.user_id = v_actor) IS NOT TRUE)
    ) THEN
      RAISE EXCEPTION 'enqueue_booking_notification: actor is not the player on every booking';
    END IF;
    IF EXISTS (SELECT 1 FROM public.bookings WHERE id = ANY(v_ids) AND status IS DISTINCT FROM 'pending_approval') THEN
      RAISE EXCEPTION 'enqueue_booking_notification: request_staff needs pending_approval bookings';
    END IF;

  ELSIF p_kind = 'confirmation_player' THEN
    -- Same PURE-PROFILE guard: a profile account cannot self-confirm a guest's dual-key
    -- booking. Either the slot owner (v_owner) or the player on every PURE-PROFILE booking.
    IF v_owner IS NOT TRUE AND EXISTS (
      SELECT 1 FROM public.bookings b
      LEFT JOIN public.profiles pr ON pr.id = b.player_id
      WHERE b.id = ANY(v_ids)
        AND ((b.guest_player_id IS NULL AND pr.user_id IS NOT NULL AND pr.user_id = v_actor) IS NOT TRUE)
    ) THEN
      RAISE EXCEPTION 'enqueue_booking_notification: actor is neither the player nor the slot owner';
    END IF;
    -- ONE recipient, by the GUEST-FIRST canonical key: a guest-only row and a dual-key row for
    -- the SAME guest are one recipient, not two (the old DISTINCT (player_id, guest_player_id)
    -- counted them separately and rejected the confirmation).
    IF (SELECT count(DISTINCT CASE WHEN b.guest_player_id IS NOT NULL THEN 'g:' || b.guest_player_id::text
                                   ELSE 'p:' || coalesce(pr.user_id::text, 'none') END)
          FROM public.bookings b
          LEFT JOIN public.profiles pr ON pr.id = b.player_id
         WHERE b.id = ANY(v_ids)) <> 1 THEN
      RAISE EXCEPTION 'enqueue_booking_notification: confirmation set covers multiple recipients';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.bookings
       WHERE id = ANY(v_ids)
         AND (status IS DISTINCT FROM 'confirmed' OR payment_status = 'paid')
    ) THEN
      RAISE EXCEPTION 'enqueue_booking_notification: confirmation needs unpaid CONFIRMED bookings';
    END IF;

  ELSE  -- cancelled_player
    IF v_owner IS NOT TRUE THEN
      RAISE EXCEPTION 'enqueue_booking_notification: actor does not own this slot';
    END IF;
    IF EXISTS (SELECT 1 FROM public.bookings WHERE id = ANY(v_ids) AND status NOT IN ('cancelled', 'cancelled_swap')) THEN
      RAISE EXCEPTION 'enqueue_booking_notification: cancelled_player needs cancelled bookings';
    END IF;
  END IF;

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

    SELECT public.notification_html_escape(coalesce(pr.full_name, gp.full_name, 'Een speler')),
           public.notification_html_escape(coalesce(pr.email, gp.email, ''))
      INTO v_subject, v_contact
      FROM public.bookings b
      LEFT JOIN public.profiles pr ON pr.id = b.player_id
      LEFT JOIN public.guest_players gp ON gp.id = b.guest_player_id
     WHERE b.id = v_ids[1];

    v_html := '<div style="font-family:sans-serif"><h2>Nieuwe boekingsaanvraag</h2><p>Hoi '
      || public.notification_html_escape(v_trn_name) || ',</p><p>' || v_subject
      || ' heeft een aanvraag gedaan'
      || CASE WHEN v_title IS NOT NULL THEN ' voor <strong>' || public.notification_html_escape(v_title) || '</strong>' ELSE '' END
      || ':</p><table>' || coalesce(v_rows, '') || '</table>'
      || CASE WHEN v_contact <> '' THEN '<p>Contact: <a href="mailto:' || v_contact || '">' || v_contact || '</a></p>' ELSE '' END
      || CASE WHEN coalesce(v_price, 0) > 0 THEN '<p>Bedrag: &euro;' || to_char(v_price, 'FM999999990.00') || '</p>' ELSE '' END
      || '<p><a href="https://padeltrainer.ai/app/trainer/agenda">Bekijk en beoordeel de aanvraag</a></p></div>';

    SELECT min(b.created_at) INTO v_occurred FROM public.bookings b WHERE b.id = ANY (v_ids);
    IF v_occurred IS NULL THEN
      RAISE EXCEPTION 'enqueue_booking_notification: no booking in % — refusing to enqueue a message we cannot date', v_ids;
    END IF;
    SELECT count(*) INTO v_count FROM public.enqueue_notification(
      p_event_key                 => 'booking_request_staff',
      p_occurred_at               => v_occurred,
      p_recipient_user_id         => v_trn_user,
      p_tenant_trainer_id         => v_trainer,
      p_tenant_academy_profile_id => v_academy,
      p_idempotency_subject       => v_key,
      p_related_booking_ids       => v_ids,
      p_payload                   => jsonb_build_object('subject', 'Nieuwe boekingsaanvraag', 'html', v_html),
      p_public_summary            => jsonb_build_object('event_type', 'booking_request_staff', 'sessions', array_length(v_ids, 1))
    );

  ELSE
    -- confirmation_player and cancelled_player fan out PER RECIPIENT, each seeing ONLY their
    -- own sessions, grouped by the GUEST-FIRST canonical key. ruser/rguest are XOR by
    -- construction (uid is NULL for a guest row, gid NULL for a player row), so the resolver
    -- never receives both and can never prefer a registered profile over the intended guest.
    FOR r IN
      SELECT d.uid AS ruser, d.gid AS rguest, d.rname,
             array_agg(d.id ORDER BY d.id) AS ids,
             string_agg(
               '<tr><td style="padding:4px 12px 4px 0">' || to_char(d.start_time AT TIME ZONE 'Europe/Amsterdam', 'DD-MM-YYYY')
               || '</td><td style="padding:4px 12px 4px 0">' || to_char(d.start_time AT TIME ZONE 'Europe/Amsterdam', 'HH24:MI')
               || '–' || to_char(d.end_time AT TIME ZONE 'Europe/Amsterdam', 'HH24:MI')
               || '</td><td style="padding:4px 0">' || public.notification_html_escape(d.loc) || '</td></tr>',
               '' ORDER BY d.start_time) AS rows
        FROM (
          SELECT b.id, s.start_time, s.end_time, l.name AS loc,
                 b.guest_player_id AS gid,
                 CASE WHEN b.guest_player_id IS NULL THEN pr.user_id ELSE NULL END AS uid,
                 CASE WHEN b.guest_player_id IS NOT NULL THEN coalesce(gp.full_name, '')
                      ELSE coalesce(pr.full_name, '') END AS rname
            FROM public.bookings b
            JOIN public.availability_slots s ON s.id = b.slot_id
            LEFT JOIN public.locations l ON l.id = s.location_id
            LEFT JOIN public.profiles pr ON pr.id = b.player_id
            LEFT JOIN public.guest_players gp ON gp.id = b.guest_player_id
           WHERE b.id = ANY(v_ids)
        ) d
       GROUP BY d.gid, d.uid, d.rname
    LOOP
      CONTINUE WHEN r.ruser IS NULL AND r.rguest IS NULL;   -- nobody to address

      -- A guest has no account for the resolver to fall back on, so make them deliverable
      -- FIRST. Recipient-discovery fails LOUD (PR 10a): an error would otherwise promote a
      -- stale raw address into the tenant contact. A successful no-row/no-email answer uses
      -- the designed guest-record fallback.
      IF r.rguest IS NOT NULL THEN
        SELECT i.email INTO v_guest_email
          FROM public.get_invoice_recipient_identity(NULL, r.rguest, v_academy) AS i;
        IF coalesce(btrim(v_guest_email), '') = '' THEN
          SELECT gp.email INTO v_guest_email FROM public.guest_players gp WHERE gp.id = r.rguest;
        END IF;
        PERFORM public.ensure_guest_email_contact(
          r.rguest, v_guest_email, v_academy, v_trainer, 'staff_booking');
      END IF;

      IF p_kind = 'confirmation_player' THEN
        v_subject := 'Je boeking is bevestigd';
        v_html := '<div style="font-family:sans-serif"><h2>Je boeking is bevestigd</h2><p>Hoi '
          || public.notification_html_escape(r.rname) || ',</p><p>Je sessie(s)'
          || CASE WHEN v_title IS NOT NULL THEN ' voor <strong>' || public.notification_html_escape(v_title) || '</strong>' ELSE '' END
          || ' staan klaar. Betaling regel je met '
          || public.notification_html_escape(coalesce(v_trn_name, 'je trainer'))
          || '.</p><table>' || coalesce(r.rows, '') || '</table>'
          || CASE WHEN coalesce(v_price, 0) > 0 THEN '<p>Bedrag: &euro;' || to_char(v_price, 'FM999999990.00') || '</p>' ELSE '' END
          || '</div>';
      ELSE
        v_subject := 'Je sessie is geannuleerd';
        v_html := '<div style="font-family:sans-serif"><h2>Je sessie is geannuleerd</h2><p>'
          || public.notification_html_escape(coalesce(v_trn_name, 'Je trainer'))
          || ' heeft de volgende sessie(s) geannuleerd:</p><table>' || coalesce(r.rows, '')
          || '</table><p>Neem contact op met je trainer voor een alternatief.</p></div>';
      END IF;

      -- THE TRANSITION, not the creation: this arm sends confirmations and cancellations, which
      -- are things that happen TO an existing booking. Dating them from created_at buried a
      -- current cancellation under the event-age floor and lost the message entirely.
      SELECT max(b.updated_at) INTO v_occurred FROM public.bookings b WHERE b.id = ANY (r.ids);
      IF v_occurred IS NULL THEN
        RAISE EXCEPTION 'enqueue_booking_notification: no booking in % — refusing to enqueue a message we cannot date', r.ids;
      END IF;
      SELECT v_count + count(*) INTO v_count FROM public.enqueue_notification(
        p_occurred_at               => v_occurred,
        p_event_key                 => CASE WHEN p_kind = 'confirmation_player'
                                            THEN 'booking_confirmed_player' ELSE 'booking_cancelled_player' END,
        p_recipient_user_id         => r.ruser,
        p_recipient_guest_player_id => r.rguest,
        p_tenant_trainer_id         => v_trainer,
        p_tenant_academy_profile_id => v_academy,
        p_idempotency_subject       => v_key || ':' || md5(array_to_string(r.ids, ',')),
        p_related_booking_ids       => r.ids,
        p_payload                   => jsonb_build_object('subject', v_subject, 'html', v_html),
        p_public_summary            => jsonb_build_object(
                                         'event_type', CASE WHEN p_kind = 'confirmation_player'
                                           THEN 'booking_confirmed_player' ELSE 'booking_cancelled_player' END,
                                         'sessions', array_length(r.ids, 1))
      );
    END LOOP;
  END IF;

  RETURN v_count;
END;
$$;
