-- PR 10b: open_slots_player — the last legacy send-email route (notify-followers) moves to v2.
--
-- notify-followers announced newly published availability to a trainer's followers. It was the
-- one remaining path that (a) still called the legacy sender, (b) consulted a v1 preference
-- column that DOES NOT EXIST (email_new_availability) while discarding the read error, so its
-- global opt-out was inert, and (c) fanned out to every follower inside a single edge request
-- with a claim-before-send table that could strand a recipient permanently on a crash.
--
-- This replaces all three:
--   * ONE catalog event, open_slots_player. Both former "types" (new_availability and
--     slot_reopened) expressed the same preference; slot_reopened has NO live producer, so it
--     is not created as a separate capability.
--   * a DURABLE, RESUMABLE fan-out job instead of a long request loop, with a per-job dead
--     letter so one poison job cannot starve the queue.
--   * frequency-aware routing that PRESERVES the legacy digest: a daily/weekly follower is
--     routed to the existing notification_queue (which send-digest-emails already aggregates
--     into ONE email with a count), an instant follower to the outbox. Setting the event to
--     'weekly' alone did NOT digest — the resolver only postpones each independent outbox row
--     and the email worker sends every row separately, so multiple availability batches became
--     several simultaneous emails instead of one digest.
--   * the v1 open_slots_digest preference migrated into notification_preferences_v2 so no
--     existing choice is silently reset.

-- ── plain-header sanitizer ──────────────────────────────────────────────────────────────
-- An email SUBJECT is a plain-text header, not HTML. HTML-escaping it turns "A & B" into
-- "A &amp; B" in the header; the risk that matters there is header INJECTION (CR/LF) and
-- length, so strip control characters and bound the length. HTML escaping stays for the BODY.
CREATE OR REPLACE FUNCTION public.notification_plain_header(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT left(btrim(regexp_replace(coalesce(p_text, ''), '[\r\n\t]+', ' ', 'g')), 200);
$$;
REVOKE ALL ON FUNCTION public.notification_plain_header(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notification_plain_header(text) TO service_role;

-- ── 1. the event ────────────────────────────────────────────────────────────────────────
-- required_delivery false (a player can turn it off entirely), email only, WhatsApp off,
-- digest-capable, default 'weekly' to preserve the legacy open_slots_digest default. The
-- digest is REAL — the fan-out routes daily/weekly recipients through notification_queue.
INSERT INTO public.notification_event_types
  (key, category, audience, priority, required_delivery, supports_email, supports_whatsapp,
   supports_push, supports_digest, default_email_frequency, default_whatsapp_frequency,
   default_push_frequency, collapse_window_minutes, quiet_hours_respect, visibility_scope)
VALUES
  ('open_slots_player', 'marketing', 'player', 'marketing', false, true, false,
   false, true, 'weekly', 'off', 'off', 0, true, 'private_user_only')
ON CONFLICT (key) DO NOTHING;

-- ── 2. migrate the v1 preference into v2 ────────────────────────────────────────────────
INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
SELECT np.user_id, 'open_slots_player', np.open_slots_digest
  FROM public.notification_preferences np
 WHERE np.open_slots_digest IN ('off', 'daily', 'weekly')
ON CONFLICT (user_id, event_type) DO NOTHING;

-- ── 3. the durable fan-out job ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notification_fanout_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key       text NOT NULL,
  trainer_id      uuid NOT NULL,
  academy_profile_id uuid,
  slot_ids        uuid[] NOT NULL,
  -- deterministic anchor over (trainer, canonical slot set). Threaded to enqueue_notification
  -- as the idempotency subject; also the UNIQUE key that makes producer creation idempotent.
  event_anchor    text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'done', 'failed')),
  -- resumable cursor: followers are processed in player_id order; this is the last one done.
  follower_cursor uuid,
  -- dead-letter: a page that throws rolls back (see process_notification_fanout) but its
  -- failure metadata commits. attempts + backoff (next_attempt_at) let LATER jobs proceed
  -- instead of the cron hammering one poison job forever; 'failed' is the terminal state.
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz,
  enqueued_count  integer NOT NULL DEFAULT 0,   -- instant → outbox rows
  digested_count  integer NOT NULL DEFAULT 0,   -- daily/weekly → notification_queue rows
  skipped_count   integer NOT NULL DEFAULT 0,   -- preference off
  no_identity_count integer NOT NULL DEFAULT 0, -- follower with no resolvable account
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Atomic producer idempotency: one job per canonical slot set, forever (even after it is done).
CREATE UNIQUE INDEX IF NOT EXISTS uq_fanout_jobs_event_anchor
  ON public.notification_fanout_jobs (event_anchor);
