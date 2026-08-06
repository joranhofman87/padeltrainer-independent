-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- A1-A7 F1, CLOSED PROPERLY — an immutable record of WHEN A BOOKING ACTUALLY CHANGED.
--
-- The activation floor needs the instant an event happened. Two candidates were tried and both
-- are wrong, for opposite reasons:
--
--   * `bookings.created_at` is immutable but answers a different question. A cancellation of a
--     three-week-old booking dated three weeks back falls under the event-age floor and the
--     message — the one a player most needs — is never sent.
--   * `bookings.updated_at` answers the right question and is not immutable. The BEFORE UPDATE
--     trigger (20260115210247:118) refreshes it on EVERY column write, so editing a note, writing
--     a `mollie_payment_id`, rewriting a split share, or anonymising a departed player's history
--     re-dates a year-old cancellation into the sendable window. That is precisely the laundering
--     the occurrence column exists to prevent, arriving through the value instead of an UPDATE.
--
-- So the transition gets its own row. `booking_lifecycle_events` is append-only and captured by a
-- trigger rather than by ~15 call sites across UI, lib and edge functions — the same argument
-- `invoice_status_history` (20260616100000) already made for invoices, and for the same reason:
-- per-call-site stamping misses one, and the one it misses is silent.
--
-- WHAT THE BACKFILL DELIBERATELY DOES NOT DO. It writes a `created` event from `created_at` and a
-- `paid` event from `paid_at` where that is set. It does NOT synthesise `cancelled` or `confirmed`
-- events from `updated_at`, because that value is exactly the lie being removed. Historical
-- transitions therefore have no ledger row, the producers fail closed on them, and those messages
-- are unsendable. That is the intended no-backlog outcome and it is a behaviour change to a live
-- path: re-running a cancellation notification for a booking cancelled before this migration will
-- be REFUSED rather than sent. NOTIFICATION_OPERATIONS.md records it beside the other refusals.
--
-- WRITE COST. The trigger is `AFTER UPDATE OF status, payment_status` with an IS DISTINCT FROM
-- guard, not a bare AFTER UPDATE: bulk cycle operations touch hundreds of booking rows without
-- changing either column, and those must stay single-write.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.booking_lifecycle_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  -- what changed. Derived from the transition, never from the caller.
  event_type          text NOT NULL CHECK (event_type IN
                        ('created', 'confirmed', 'cancelled', 'paid', 'rejected', 'completed', 'status_changed', 'payment_changed')),
  from_status         text,
  to_status           text,
  from_payment_status text,
  to_payment_status   text,
  -- THE CLOCK. Set once, never updatable, never in the future.
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  actor_user_id       uuid,                       -- auth.uid(); NULL = service_role / system / trigger
  seq                 bigint GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT chk_booking_lifecycle_not_future CHECK (occurred_at <= now() + interval '1 minute')
);

COMMENT ON TABLE public.booking_lifecycle_events IS
  'Append-only record of booking status / payment_status transitions, captured by trigger. occurred_at is the authoritative instant a transition happened and is the ONLY clock the notification activation floor may use for a booking transition: bookings.created_at answers a different question and bookings.updated_at is refreshed by every unrelated write, which re-dates old events into the sendable window.';

CREATE INDEX idx_booking_lifecycle_lookup
  ON public.booking_lifecycle_events (booking_id, event_type, occurred_at DESC);

-- ── append-only, owner-effectively ──────────────────────────────────────────────────────────
-- A definer function and a future migration both run as the owner, so this cannot rest on the
-- discipline of whoever writes the next one. Moving an occurrence forward is how history is
-- laundered; deleting one is how it disappears.
CREATE OR REPLACE FUNCTION public.booking_lifecycle_events_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'booking_lifecycle_events is append-only: moving an occurrence forward is exactly how a historical event would be laundered into the sendable window';
  END IF;
  RAISE EXCEPTION 'booking_lifecycle_events is append-only: a transition that happened cannot be un-recorded';
