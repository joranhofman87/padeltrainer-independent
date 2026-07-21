-- PR 10b: open_slots_player — the last legacy send-email route (notify-followers) moves to v2.
--
-- notify-followers announces newly published availability to a trainer's followers. It was the
-- one remaining path that (a) still called the legacy sender, (b) consulted a v1 preference
-- column that DOES NOT EXIST (email_new_availability) while discarding the read error, so its
-- global opt-out was inert, and (c) fanned out to every follower inside a single edge request
-- with a claim-before-send table that could strand a recipient permanently on a crash between
-- claim and send.
--
-- This replaces all three:
--   * ONE catalog event, open_slots_player. Both former "types" (new_availability and
--     slot_reopened) expressed the same preference — "tell me when this trainer has
--     availability" — and slot_reopened has no live producer, so it is not created as a
--     separate capability. A future real reopened-slot producer earns a payload variant then.
--   * a DURABLE, RESUMABLE fan-out job instead of a long request loop, with per-recipient
--     delivery + idempotency owned by enqueue_notification and the outbox worker.
--   * the v1 open_slots_digest preference migrated into notification_preferences_v2 so no
--     existing choice is silently reset.

-- ── 1. the event ────────────────────────────────────────────────────────────────────────
-- required_delivery false (a player can turn it off entirely), email only, WhatsApp off,
-- digest-capable, and default 'weekly' to preserve the legacy open_slots_digest default.
INSERT INTO public.notification_event_types
  (key, category, audience, priority, required_delivery, supports_email, supports_whatsapp,
   supports_push, supports_digest, default_email_frequency, default_whatsapp_frequency,
   default_push_frequency, collapse_window_minutes, quiet_hours_respect, visibility_scope)
VALUES
  ('open_slots_player', 'marketing', 'player', 'marketing', false, true, false,
   false, true, 'weekly', 'off', 'off', 0, true, 'private_user_only')
ON CONFLICT (key) DO NOTHING;

-- ── 2. migrate the v1 preference into v2 ────────────────────────────────────────────────
-- open_slots_digest holds the player's chosen cadence ('off' | 'daily' | 'weekly'). Carry
-- every EXPLICIT value across so a migrated player keeps exactly what they chose; players with
-- no explicit value fall through to the event default (weekly), which is the legacy default.
-- Idempotent: re-running does not overwrite a v2 row the player has since set for themselves.
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
  -- as the idempotency subject, so a retried job — or a second job for the same slots —
  -- cannot double-notify anyone.
  event_anchor    text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'done')),
  -- resumable cursor: followers are processed in player_id order; this is the last one done.
  follower_cursor uuid,
  -- recoverable lease: a worker claims the job for a bounded window. If it crashes, the lease
  -- expires and another worker resumes FROM THE CURSOR — never from the start, never dropping
  -- the tail.
  lease_owner     text,
  lease_expires_at timestamptz,
  enqueued_count  integer NOT NULL DEFAULT 0,
  skipped_count   integer NOT NULL DEFAULT 0,   -- resolver said skipped (e.g. preference off)
  no_identity_count integer NOT NULL DEFAULT 0, -- follower with no resolvable account/email
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The worker picks the oldest claimable job; this index makes that scan cheap.
CREATE INDEX IF NOT EXISTS idx_fanout_jobs_claimable
  ON public.notification_fanout_jobs (created_at)
  WHERE status <> 'done';