-- The worker picks the oldest claimable job; this partial index makes that scan cheap.
CREATE INDEX IF NOT EXISTS idx_fanout_jobs_claimable
  ON public.notification_fanout_jobs (created_at)
  WHERE status = 'pending';

ALTER TABLE public.notification_fanout_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notification_fanout_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.notification_fanout_jobs TO service_role;

-- ── 4. producer: the trainer creates a job for slots they own ───────────────────────────
CREATE OR REPLACE FUNCTION public.create_open_slots_fanout(p_slot_ids uuid[])
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_trainer  uuid;
  v_academy  uuid;
  v_scopes   int;
  v_ids      uuid[];
  v_n        int;
  v_anchor   text;
  v_job      uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'create_open_slots_fanout: no authenticated actor';
  END IF;

  SELECT id INTO v_trainer FROM public.trainer_profiles WHERE user_id = v_actor;
  IF v_trainer IS NULL THEN
    RAISE EXCEPTION 'create_open_slots_fanout: caller is not a trainer';
  END IF;

  SELECT array_agg(DISTINCT s ORDER BY s) INTO v_ids
    FROM unnest(coalesce(p_slot_ids, ARRAY[]::uuid[])) AS s WHERE s IS NOT NULL;
  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'create_open_slots_fanout: no slots';
  END IF;
  v_n := array_length(v_ids, 1);

  -- EVERY slot must belong to THIS trainer and be genuinely public.
  IF (SELECT count(*) FROM public.availability_slots
        WHERE id = ANY(v_ids) AND trainer_id = v_trainer AND is_public = true) <> v_n THEN
    RAISE EXCEPTION 'create_open_slots_fanout: slot set contains a slot not owned by this trainer or not public';
  END IF;

  -- SINGLE academy scope. A job carries one tenant scope for the timeline + the enqueue's
  -- tenant refs; a set spanning academies (or academy + NULL) has no single coherent scope,
  -- so it is refused rather than silently taking one arbitrarily. The caller splits it.
  SELECT count(DISTINCT coalesce(academy_profile_id, '00000000-0000-0000-0000-000000000000'::uuid)),
         (array_agg(DISTINCT academy_profile_id))[1]
    INTO v_scopes, v_academy
    FROM public.availability_slots WHERE id = ANY(v_ids);
  IF v_scopes <> 1 THEN
    RAISE EXCEPTION 'create_open_slots_fanout: slot set spans multiple academy scopes — split them';
  END IF;

  v_anchor := 'open_slots:' || v_trainer::text || ':' || md5(array_to_string(v_ids, ','));

  -- ATOMIC idempotency: the unique index on event_anchor makes concurrent producers race to
  -- ONE row, and DO UPDATE lets RETURNING hand back the existing job id — even one already
  -- 'done'. The same canonical slot set can therefore never spawn a second O(followers) scan.
  INSERT INTO public.notification_fanout_jobs (event_key, trainer_id, academy_profile_id, slot_ids, event_anchor)
  VALUES ('open_slots_player', v_trainer, v_academy, v_ids, v_anchor)
  ON CONFLICT (event_anchor) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_job;

  RETURN v_job;
END;
$$;

COMMENT ON FUNCTION public.create_open_slots_fanout(uuid[]) IS
  'PR 10b: a trainer creates a durable open_slots_player fan-out job for slots they own. Takes '
  'slot ids ONLY; validates every slot belongs to the caller and is public; rejects a set '
  'spanning multiple academy scopes; derives trainer/academy/anchor server-side. Atomically '
  'idempotent per (trainer, canonical slot set) via a UNIQUE index — the same set always '
  'returns the existing job, even after completion. Fan-out is done by '
  'process_notification_fanout so a large follower set cannot blow the request.';