END $$;

CREATE TRIGGER trg_booking_lifecycle_events_guard
  BEFORE UPDATE OR DELETE ON public.booking_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.booking_lifecycle_events_guard();
CREATE TRIGGER trg_booking_lifecycle_events_no_truncate
  BEFORE TRUNCATE ON public.booking_lifecycle_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.booking_lifecycle_events_guard();

-- ACLs: the ledger carries per-booking history and an actor. Definer readers only — a permissive
-- policy would hand a player another tenant's booking timeline.
ALTER TABLE public.booking_lifecycle_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_lifecycle_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.booking_lifecycle_events TO service_role;

-- ── the capture ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_booking_lifecycle_event() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid;
BEGIN
  BEGIN
    v_actor := auth.uid();
  EXCEPTION WHEN OTHERS THEN
    v_actor := NULL;                       -- no JWT (cron, psql, service paths): system actor
  END;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.booking_lifecycle_events
      (booking_id, event_type, to_status, to_payment_status, occurred_at, actor_user_id)
    VALUES (NEW.id, 'created', NEW.status, NEW.payment_status, coalesce(NEW.created_at, now()), v_actor);
    RETURN NULL;
  END IF;

  -- STATUS: one row per real change. `IS DISTINCT FROM` rather than `<>` so NULL transitions are
  -- captured too, and nothing at all is written when the value did not move — a no-op re-cancel
  -- must not manufacture a fresh occurrence.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.booking_lifecycle_events
      (booking_id, event_type, from_status, to_status, occurred_at, actor_user_id)
    VALUES (NEW.id,
            CASE NEW.status
              WHEN 'confirmed' THEN 'confirmed'
              WHEN 'cancelled' THEN 'cancelled'
              WHEN 'cancelled_swap' THEN 'cancelled'
              WHEN 'rejected'  THEN 'rejected'
              WHEN 'completed' THEN 'completed'
              ELSE 'status_changed'
            END,
            OLD.status, NEW.status, now(), v_actor);
  END IF;

  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
    INSERT INTO public.booking_lifecycle_events
      (booking_id, event_type, from_payment_status, to_payment_status, occurred_at, actor_user_id)
    VALUES (NEW.id,
            CASE WHEN NEW.payment_status = 'paid' THEN 'paid' ELSE 'payment_changed' END,
            OLD.payment_status, NEW.payment_status, now(), v_actor);
  END IF;

  RETURN NULL;
END $$;

-- `OF status, payment_status` is load-bearing, not an optimisation: a 52-session cycle times N
-- players is hundreds of booking writes that touch neither column, and a bare AFTER UPDATE would
-- double every one of them.
CREATE TRIGGER trg_record_booking_lifecycle_event
  AFTER INSERT OR UPDATE OF status, payment_status ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.record_booking_lifecycle_event();

-- ── the backfill, deliberately partial ──────────────────────────────────────────────────────
INSERT INTO public.booking_lifecycle_events (booking_id, event_type, to_status, to_payment_status, occurred_at)
SELECT b.id, 'created', b.status, b.payment_status, b.created_at FROM public.bookings b;

-- `paid` only where the stamp exists. It is incomplete (finalize-proposals writes payment_status
-- without it) and it is mutable (an invoice revert sets it back to NULL), so it is used here as
-- evidence of a past payment and never again afterwards — from here the trigger owns the clock.
INSERT INTO public.booking_lifecycle_events (booking_id, event_type, to_payment_status, occurred_at)
SELECT b.id, 'paid', b.payment_status, b.paid_at
  FROM public.bookings b
 WHERE b.paid_at IS NOT NULL AND b.paid_at <= now();

-- ── the one reader every producer shares ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.booking_transition_occurred_at(
  p_booking_ids uuid[],
  p_event_type text
) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT max(e.occurred_at)
    FROM public.booking_lifecycle_events e
   WHERE e.booking_id = ANY (p_booking_ids)
     AND e.event_type = p_event_type;