ALTER TABLE public.notification_fanout_jobs ENABLE ROW LEVEL SECURITY;
-- No policies: the table is reachable only through the SECURITY DEFINER functions below.
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

  -- Canonical set: distinct + sorted, so the anchor is order-independent.
  SELECT array_agg(DISTINCT s ORDER BY s) INTO v_ids
    FROM unnest(coalesce(p_slot_ids, ARRAY[]::uuid[])) AS s WHERE s IS NOT NULL;
  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'create_open_slots_fanout: no slots';
  END IF;
  v_n := array_length(v_ids, 1);

  -- EVERY slot must belong to THIS trainer and be genuinely public. A set that mixes in a
  -- foreign or private slot is refused whole — never trust the caller's ownership claim, and
  -- never announce a slot the public cannot actually book.
  IF (SELECT count(*) FROM public.availability_slots
        WHERE id = ANY(v_ids) AND trainer_id = v_trainer AND is_public = true) <> v_n THEN
    RAISE EXCEPTION 'create_open_slots_fanout: slot set contains a slot not owned by this trainer or not public';
  END IF;

  SELECT (array_agg(DISTINCT academy_profile_id))[1] INTO v_academy
    FROM public.availability_slots WHERE id = ANY(v_ids);

  v_anchor := 'open_slots:' || v_trainer::text || ':' || md5(array_to_string(v_ids, ','));

  -- Idempotent per (trainer, slot set): calling twice for the same bulk creation reuses the
  -- open job rather than creating a duplicate fan-out.
  SELECT id INTO v_job FROM public.notification_fanout_jobs
   WHERE event_anchor = v_anchor AND status <> 'done' LIMIT 1;
  IF v_job IS NOT NULL THEN
    RETURN v_job;
  END IF;

  INSERT INTO public.notification_fanout_jobs (event_key, trainer_id, academy_profile_id, slot_ids, event_anchor)
  VALUES ('open_slots_player', v_trainer, v_academy, v_ids, v_anchor)
  RETURNING id INTO v_job;

  RETURN v_job;
END;
$$;

COMMENT ON FUNCTION public.create_open_slots_fanout(uuid[]) IS
  'PR 10b: a trainer creates a durable open_slots_player fan-out job for slots they own. Takes '
  'slot ids ONLY; validates every slot belongs to the caller and is public; derives trainer, '
  'academy and a deterministic anchor server-side. Idempotent per (trainer, canonical slot set). '
  'The actual follower fan-out is done by process_notification_fanout so a large follower set '
  'cannot blow the request, and a crash resumes from a cursor.';

