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


-- GUEST DELIVERABILITY.
--
-- The resolver's email branch only falls back to persons.email for ACCOUNT HOLDERS. A
-- guest-only person has no account, so without a tenant-scoped contact row it resolves to
-- no_email_contact: a required-delivery confirmation becomes a visible 'skipped' row, and a
-- non-required cancellation produces NO row at all — silently. The paid path already provisions
-- this via ensure_guest_email_contact; this RPC must too, or staff-created guest bookings and
-- guest cancellations simply do not arrive.
--
-- The existing helper hardcodes consent_source='paid_booking', which would MISLABEL a
-- staff-created booking's provenance. Provenance on a consent record is not cosmetic — it is
-- the evidence for why we hold the address — so widen the helper with an explicit source
-- rather than borrowing a wrong label. The 4-arg form is dropped and replaced by a 5-arg form
-- defaulting to 'paid_booking', so existing callers (booking-confirmation-email.ts passes four
-- named args) keep resolving unchanged.
DROP FUNCTION IF EXISTS public.ensure_guest_email_contact(uuid, text, uuid, uuid);

CREATE OR REPLACE FUNCTION public.ensure_guest_email_contact(
  p_guest_player_id    uuid,
  p_email              text,
  p_academy_profile_id uuid DEFAULT NULL,
  p_trainer_id         uuid DEFAULT NULL,
  p_source             text DEFAULT 'paid_booking'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_email         text := lower(btrim(coalesce(p_email, '')));
  v_scope_academy uuid;
  v_scope_trainer uuid;
  v_id            uuid;
BEGIN
  -- No current authoritative email → FAIL CLOSED. Returning early WITHOUT touching an existing
  -- contact used to leave a previously-stored address selectable, and the resolver would deliver
  -- a confirmation to that STALE address. Revoke any live email contact for this guest instead:
  -- the resolver requires revoked_at IS NULL, so a required confirmation now resolves to a
  -- visible no_email_contact skip rather than a wrong-address send.
  IF p_guest_player_id IS NOT NULL AND (v_email = '' OR position('@' IN v_email) < 2) THEN
    UPDATE public.notification_contacts
       SET revoked_at = now(), updated_at = now()
     WHERE channel = 'email' AND guest_player_id = p_guest_player_id AND revoked_at IS NULL;
  END IF;
  IF p_guest_player_id IS NULL OR v_email = '' OR position('@' IN v_email) < 2 THEN
    RETURN NULL;
  END IF;

  IF p_academy_profile_id IS NOT NULL THEN
    v_scope_academy := p_academy_profile_id;
    v_scope_trainer := NULL;
  ELSIF p_trainer_id IS NOT NULL THEN
    v_scope_academy := NULL;
    v_scope_trainer := p_trainer_id;
  ELSE
    RETURN NULL;  -- no tenant provenance → cannot form a coherent tenant-scoped contact
  END IF;

  INSERT INTO public.notification_contacts (
    guest_player_id, person_id, channel,
    destination_normalized, destination_redacted,
    consent_status, consent_scope,
    consent_academy_profile_id, consent_trainer_id,
    consent_source, consent_at
  ) VALUES (
    p_guest_player_id, NULL, 'email',
    v_email, public.notification_redact_destination(v_email, 'email'),
    'unknown', 'tenant',
    v_scope_academy, v_scope_trainer,
    coalesce(nullif(btrim(p_source), ''), 'paid_booking'), now()
  )
  ON CONFLICT (channel, guest_player_id) WHERE guest_player_id IS NOT NULL
  DO UPDATE SET
    destination_normalized     = excluded.destination_normalized,
    destination_redacted       = excluded.destination_redacted,
    consent_academy_profile_id = excluded.consent_academy_profile_id,
    consent_trainer_id         = excluded.consent_trainer_id,
    -- Provenance (source + at) is the evidence for WHY and WHEN we captured THIS address, so it
    -- is refreshed on address change, reactivation (was revoked), OR effective tenant-scope
    -- change — an unchanged, still-active re-run keeps the
    -- original provenance and does not bump consent_at. A fresh valid address also UN-REVOKES a
    -- contact that a prior email-removal had revoked (the guest is reachable again).
    -- Provenance is a FRESH CAPTURE when any of: the address changed, the contact had been
    -- REVOKED (reactivation is a new lifecycle even at the same address), or the effective
    -- tenant scope changed. An unchanged, still-active re-run is a no-op that keeps the
    -- original source + timestamp.
    consent_source = CASE WHEN public.notification_contacts.destination_normalized IS DISTINCT FROM excluded.destination_normalized
                            OR public.notification_contacts.revoked_at IS NOT NULL
                            OR public.notification_contacts.consent_academy_profile_id IS DISTINCT FROM excluded.consent_academy_profile_id
                            OR public.notification_contacts.consent_trainer_id IS DISTINCT FROM excluded.consent_trainer_id
                          THEN excluded.consent_source
                          ELSE public.notification_contacts.consent_source END,
    consent_at     = CASE WHEN public.notification_contacts.destination_normalized IS DISTINCT FROM excluded.destination_normalized
                            OR public.notification_contacts.revoked_at IS NOT NULL
                            OR public.notification_contacts.consent_academy_profile_id IS DISTINCT FROM excluded.consent_academy_profile_id
                            OR public.notification_contacts.consent_trainer_id IS DISTINCT FROM excluded.consent_trainer_id
                          THEN now()
                          ELSE public.notification_contacts.consent_at END,
    revoked_at                 = NULL,
    updated_at                 = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

COMMENT ON FUNCTION public.ensure_guest_email_contact(uuid, text, uuid, uuid, text) IS
  'Notification v2: upsert a tenant-scoped email contact for a guest so guest notifications are '
  'deliverable via the outbox. consent_scope=tenant, consent_status=unknown (transactional, not '
  'a marketing opt-in). p_source records PROVENANCE — paid_booking for the Mollie path, '
  'staff_booking for staff-created bookings — because a consent record''s source is the evidence '
  'for why the address is held. Idempotent per guest_player. service_role only.';

REVOKE ALL ON FUNCTION public.ensure_guest_email_contact(uuid, text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_guest_email_contact(uuid, text, uuid, uuid, text) TO service_role;

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
    IF v_owner IS NOT TRUE AND EXISTS (
      SELECT 1 FROM public.bookings b
      LEFT JOIN public.profiles pr ON pr.id = b.player_id
      WHERE b.id = ANY(v_ids)
        AND ((pr.user_id IS NOT NULL AND pr.user_id = v_actor) IS NOT TRUE)
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

    SELECT count(*) INTO v_count FROM public.enqueue_notification(
      p_event_key                 => 'booking_request_staff',
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

      SELECT v_count + count(*) INTO v_count FROM public.enqueue_notification(
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