$$;
COMMENT ON FUNCTION public.booking_transition_occurred_at(uuid[], text) IS
  'When the named transition last happened across this booking set, from the append-only lifecycle ledger — NULL when it never did. The single clock both the SQL and edge producers measure the activation floor against. NULL means "do not enqueue": a message we cannot date is one we do not send.';
REVOKE ALL ON FUNCTION public.booking_transition_occurred_at(uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.booking_transition_occurred_at(uuid[], text) TO authenticated, service_role;

-- The transition DISCRIMINATOR, so a genuine second transition of the same booking set is a
-- second message rather than a suppressed duplicate. Today's idempotency subject is
-- (kind, booking set) alone, so cancel -> re-add -> cancel is silently swallowed. Keyed on the
-- ledger's monotonic `seq`, a webhook redelivery reads the same row and collapses as it should.
CREATE OR REPLACE FUNCTION public.booking_transition_seq(
  p_booking_ids uuid[],
  p_event_type text
) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT max(e.seq)
    FROM public.booking_lifecycle_events e
   WHERE e.booking_id = ANY (p_booking_ids)
     AND e.event_type = p_event_type;
$$;
COMMENT ON FUNCTION public.booking_transition_seq(uuid[], text) IS
  'The ledger sequence of the transition a message reports — the discriminator that makes a genuine SECOND cancellation of the same bookings a second notification rather than a duplicate suppressed by an idempotency key that only knew (kind, booking set).';
REVOKE ALL ON FUNCTION public.booking_transition_seq(uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.booking_transition_seq(uuid[], text) TO authenticated, service_role;

-- ── the SQL producer, re-lifted onto the ledger ─────────────────────────────────────────────
-- FORWARD REFERENCE, deliberately: this body calls `booking_transition_event`, which the next
-- migration (20261110100000) creates. plpgsql resolves function calls at execution time, not at
-- CREATE time, and nothing invokes this producer during a migration run — the first real call
-- happens after the whole chain has applied. Stated rather than left to be discovered.
-- Lifted from its newest definition (20261106100000) with three changes and nothing else:
--   * both arms read the ledger instead of bookings.created_at / bookings.updated_at;
--   * the per-recipient idempotency subject gains the transition's ledger `seq`, so a genuine
--     SECOND cancellation of the same booking set is a second message rather than a duplicate
--     silently suppressed by a key that only knew (kind, booking set);
--   * `v_seq` / `v_evt` locals to carry them.
--
-- DEPLOY ORDERING, because the subject format changes: any outbox row already pending under the
-- old subject keeps its old key, so a re-enqueue after this migration could produce a second row
-- for the same transition. The instant queue drains in minutes and the digest path is inert, so
-- the window is small — but it is not zero. Drain or dispose the pending queue before applying
-- this (NOTIFICATION_OPERATIONS.md records the step).

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
  v_setkey   text;
  v_evt      text;
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

    -- from the LEDGER, not from bookings.created_at: one clock for every producer, and the
    -- ledger's 'created' row is written by the same trigger that records every later transition.
    SELECT e.occurred_at, e.set_key INTO v_occurred, v_setkey
      FROM public.booking_transition_event(v_ids, 'created') e;
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

      -- THE TRANSITION ITSELF, from the append-only ledger. Not created_at (which buried a
      -- current cancellation under the event-age floor and lost the message) and not updated_at
      -- (which any unrelated write moves, re-dating a year-old cancellation into the window).
      v_evt      := CASE WHEN p_kind = 'confirmation_player' THEN 'confirmed' ELSE 'cancelled' END;
      SELECT e.occurred_at, e.set_key INTO v_occurred, v_setkey
        FROM public.booking_transition_event(r.ids, v_evt) e;
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
        p_idempotency_subject       => v_key || ':' || md5(array_to_string(r.ids, ',')) || ':' || coalesce(v_setkey, 'none'),
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