REVOKE ALL ON FUNCTION public.create_open_slots_fanout(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_open_slots_fanout(uuid[]) TO authenticated, service_role;

-- ── 5. worker: process ONE bounded page of the oldest claimable job ─────────────────────
-- Returns a small json summary so the caller can loop until {done:true, remaining:0}.
CREATE OR REPLACE FUNCTION public.process_notification_fanout(
  p_worker text,
  p_max_followers int DEFAULT 200,
  p_lease_seconds int DEFAULT 120
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
  v_skip      int := 0;
  v_noid      int := 0;
  v_processed int := 0;
  r           record;
  v_rows      int;
BEGIN
  -- Claim the oldest job whose lease is free or expired. SKIP LOCKED lets several workers run
  -- without fighting over the same job; the lease is what protects against a crashed worker.
  SELECT * INTO v_job FROM public.notification_fanout_jobs
   WHERE status <> 'done'
     AND (lease_expires_at IS NULL OR lease_expires_at < now())
   ORDER BY created_at
   FOR UPDATE SKIP LOCKED
   LIMIT 1;

  IF v_job.id IS NULL THEN
    RETURN jsonb_build_object('claimed', false, 'done', true, 'remaining', 0);
  END IF;

  UPDATE public.notification_fanout_jobs
     SET status = 'processing', lease_owner = p_worker,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
   WHERE id = v_job.id;

  -- Copy derived once per page. Trainer name: business_name, else profile full name.
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

  v_subject := public.notification_html_escape(v_trainer_name) || ' heeft nieuwe beschikbaarheid';
  v_html := '<div style="font-family:sans-serif"><h2>Nieuwe beschikbaarheid</h2><p>'
    || public.notification_html_escape(v_trainer_name) || ' heeft ' || v_count
    || ' nieuwe moment(en) geopend (' || public.notification_html_escape(v_range)
    || ').</p><p><a href="https://padeltrainer.ai/app/player/agenda">Bekijk en boek</a></p></div>';

  -- Followers past the cursor, in a stable order, honoring the FOLLOW-TOGGLE gate here. The
  -- SECOND gate — the v2 open_slots_player preference — is applied INSIDE enqueue_notification
  -- (frequency 'off' → no row), so a migrated 'off' player is skipped there.
  FOR r IN
    SELECT tf.player_id, pr.user_id
      FROM public.trainer_followers tf
      LEFT JOIN public.profiles pr ON pr.id = tf.player_id
     WHERE tf.trainer_id = v_job.trainer_id
       AND tf.notify_new_availability = true
       AND (v_job.follower_cursor IS NULL OR tf.player_id > v_job.follower_cursor)
     ORDER BY tf.player_id
     LIMIT p_max_followers
  LOOP
    v_processed := v_processed + 1;
    v_last := r.player_id;

    IF r.user_id IS NULL THEN
      -- A follower with no account has no recipient the resolver can reach. COUNTED, not
      -- silently dropped, so an unreachable follower is visible on the job.
      v_noid := v_noid + 1;
      CONTINUE;
    END IF;

    -- Per-recipient enqueue. Idempotency subject = the job's deterministic anchor, so a
    -- re-processed page (crash recovery) re-enqueues the SAME key and the resolver no-ops.
    -- Digest cadence + collapse + real delivery are the resolver's and worker's job.
    SELECT count(*) INTO v_rows FROM public.enqueue_notification(
      p_event_key           => 'open_slots_player',
      p_recipient_user_id   => r.user_id,
      p_tenant_trainer_id   => v_job.trainer_id,
      p_tenant_academy_profile_id => v_job.academy_profile_id,
      p_idempotency_subject => v_job.event_anchor,
      p_payload             => jsonb_build_object('subject', v_subject, 'html', v_html),
      p_public_summary      => jsonb_build_object('event_type', 'open_slots_player', 'slots', v_count)
    );
    IF v_rows > 0 THEN v_enq := v_enq + 1; ELSE v_skip := v_skip + 1; END IF;
  END LOOP;

  -- Advance the cursor and counts. The cursor moves only AFTER the page's enqueues, and the
  -- enqueues are idempotent, so a crash before this UPDATE simply re-does the page harmlessly.
  IF v_processed < p_max_followers THEN
    -- fewer than a full page came back → the tail is done.
    UPDATE public.notification_fanout_jobs
       SET status = 'done', follower_cursor = coalesce(v_last, follower_cursor),
           enqueued_count = enqueued_count + v_enq, skipped_count = skipped_count + v_skip,
           no_identity_count = no_identity_count + v_noid,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = v_job.id;
    RETURN jsonb_build_object('claimed', true, 'done', true, 'remaining', 0,
             'enqueued', v_enq, 'skipped', v_skip, 'no_identity', v_noid);
  ELSE
    UPDATE public.notification_fanout_jobs
       SET status = 'pending', follower_cursor = v_last,
           enqueued_count = enqueued_count + v_enq, skipped_count = skipped_count + v_skip,
           no_identity_count = no_identity_count + v_noid,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = v_job.id;
    RETURN jsonb_build_object('claimed', true, 'done', false, 'remaining', 1,
             'enqueued', v_enq, 'skipped', v_skip, 'no_identity', v_noid);
  END IF;
END;
$$;

COMMENT ON FUNCTION public.process_notification_fanout(text, int, int) IS
  'PR 10b: process ONE bounded page of the oldest claimable notification fan-out job. Leased '
  '(recoverable if the worker crashes), resumable (a player_id cursor, never restarts), and '
  'safe to re-run (per-recipient enqueue is idempotent on the job anchor, so a re-processed '
  'page creates no duplicate outbox rows). Applies the follow-toggle gate in the query and '
  'lets enqueue_notification apply the v2 preference gate. Unreachable followers are counted, '
  'never dropped. service_role only.';

REVOKE ALL ON FUNCTION public.process_notification_fanout(text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_notification_fanout(text, int, int) TO service_role;