REVOKE ALL ON FUNCTION public.create_open_slots_fanout(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_open_slots_fanout(uuid[]) TO authenticated, service_role;

-- ── 5. worker: process ONE bounded page of the oldest claimable job ─────────────────────
-- TRANSACTION MODEL (stated precisely, because an earlier version's comments claimed a
-- mid-page lease that did not exist): this function runs as ONE transaction. The claim locks
-- the job row (FOR UPDATE SKIP LOCKED — that, not a lease column, is what stops two workers
-- touching the same job at once). The PAGE WORK runs in a subtransaction (BEGIN/EXCEPTION): on
-- success its cursor + counts commit with the outer transaction; on ANY error it rolls back
-- WHOLLY — no partial progress, the cursor does not move — and only the failure metadata
-- (attempts / last_error / next_attempt_at / 'failed') commits. So a crash mid-page loses the
-- page, not the job, and re-runs from the same cursor. Per-recipient idempotency (below) makes
-- that re-run produce no duplicates.
CREATE OR REPLACE FUNCTION public.process_notification_fanout(
  p_worker text,
  p_max_followers int DEFAULT 200
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job       public.notification_fanout_jobs%ROWTYPE;
  v_trainer_name text;
  v_count     int;
  v_range     text;
  v_subject   text;
  v_html      text;
  v_last      uuid;
  v_enq       int := 0;
  v_dig       int := 0;
  v_skip      int := 0;
  v_noid      int := 0;
  v_processed int := 0;
  v_freq      text;
  v_rows      int;
  v_err       text;
  r           record;
  MAX_ATTEMPTS constant int := 5;
BEGIN
  -- Claimable = pending and not backed off. ORDER BY created_at picks the oldest, but a
  -- backed-off poison job (next_attempt_at in the future) is excluded, so LATER jobs proceed.
  SELECT * INTO v_job FROM public.notification_fanout_jobs
   WHERE status = 'pending'
     AND (next_attempt_at IS NULL OR next_attempt_at <= now())
   ORDER BY created_at
   FOR UPDATE SKIP LOCKED
   LIMIT 1;

  IF v_job.id IS NULL THEN
    RETURN jsonb_build_object('claimed', false, 'done', true, 'remaining', 0);
  END IF;

  BEGIN  -- ── page subtransaction ──────────────────────────────────────────────────────
    SELECT coalesce(nullif(btrim(tp.business_name), ''), nullif(btrim(pr.full_name), ''), 'Je trainer')
      INTO v_trainer_name
      FROM public.trainer_profiles tp
      LEFT JOIN public.profiles pr ON pr.user_id = tp.user_id
     WHERE tp.id = v_job.trainer_id;

    SELECT count(*),
           to_char(min(start_time) AT TIME ZONE 'Europe/Amsterdam', 'DD-MM')
             || ' – ' || to_char(max(start_time) AT TIME ZONE 'Europe/Amsterdam', 'DD-MM')
      INTO v_count, v_range
      FROM public.availability_slots WHERE id = ANY(v_job.slot_ids);

    -- SUBJECT: plain header, sanitized (never HTML-escaped). BODY: HTML, escaped.
    v_subject := public.notification_plain_header(v_trainer_name || ' heeft nieuwe beschikbaarheid');
    v_html := '<div style="font-family:sans-serif"><h2>Nieuwe beschikbaarheid</h2><p>'
      || public.notification_html_escape(v_trainer_name) || ' heeft ' || v_count
      || ' nieuwe moment(en) geopend (' || public.notification_html_escape(v_range)
      || ').</p><p><a href="https://padeltrainer.ai/app/player/agenda">Bekijk en boek</a></p></div>';

    FOR r IN
      SELECT tf.player_id, pr.user_id
        FROM public.trainer_followers tf
        LEFT JOIN public.profiles pr ON pr.id = tf.player_id
       WHERE tf.trainer_id = v_job.trainer_id
         AND tf.notify_new_availability = true                      -- GATE 1: follow toggle
         AND (v_job.follower_cursor IS NULL OR tf.player_id > v_job.follower_cursor)
       ORDER BY tf.player_id
       LIMIT p_max_followers
    LOOP
      v_processed := v_processed + 1;
      v_last := r.player_id;

      IF r.user_id IS NULL THEN
        v_noid := v_noid + 1;                                       -- counted, never dropped
        CONTINUE;
      END IF;

      -- GATE 2 + digest routing: the effective frequency (v2 pref, else the event default
      -- weekly). off → skip; daily/weekly → the existing digest AGGREGATOR
      -- (notification_queue → send-digest-emails composes ONE email with a count); instant →
      -- the outbox via enqueue_notification.
      SELECT email_frequency INTO v_freq
        FROM public.notification_preferences_v2
       WHERE user_id = r.user_id AND event_type = 'open_slots_player';
      v_freq := coalesce(v_freq, 'weekly');

      IF v_freq = 'off' THEN
        v_skip := v_skip + 1;

      ELSIF v_freq IN ('daily', 'weekly') THEN
        -- Idempotent per (user, anchor): a re-run of the page (crash recovery) or a duplicate
        -- job does not re-queue. The whole-page rollback covers within-transaction partials.
        IF NOT EXISTS (
          SELECT 1 FROM public.notification_queue q
           WHERE q.user_id = r.user_id
             AND q.notification_type = 'open_slots_digest'
             AND q.processed_at IS NULL
             AND q.payload->>'anchor' = v_job.event_anchor
        ) THEN
          INSERT INTO public.notification_queue (user_id, notification_type, payload, scheduled_for)
          VALUES (r.user_id, 'open_slots_digest',
                  jsonb_build_object('type', 'open_slots_player', 'anchor', v_job.event_anchor,
                                     'subject', v_subject, 'slotCount', v_count, 'dateRange', v_range),
                  v_freq);
          v_dig := v_dig + 1;
        END IF;

      ELSE  -- instant
        SELECT count(*) INTO v_rows FROM public.enqueue_notification(
          p_event_key           => v_job.event_key,
          p_recipient_user_id   => r.user_id,
          p_tenant_trainer_id   => v_job.trainer_id,
          p_tenant_academy_profile_id => v_job.academy_profile_id,
          p_idempotency_subject => v_job.event_anchor,
          p_payload             => jsonb_build_object('subject', v_subject, 'html', v_html),
          p_public_summary      => jsonb_build_object('event_type', 'open_slots_player', 'slots', v_count)
        );
        IF v_rows > 0 THEN v_enq := v_enq + 1; ELSE v_skip := v_skip + 1; END IF;
      END IF;
    END LOOP;

    -- Advance cursor + counts. Fewer than a full page → the tail is done.
    IF v_processed < p_max_followers THEN
      UPDATE public.notification_fanout_jobs
         SET status = 'done', follower_cursor = coalesce(v_last, follower_cursor),
             enqueued_count = enqueued_count + v_enq, digested_count = digested_count + v_dig,
             skipped_count = skipped_count + v_skip, no_identity_count = no_identity_count + v_noid,
             next_attempt_at = NULL, updated_at = now()
       WHERE id = v_job.id;
      RETURN jsonb_build_object('claimed', true, 'done', true, 'remaining', 0,
               'enqueued', v_enq, 'digested', v_dig, 'skipped', v_skip, 'no_identity', v_noid);
    ELSE
      UPDATE public.notification_fanout_jobs
         SET follower_cursor = v_last,
             enqueued_count = enqueued_count + v_enq, digested_count = digested_count + v_dig,
             skipped_count = skipped_count + v_skip, no_identity_count = no_identity_count + v_noid,
             next_attempt_at = NULL, updated_at = now()
       WHERE id = v_job.id;
      RETURN jsonb_build_object('claimed', true, 'done', false, 'remaining', 1,
               'enqueued', v_enq, 'digested', v_dig, 'skipped', v_skip, 'no_identity', v_noid);
    END IF;

  EXCEPTION WHEN OTHERS THEN
    -- The page work above rolled back to the subtransaction savepoint (no cursor movement, no
    -- half-written rows). Record durable failure metadata on the still-locked job so a poison
    -- job backs off and dead-letters instead of blocking the queue. This commits.
    v_err := SQLERRM;
    UPDATE public.notification_fanout_jobs
       SET attempts = attempts + 1,
           last_error = left(v_err, 500),
           next_attempt_at = now() + (least(v_job.attempts + 1, 6) * interval '5 minutes'),
           status = CASE WHEN v_job.attempts + 1 >= MAX_ATTEMPTS THEN 'failed' ELSE 'pending' END,
           updated_at = now()
     WHERE id = v_job.id;
    RETURN jsonb_build_object('claimed', true, 'failed', true, 'job_id', v_job.id,
             'dead_letter', (v_job.attempts + 1 >= MAX_ATTEMPTS), 'error', left(v_err, 200));
  END;
END;
$$;

COMMENT ON FUNCTION public.process_notification_fanout(text, int) IS
  'PR 10b: process ONE bounded page of the oldest claimable fan-out job. One transaction: the '
  'claim locks the job (FOR UPDATE SKIP LOCKED — the concurrency guard, not a lease); the page '
  'runs in a subtransaction that either commits its cursor + counts or rolls back wholly and '
  'commits only failure metadata. Poison jobs back off and dead-letter (attempts, next_attempt_at, '
  'status=failed) so later jobs proceed. Applies the follow-toggle gate in the query; routes each '
  'follower by effective frequency — off → skip, daily/weekly → notification_queue (send-digest-'
  'emails aggregates), instant → outbox. Per-recipient idempotency (outbox anchor / queue '
  'anchor-dedupe) makes a re-run produce no duplicates. Unreachable followers are counted. '
  'service_role only.';

REVOKE ALL ON FUNCTION public.process_notification_fanout(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_notification_fanout(text, int) TO service_role;
