-- PR 10c-a2 — v2 notification DIGEST materializer: SQL STATE MACHINE (ADR 0008, Phase B).
-- The complete SQL state machine over the 10c-a1 schema: worker-run lifecycle, materialize, claim, prepare,
-- split, store, begin-attempt, record-result, the provider-callback transition, the circuit breaker, the
-- attempt-aware reservation/cap accounting, reconciliation, and stale/crash recovery — EXACTLY per ADR 0008.
-- INERT: no worker calls these yet, no edge function, no digest-enabled event. SQL-only.
--
-- Every RPC here is SECURITY DEFINER + SET search_path=public + service_role-only, and each is REVOKEd from
-- PUBLIC/anon/authenticated (Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE ON FUNCTIONS to those roles,
-- so a bare GRANT is not enough — see §13). Every state mutation appends its ledger row in the SAME
-- transaction, and every claim uses bounded FOR UPDATE SKIP LOCKED + ownership tokens + schema clocks +
-- checked affected-row counts. Owner params (ADR): 50 items / ~90 KB / 09:00–20:00 quiet hours /
-- academy→trainer→Amsterdam / 35-day counter + 90-day audit retention / 23 h uncertainty / weekly=Monday.

-- ===========================================================================
-- §0. constants + small helpers ---------------------------------------------
-- terminal states (a group at rest); "in flight" = everything else.
CREATE OR REPLACE FUNCTION public.notif_digest_terminal_states() RETURNS text[]
  LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['sent','failed_terminal','oversize_failed','delivery_unknown',
    'retry_stopped','no_work','superseded']::text[] $$;

-- append ONE ledger row in the caller's transaction (append-only table; INSERT/SELECT only).
CREATE OR REPLACE FUNCTION public.notif_digest_ledger(
    p_run_id uuid, p_group_id uuid, p_attempt_id uuid, p_action text, p_item_count int DEFAULT 0)
  RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.notification_digest_group_attempts (worker_run_id, digest_group_id, attempt_id, action, item_count)
  VALUES (p_run_id, p_group_id, p_attempt_id, p_action, coalesce(p_item_count, 0));
$$;

-- §QH quiet hours: [09:00, 20:00) in the recipient's timezone. Returns the same instant if inside the
-- window, else the next 09:00 local. Callers bump available_at only (never send outside the window).
CREATE OR REPLACE FUNCTION public.notif_digest_quiet_hours_bump(p_now timestamptz, p_tz text)
  RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_local timestamptz; v_h int; v_day date;
BEGIN
  v_local := p_now AT TIME ZONE p_tz;               -- wall-clock in the recipient tz (as a naive ts)
  v_h := extract(hour FROM v_local)::int;
  IF v_h >= 9 AND v_h < 20 THEN RETURN p_now; END IF;      -- inside the window
  v_day := (v_local)::date;
  IF v_h >= 20 THEN v_day := v_day + 1; END IF;            -- after 20:00 → tomorrow 09:00
  RETURN ((v_day + time '09:00') AT TIME ZONE p_tz);       -- next 09:00 local as an instant
END $$;

-- §ERR transport + status + name taxonomy (fixes #4). Returns the outcome_class for record-result.
CREATE OR REPLACE FUNCTION public.notif_digest_classify_error(
    p_transport text, p_http_status int, p_error_name text)
  RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  -- transport failures (no definite HTTP answer) are ambiguous
  IF p_transport IS NOT NULL AND p_transport IN ('timeout','no_response','network') THEN RETURN 'ambiguous'; END IF;
  IF p_http_status IS NULL THEN RETURN 'ambiguous'; END IF;                       -- no response
  IF p_http_status >= 500 THEN RETURN 'ambiguous'; END IF;                        -- 5xx / application_error
  IF p_http_status = 409 THEN RETURN 'ambiguous'; END IF;                         -- concurrent_idempotent_requests
  IF p_http_status = 429 THEN
    IF p_error_name IN ('daily_quota_exceeded','monthly_quota_exceeded') THEN RETURN 'global_config'; END IF;
    RETURN 'retryable_definite';                                                  -- rate_limit_exceeded (Retry-After)
  END IF;
  IF p_http_status IN (401, 403) THEN RETURN 'global_config'; END IF;             -- invalid/restricted api key
  IF p_error_name = 'invalid_idempotent_request' THEN RETURN 'global_config'; END IF; -- invariant breach → manual hold
  IF p_http_status >= 200 AND p_http_status < 300 THEN RETURN 'accepted'; END IF; -- API accepted
  IF p_http_status >= 400 AND p_http_status < 500 THEN
    -- known-terminal allow-list; any other definite 4xx is a global_config hold (NOT ambiguous, NOT row-terminal)
    IF p_error_name IN ('validation_error','invalid_from_address','invalid_attachment','missing_required_field')
      THEN RETURN 'terminal'; END IF;
    RETURN 'global_config';
  END IF;
  RETURN 'ambiguous';
END $$;

-- §PV monotonic provider-status rank (0 none … 5 complained). Matches the 10c-a1 group CHECK.
CREATE OR REPLACE FUNCTION public.notif_digest_provider_rank(p_status text) RETURNS int
  LANGUAGE sql IMMUTABLE AS $$ SELECT CASE p_status
    WHEN 'none' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivery_delayed' THEN 2 WHEN 'delivered' THEN 3
    WHEN 'bounced' THEN 4 WHEN 'failed' THEN 4 WHEN 'suppressed' THEN 4 WHEN 'complained' THEN 5 END $$;

-- map an outcome_class to its ledger action (the ledger CHECK uses action names, not class names).
CREATE OR REPLACE FUNCTION public.notif_digest_action_for_class(p_class text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT CASE p_class
    WHEN 'accepted' THEN 'sent' WHEN 'retryable_definite' THEN 'retryable' WHEN 'ambiguous' THEN 'ambiguous'
    WHEN 'terminal' THEN 'terminal' WHEN 'global_config' THEN 'global_config' END $$;

-- ===========================================================================
-- §LEDGER — worker-run lifecycle RPCs (the guards enforce born-unfinished + finish-once).
CREATE OR REPLACE FUNCTION public.start_notification_worker_run(p_worker text, p_channel text, p_phase text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_run uuid;
BEGIN
  INSERT INTO public.notification_worker_runs (worker, channel, phase)
  VALUES (p_worker, p_channel, p_phase) RETURNING run_id INTO v_run;
  RETURN v_run;
END $$;

CREATE OR REPLACE FUNCTION public.finish_notification_worker_run(p_run_id uuid, p_status text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int;
BEGIN
  IF p_status NOT IN ('succeeded','failed','abandoned') THEN
    RAISE EXCEPTION 'finish_notification_worker_run: invalid status %', p_status;
  END IF;
  UPDATE public.notification_worker_runs SET status = p_status
   WHERE run_id = p_run_id AND ended_at IS NULL;   -- the guard also forces ended_at := now()
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'worker run % not found or already finished', p_run_id; END IF;
END $$;

-- ===========================================================================
-- §CAPS — attempt-aware reservation/cap helpers (never release while uncertain). counter_key is per
-- destination + bucket. A reservation carries the ORIGINATING attempt_id (immutable across reuse).
CREATE OR REPLACE FUNCTION public.notif_digest_counter_key(
    p_channel text, p_event_type text, p_fingerprint text, p_bucket_kind text, p_bucket_start timestamptz)
  RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT p_channel||':'||p_event_type||':'||p_fingerprint||':'||p_bucket_kind||':'||p_bucket_start::text $$;

-- Reservations carry the ORIGINATING attempt (composite FK → attempts), so the attempt must exist before the
-- reservation row. And cap-exhaustion must DEFER the group without a dangling attempt. So begin_digest_attempt
-- reserves in two phases: (1) gate — ensure+lock each counter, decide reuse/available/full BEFORE inserting
-- the attempt; (2) apply — after the attempt exists, increment + stamp the reservation for each fresh bucket.

-- gate: ensure the counter row, FOR UPDATE lock it (held to end of txn), and classify this group+bucket.
CREATE OR REPLACE FUNCTION public.notif_digest_bucket_gate(
    p_group_id uuid, p_key text, p_bucket_kind text, p_bucket_start timestamptz, p_cap int)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_used int; v_cap int; v_res_state text;
BEGIN
  SELECT state INTO v_res_state FROM public.notification_send_reservations
   WHERE digest_group_id = p_group_id AND counter_key = p_key FOR UPDATE;
  IF FOUND AND v_res_state IN ('reserved','committed') THEN RETURN 'reuse'; END IF;  -- capacity already held
  -- arbiter-less DO NOTHING: counter_key is the PK AND anchors uq_send_counter_bucket; under a concurrent
  -- insert a single-column arbiter would let the secondary unique index raise on speculative insertion.
  INSERT INTO public.notification_send_counters (counter_key, bucket_kind, bucket_start, used, cap)
  VALUES (p_key, p_bucket_kind, p_bucket_start, 0, p_cap) ON CONFLICT DO NOTHING;
  SELECT used, cap INTO v_used, v_cap FROM public.notification_send_counters WHERE counter_key = p_key FOR UPDATE;
  IF v_used >= v_cap THEN RETURN 'full'; END IF;
  RETURN 'available';
END $$;

-- apply: consume one unit and stamp the reservation with THIS attempt (only for a fresh 'available' bucket).
CREATE OR REPLACE FUNCTION public.notif_digest_bucket_apply(
    p_group_id uuid, p_key text, p_attempt_id uuid, p_bucket_start timestamptz, p_now timestamptz)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_exists boolean;
BEGIN
  UPDATE public.notification_send_counters SET used = used + 1 WHERE counter_key = p_key;
  SELECT true INTO v_exists FROM public.notification_send_reservations
   WHERE digest_group_id = p_group_id AND counter_key = p_key;
  IF v_exists THEN   -- a previously-released reservation on this exact (group,bucket): re-reserve (attempt_id write-once, keep original)
    UPDATE public.notification_send_reservations SET state = 'reserved', updated_at = p_now
     WHERE digest_group_id = p_group_id AND counter_key = p_key;
  ELSE
    INSERT INTO public.notification_send_reservations (digest_group_id, counter_key, attempt_id, bucket_start, state)
    VALUES (p_group_id, p_key, p_attempt_id, p_bucket_start, 'reserved');
  END IF;
END $$;

-- commit every active reservation of a group (accepted / ambiguous — capacity consumed/possibly-consumed).
CREATE OR REPLACE FUNCTION public.notif_digest_commit_reservations(p_group_id uuid, p_now timestamptz)
  RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.notification_send_reservations SET state = 'committed', updated_at = p_now
   WHERE digest_group_id = p_group_id AND state IN ('reserved','committed');
$$;

-- release-once (reserved→released, used--) ONLY for a definite outcome while NOT uncertain.
CREATE OR REPLACE FUNCTION public.notif_digest_release_reservations(p_group_id uuid, p_now timestamptz)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT counter_key FROM public.notification_send_reservations
            WHERE digest_group_id = p_group_id AND state = 'reserved' FOR UPDATE LOOP
    UPDATE public.notification_send_counters SET used = greatest(used - 1, 0) WHERE counter_key = r.counter_key;
    UPDATE public.notification_send_reservations SET state = 'released', updated_at = p_now
     WHERE digest_group_id = p_group_id AND counter_key = r.counter_key;
  END LOOP;
END $$;

-- ===========================================================================
-- §RECON — reconcile_notification_digest_run: two families over one run's ledger + the groups it touched.
CREATE OR REPLACE FUNCTION public.reconcile_notification_digest_run(p_run_id uuid)
  RETURNS TABLE (family text, metric text, count int) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  -- family 'event': raw ledger action counts (repeated deferrals are distinct events; attempt==provider sends)
  SELECT 'event'::text AS family, l.action AS metric, count(*)::int AS count
    FROM public.notification_digest_group_attempts l WHERE l.worker_run_id = p_run_id GROUP BY l.action
  UNION ALL
  -- family 'group': DISTINCT groups this run drove to each terminal state (superseded reported separately).
  SELECT 'group'::text, g.state, count(DISTINCT g.id)::int
    FROM public.notification_digest_groups g
   WHERE g.id IN (SELECT DISTINCT digest_group_id FROM public.notification_digest_group_attempts WHERE worker_run_id = p_run_id)
   GROUP BY g.state;
$$;

-- ===========================================================================
-- §MAT — Phase A materialize: create groups + assign members atomically, deterministic 50-item cap + byte
-- budget, chunk_ordinal continuation, available_at = digest_boundary_at, raw single-item oversize terminal.
CREATE OR REPLACE FUNCTION public.materialize_notification_digest_groups(
    p_run_id uuid, p_channel text, p_now timestamptz, p_max_groups int, p_max_members_per_call int)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_budget int := 92160;                 -- ~90 KB cumulative byte budget per group
  v_created int := 0;
  m record;
  v_ckey jsonb; v_hash text; v_group uuid;
  v_cur_ckey jsonb := NULL; v_cur_group uuid := NULL; v_cur_count int := 0; v_cur_bytes int := 0;
BEGIN
  FOR m IN
    SELECT o.id, coalesce(o.digest_item_bytes, 0) AS bytes, o.digest_boundary_at, o.recipient_key,
           o.destination_fingerprint, o.event_type, o.tenant_academy_profile_id, o.tenant_trainer_id,
           coalesce(o.recipient_timezone,'Europe/Amsterdam') AS tz,
           jsonb_build_array('v1', o.channel, o.recipient_key, o.destination_fingerprint,
             o.tenant_academy_profile_id, o.tenant_trainer_id, o.event_type, o.template_key,
             o.template_version, o.group_locale, o.digest_frequency, o.digest_boundary_at) AS ckey
      FROM public.notification_outbox o
     WHERE o.channel = p_channel AND coalesce(o.delivery_mode,'') = 'digest'
       AND o.digest_group_id IS NULL AND o.status = 'pending'
     ORDER BY (jsonb_build_array('v1', o.channel, o.recipient_key, o.destination_fingerprint,
             o.tenant_academy_profile_id, o.tenant_trainer_id, o.event_type, o.template_key,
             o.template_version, o.group_locale, o.digest_frequency, o.digest_boundary_at))::text,
             o.created_at, o.id
     LIMIT greatest(p_max_members_per_call, 0)
  LOOP
    v_ckey := m.ckey; v_hash := encode(sha256(v_ckey::text::bytea), 'hex');

    -- raw single-item oversize: cannot ever fit → its own oversize_failed group (member finalized).
    IF m.bytes > v_budget THEN
      IF v_created >= p_max_groups THEN CONTINUE; END IF;
      PERFORM pg_advisory_xact_lock(hashtext(v_hash));
      INSERT INTO public.notification_digest_groups
        (canonical_group_key, group_key_hash, chunk_ordinal, channel, event_type, recipient_key,
         destination_fingerprint, tenant_academy_profile_id, tenant_trainer_id, recipient_timezone,
         digest_boundary_at, available_at, state, item_count, total_item_bytes, terminal_reason)
      VALUES (v_ckey, v_hash, coalesce((SELECT max(chunk_ordinal) FROM public.notification_digest_groups
                WHERE canonical_group_key = v_ckey), -1) + 1,
              p_channel, m.event_type, m.recipient_key, m.destination_fingerprint,
              m.tenant_academy_profile_id, m.tenant_trainer_id, m.tz, m.digest_boundary_at, m.digest_boundary_at,
              'oversize_failed', 1, m.bytes, 'single_item_oversize')
      RETURNING id INTO v_group;
      UPDATE public.notification_outbox SET digest_group_id = v_group, status = 'failed',
             skip_reason = 'single_item_oversize', payload = NULL, digest_item = NULL, updated_at = p_now
       WHERE id = m.id;
      PERFORM notif_digest_ledger(p_run_id, v_group, NULL, 'oversize_failed', 1);
      v_created := v_created + 1; v_cur_ckey := NULL;   -- reset the running group
      CONTINUE;
    END IF;

    -- start a new group/chunk when the key changes, the 50-item cap is hit, or the byte budget would overflow.
    IF v_cur_ckey IS NULL OR v_cur_ckey <> v_ckey OR v_cur_count >= 50 OR (v_cur_bytes + m.bytes) > v_budget THEN
      IF v_created >= p_max_groups THEN EXIT; END IF;   -- respect the per-call group bound
      PERFORM pg_advisory_xact_lock(hashtext(v_hash));
      INSERT INTO public.notification_digest_groups
        (canonical_group_key, group_key_hash, chunk_ordinal, channel, event_type, recipient_key,
         destination_fingerprint, tenant_academy_profile_id, tenant_trainer_id, recipient_timezone,
         digest_boundary_at, available_at, state)
      VALUES (v_ckey, v_hash, coalesce((SELECT max(chunk_ordinal) FROM public.notification_digest_groups
                WHERE canonical_group_key = v_ckey), -1) + 1,
              p_channel, m.event_type, m.recipient_key, m.destination_fingerprint,
              m.tenant_academy_profile_id, m.tenant_trainer_id, m.tz, m.digest_boundary_at, m.digest_boundary_at,
              'pending')
      RETURNING id INTO v_group;
      v_created := v_created + 1;
      v_cur_ckey := v_ckey; v_cur_group := v_group; v_cur_count := 0; v_cur_bytes := 0;
      PERFORM notif_digest_ledger(p_run_id, v_group, NULL, 'materialized', 0);
    END IF;

    -- assign the member to the running group.
    UPDATE public.notification_outbox SET digest_group_id = v_cur_group, updated_at = p_now WHERE id = m.id;
    v_cur_count := v_cur_count + 1; v_cur_bytes := v_cur_bytes + m.bytes;
    UPDATE public.notification_digest_groups SET item_count = v_cur_count, total_item_bytes = v_cur_bytes,
           updated_at = p_now WHERE id = v_cur_group;
  END LOOP;
  RETURN v_created;
END $$;

-- ===========================================================================
-- §P1 — claim (breaker-gated, quiet-hours, awaiting_evidence age-out, crash reclaim). Returns ONE leased
-- group id (or NULL). Bounded internal scan; each candidate is FOR UPDATE SKIP LOCKED, ORDER BY available_at.
CREATE OR REPLACE FUNCTION public.claim_notification_digest_group(
    p_run_id uuid, p_channel text, p_now timestamptz, p_worker text, p_stale_minutes int DEFAULT 15)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g record; v_iter int := 0; v_bump timestamptz; v_cb record;
BEGIN
  LOOP
    v_iter := v_iter + 1;
    IF v_iter > 200 THEN RETURN NULL; END IF;   -- hard scan bound (never unbounded)
    SELECT * INTO g FROM public.notification_digest_groups
     WHERE channel = p_channel
       AND ( (state IN ('pending','request_ready') AND locked_by IS NULL AND available_at <= p_now)
          OR (state = 'awaiting_evidence' AND available_at <= p_now)
          OR (state IN ('leased','prepared','request_ready','sending')
              AND locked_at IS NOT NULL AND locked_at < p_now - make_interval(mins => p_stale_minutes)) )
     ORDER BY available_at
     FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;

    -- awaiting_evidence age-out → no-send delivery_unknown (finalize members + reservations), continue.
    IF g.state = 'awaiting_evidence' THEN
      PERFORM notif_digest_finalize_group(g.id, 'delivery_unknown', 'age_out', p_now);
      PERFORM notif_digest_commit_reservations(g.id, p_now);
      PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'delivery_unknown', 0);
      CONTINUE;
    END IF;

    -- crash reclaim of a stale-locked group.
    IF g.locked_at IS NOT NULL AND g.locked_at < p_now - make_interval(mins => p_stale_minutes)
       AND g.state IN ('leased','prepared','request_ready','sending') THEN
      IF g.state = 'sending' THEN
        UPDATE public.notification_digest_groups
           SET uncertain_since = coalesce(uncertain_since, p_now), state = 'request_ready',
               locked_by = p_worker, locked_at = p_now, worker_run_id = p_run_id, available_at = p_now, updated_at = p_now
         WHERE id = g.id;
      ELSE
        UPDATE public.notification_digest_groups
           SET locked_by = p_worker, locked_at = p_now, worker_run_id = p_run_id, updated_at = p_now
         WHERE id = g.id;
      END IF;
      PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'leased', 0);
      RETURN g.id;
    END IF;

    -- quiet hours: bump available_at (defer), do not claim.
    v_bump := notif_digest_quiet_hours_bump(p_now, g.recipient_timezone);
    IF v_bump > p_now THEN
      UPDATE public.notification_digest_groups SET available_at = v_bump, updated_at = p_now WHERE id = g.id;
      PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'deferred', 0);
      CONTINUE;
    END IF;

    -- breaker two-stage probe gate (§CB): closed → lease; open+not-due → defer; open+due promotes ONE group
    -- to the probe (CAS open→half_open, bind probe_group_id); under half_open only the probe proceeds; a
    -- stale probe lease re-arms to open (crash recovery).
    SELECT * INTO v_cb FROM public.notification_provider_circuit WHERE channel = p_channel FOR UPDATE;
    IF FOUND AND v_cb.state <> 'closed' THEN
      IF v_cb.state = 'half_open' AND v_cb.probe_group_id IS NOT NULL
         AND v_cb.probe_locked_at IS NOT NULL AND v_cb.probe_locked_at < p_now - make_interval(mins => p_stale_minutes) THEN
        UPDATE public.notification_provider_circuit SET state = 'open', probe_group_id = NULL,
               probe_attempt_id = NULL, probe_locked_at = NULL, retry_at = p_now WHERE channel = p_channel;
        CONTINUE;   -- re-armed; re-evaluate on the next iteration
      ELSIF v_cb.probe_group_id = g.id THEN
        NULL;       -- this IS the bound probe → fall through to lease
      ELSIF v_cb.state = 'open' AND (v_cb.retry_at IS NULL OR p_now < v_cb.retry_at) THEN
        UPDATE public.notification_digest_groups SET available_at = p_now + interval '5 minutes', updated_at = p_now WHERE id = g.id;
        PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'deferred', 0);
        CONTINUE;   -- open, not yet due → defer
      ELSIF v_cb.state = 'open' AND v_cb.probe_group_id IS NULL THEN
        UPDATE public.notification_provider_circuit SET state = 'half_open', probe_group_id = g.id, probe_locked_at = p_now WHERE channel = p_channel;
        -- promoted THIS group to the probe → fall through to lease
      ELSE
        UPDATE public.notification_digest_groups SET available_at = p_now + interval '5 minutes', updated_at = p_now WHERE id = g.id;
        PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'deferred', 0);
        CONTINUE;   -- a different probe is bound → defer
      END IF;
    END IF;

    -- claimable: lease it.
    UPDATE public.notification_digest_groups
       SET state = CASE WHEN g.state = 'pending' THEN 'leased' ELSE g.state END,
           locked_by = p_worker, locked_at = p_now, worker_run_id = p_run_id, updated_at = p_now
     WHERE id = g.id;
    PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'leased', 0);
    RETURN g.id;
  END LOOP;
END $$;

-- finalize a group to a terminal state: finalize members (§MEM), scrub (§SCRUB), stamp terminal_reason.
CREATE OR REPLACE FUNCTION public.notif_digest_finalize_group(
    p_group_id uuid, p_terminal_state text, p_reason text, p_now timestamptz)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_member_status text; v_member_reason text;
BEGIN
  -- member finalization mapping (§MEM / §PV / §SCRUB): no member left pending.
  v_member_status := CASE p_terminal_state
    WHEN 'sent' THEN 'sent' WHEN 'failed_terminal' THEN 'failed' WHEN 'oversize_failed' THEN 'failed'
    WHEN 'delivery_unknown' THEN 'delivery_unknown' WHEN 'retry_stopped' THEN 'skipped' ELSE 'skipped' END;
  v_member_reason := p_reason;
  UPDATE public.notification_outbox
     SET status = v_member_status, skip_reason = coalesce(skip_reason, v_member_reason),
         payload = NULL, digest_item = NULL, updated_at = p_now
   WHERE digest_group_id = p_group_id AND status NOT IN ('sent','delivered','failed','skipped','cancelled');
  -- group: terminal state + scrub frozen_request + reason (the guard stamps terminal_at; monotonic rank/state hold).
  UPDATE public.notification_digest_groups
     SET state = p_terminal_state, terminal_reason = coalesce(terminal_reason, p_reason),
         frozen_request = NULL, locked_by = NULL, locked_at = NULL, updated_at = p_now
   WHERE id = p_group_id;
END $$;

-- ===========================================================================
-- §P2 — prepare (ownership-gated, from leased): §PS stop-check drops non-pending (rejected) members and
-- finalizes them (§MEM); survivors → prepared, else the whole group → no_work. (The resolver already applied
-- preference/consent/suppression at enqueue; this is the state-machine re-gate — the event policy hook is 10c-b.)
CREATE OR REPLACE FUNCTION public.prepare_notification_digest_group(
    p_run_id uuid, p_group_id uuid, p_worker text, p_now timestamptz)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int; v_survivors int;
BEGIN
  UPDATE public.notification_digest_groups SET updated_at = p_now
   WHERE id = p_group_id AND state = 'leased' AND locked_by = p_worker;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'prepare: group % not owned/leased by %', p_group_id, p_worker; END IF;

  -- survivors = members still pending; anything already non-pending was rejected upstream and stays finalized.
  SELECT count(*) INTO v_survivors FROM public.notification_outbox
   WHERE digest_group_id = p_group_id AND status = 'pending';

  IF v_survivors = 0 THEN
    PERFORM notif_digest_finalize_group(p_group_id, 'no_work', 'no_survivors', p_now);
    PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'no_work', 0);
    RETURN 'no_work';
  END IF;
  UPDATE public.notification_digest_groups SET state = 'prepared', item_count = v_survivors, updated_at = p_now
   WHERE id = p_group_id;
  PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'prepared', v_survivors);
  RETURN 'prepared';
END $$;

-- ===========================================================================
-- §P3 — split (ownership-gated, from pending|prepared): create children (parent_group_id = original), move
-- members across them in ≤ p_max_items_per_child chunks, original → superseded (members moved out).
CREATE OR REPLACE FUNCTION public.split_notification_digest_group(
    p_run_id uuid, p_group_id uuid, p_worker text, p_max_items_per_child int, p_now timestamptz)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g record; m record; v_child uuid; v_in_child int := 0; v_children int := 0; v_next_chunk int; v_n int;
BEGIN
  SELECT * INTO g FROM public.notification_digest_groups
   WHERE id = p_group_id AND state IN ('pending','prepared') AND locked_by = p_worker FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'split: group % not owned/splittable', p_group_id; END IF;
  v_next_chunk := coalesce((SELECT max(chunk_ordinal) FROM public.notification_digest_groups
                            WHERE canonical_group_key = g.canonical_group_key), g.chunk_ordinal);

  FOR m IN SELECT id FROM public.notification_outbox WHERE digest_group_id = p_group_id AND status = 'pending'
           ORDER BY created_at, id LOOP
    IF v_child IS NULL OR v_in_child >= p_max_items_per_child THEN
      v_next_chunk := v_next_chunk + 1; v_children := v_children + 1; v_in_child := 0;
      INSERT INTO public.notification_digest_groups
        (parent_group_id, canonical_group_key, group_key_hash, chunk_ordinal, channel, event_type, recipient_key,
         destination_fingerprint, tenant_academy_profile_id, tenant_trainer_id, recipient_timezone,
         digest_boundary_at, available_at, state)
      VALUES (p_group_id, g.canonical_group_key, g.group_key_hash, v_next_chunk, g.channel, g.event_type,
              g.recipient_key, g.destination_fingerprint, g.tenant_academy_profile_id, g.tenant_trainer_id,
              g.recipient_timezone, g.digest_boundary_at, p_now, 'pending')
      RETURNING id INTO v_child;
      PERFORM notif_digest_ledger(p_run_id, v_child, NULL, 'materialized', 0);
    END IF;
    UPDATE public.notification_outbox SET digest_group_id = v_child, updated_at = p_now WHERE id = m.id;
    v_in_child := v_in_child + 1;
    UPDATE public.notification_digest_groups SET item_count = v_in_child, updated_at = p_now WHERE id = v_child;
  END LOOP;

  -- original: members moved out → superseded (excluded from groups_touched; lineage recorded).
  UPDATE public.notification_digest_groups
     SET state = 'superseded', superseded_by = NULL, item_count = 0, locked_by = NULL, locked_at = NULL, updated_at = p_now
   WHERE id = p_group_id;
  PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'superseded', 0);
  RETURN v_children;
END $$;

-- ===========================================================================
-- §P4 — store (ownership-gated, from prepared): freeze the request + hash, set the reused idempotency key,
-- → request_ready, available_at = now (immediately due).
CREATE OR REPLACE FUNCTION public.store_notification_digest_request(
    p_run_id uuid, p_group_id uuid, p_worker text, p_frozen_request jsonb, p_request_hash text, p_now timestamptz)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int;
BEGIN
  UPDATE public.notification_digest_groups
     SET frozen_request = p_frozen_request, request_hash = p_request_hash,
         provider_idempotency_key = 'dg:v1:' || p_group_id::text,
         state = 'request_ready', available_at = p_now, updated_at = p_now
   WHERE id = p_group_id AND state = 'prepared' AND locked_by = p_worker;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'store: group % not owned/prepared by %', p_group_id, p_worker; END IF;
  PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'request_ready', 0);
END $$;

-- ===========================================================================
-- §P5 — begin attempt (ownership-gated, from request_ready). Runs the full pre-send gauntlet, then INSERTs
-- the attempt row, binds current_attempt_id (+ the breaker probe if this is it), consumes budget + capacity,
-- and → sending. Returns the new attempt_id, or NULL if the group was deferred/finalized (no send).
CREATE OR REPLACE FUNCTION public.begin_notification_digest_attempt(
    p_run_id uuid, p_group_id uuid, p_worker text, p_now timestamptz,
    p_hour_cap int DEFAULT 1000, p_day_cap int DEFAULT 5000, p_uncertainty_hours int DEFAULT 23)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g record; v_attempt uuid; v_survivors int; v_bump timestamptz;
  v_hb timestamptz; v_db timestamptz; v_hkey text; v_dkey text; v_hgate text; v_dgate text;
  v_breaker record;
BEGIN
  SELECT * INTO g FROM public.notification_digest_groups
   WHERE id = p_group_id AND state = 'request_ready' AND locked_by = p_worker FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'begin: group % not owned/request_ready by %', p_group_id, p_worker; END IF;

  -- uncertainty age-out → delivery_unknown (never re-sent past the 23 h window).
  IF g.uncertain_since IS NOT NULL AND g.uncertain_deadline_at IS NOT NULL AND p_now >= g.uncertain_deadline_at THEN
    PERFORM notif_digest_finalize_group(p_group_id, 'delivery_unknown', 'uncertain_age_out', p_now);
    PERFORM notif_digest_commit_reservations(p_group_id, p_now);
    PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'delivery_unknown', 0);
    RETURN NULL;
  END IF;

  -- whole-group stop (§PS): no pending survivors left → retry_stopped.
  SELECT count(*) INTO v_survivors FROM public.notification_outbox
   WHERE digest_group_id = p_group_id AND status = 'pending';
  IF v_survivors = 0 THEN
    PERFORM notif_digest_finalize_group(p_group_id, 'retry_stopped', 'no_survivors', p_now);
    PERFORM notif_digest_release_reservations(p_group_id, p_now);
    PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'retry_stopped', 0);
    RETURN NULL;
  END IF;

  -- breaker gate: open (pre-retry) or half_open blocks non-probe groups; the probe group proceeds.
  SELECT * INTO v_breaker FROM public.notification_provider_circuit WHERE channel = g.channel;
  IF FOUND AND v_breaker.state IN ('open','half_open') AND v_breaker.probe_group_id IS DISTINCT FROM p_group_id THEN
    IF v_breaker.state = 'open' AND v_breaker.retry_at IS NOT NULL AND p_now >= v_breaker.retry_at THEN
      NULL;  -- breaker is due to probe, but this is not the probe group → still defer
    END IF;
    UPDATE public.notification_digest_groups SET available_at = p_now + interval '5 minutes', updated_at = p_now WHERE id = p_group_id;
    PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'deferred', 0);
    RETURN NULL;
  END IF;

  -- quiet hours: bump + defer.
  v_bump := notif_digest_quiet_hours_bump(p_now, g.recipient_timezone);
  IF v_bump > p_now THEN
    UPDATE public.notification_digest_groups SET available_at = v_bump, updated_at = p_now WHERE id = p_group_id;
    PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'deferred', 0);
    RETURN NULL;
  END IF;

  -- budget bound: exhausted while uncertain → awaiting_evidence (committed); else → retry_stopped.
  IF g.delivery_budget_used >= g.max_delivery_budget THEN
    IF g.uncertain_since IS NOT NULL THEN
      PERFORM notif_digest_commit_reservations(p_group_id, p_now);
      UPDATE public.notification_digest_groups
         SET state = 'awaiting_evidence', available_at = coalesce(uncertain_deadline_at, p_now), locked_by = NULL, locked_at = NULL, updated_at = p_now
       WHERE id = p_group_id;
      PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'awaiting_evidence', 0);
    ELSE
      PERFORM notif_digest_finalize_group(p_group_id, 'retry_stopped', 'budget_exhausted', p_now);
      PERFORM notif_digest_release_reservations(p_group_id, p_now);
      PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'retry_stopped', 0);
    END IF;
    RETURN NULL;
  END IF;

  -- capacity gate (hour + day buckets) BEFORE inserting the attempt (no dangling attempt on cap-full).
  v_hb := date_trunc('hour', p_now); v_db := date_trunc('day', p_now);
  v_hkey := notif_digest_counter_key(g.channel, g.event_type, g.destination_fingerprint, 'hour', v_hb);
  v_dkey := notif_digest_counter_key(g.channel, g.event_type, g.destination_fingerprint, 'day', v_db);
  v_hgate := notif_digest_bucket_gate(p_group_id, v_hkey, 'hour', v_hb, p_hour_cap);
  v_dgate := notif_digest_bucket_gate(p_group_id, v_dkey, 'day', v_db, p_day_cap);
  IF v_hgate = 'full' OR v_dgate = 'full' THEN
    IF g.uncertain_since IS NOT NULL THEN
      PERFORM notif_digest_commit_reservations(p_group_id, p_now);
      UPDATE public.notification_digest_groups
         SET state = 'awaiting_evidence', available_at = coalesce(uncertain_deadline_at, p_now), locked_by = NULL, locked_at = NULL, updated_at = p_now
       WHERE id = p_group_id;
      PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'awaiting_evidence', 0);
    ELSE
      UPDATE public.notification_digest_groups SET available_at = p_now + interval '10 minutes', updated_at = p_now WHERE id = p_group_id;
      PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'deferred_cap', 0);
    END IF;
    RETURN NULL;
  END IF;

  -- COMMIT the attempt: insert row, apply fresh reservations, bind current + probe, consume budget → sending.
  v_attempt := gen_random_uuid();
  INSERT INTO public.notification_digest_attempts (attempt_id, digest_group_id, worker_run_id, provider_idempotency_key)
  VALUES (v_attempt, p_group_id, p_run_id, g.provider_idempotency_key);
  IF v_hgate = 'available' THEN PERFORM notif_digest_bucket_apply(p_group_id, v_hkey, v_attempt, v_hb, p_now); END IF;
  IF v_dgate = 'available' THEN PERFORM notif_digest_bucket_apply(p_group_id, v_dkey, v_attempt, v_db, p_now); END IF;

  UPDATE public.notification_digest_groups
     SET current_attempt_id = v_attempt, state = 'sending',
         provider_attempts_started = provider_attempts_started + 1,
         delivery_budget_used = delivery_budget_used + 1,
         first_send_at = coalesce(first_send_at, p_now), updated_at = p_now
   WHERE id = p_group_id;

  -- if this group is the breaker probe, bind probe_attempt_id to this (fresh or replacement) attempt.
  UPDATE public.notification_provider_circuit SET probe_attempt_id = v_attempt
   WHERE channel = g.channel AND probe_group_id = p_group_id;

  PERFORM notif_digest_ledger(p_run_id, p_group_id, v_attempt, 'attempt', 0);
  RETURN v_attempt;
END $$;

-- ===========================================================================
-- §CB — breaker trip + monotonic provider-status apply helpers.
CREATE OR REPLACE FUNCTION public.notif_digest_trip_breaker(p_channel text, p_reason text, p_retry_at timestamptz, p_now timestamptz)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.notification_provider_circuit (channel, state, reason, tripped_at, retry_at)
  VALUES (p_channel, 'open', p_reason, p_now, p_retry_at)
  ON CONFLICT (channel) DO UPDATE SET state = 'open', reason = p_reason, tripped_at = p_now,
    retry_at = p_retry_at, probe_group_id = NULL, probe_attempt_id = NULL, probe_locked_at = NULL;
END $$;

-- advance the group's provider_status ONLY if the incoming rank is strictly higher (monotonic; the guard
-- also rejects a regress). Returns nothing; leaves lower/equal ranks untouched.
CREATE OR REPLACE FUNCTION public.notif_digest_advance_provider_status(p_group_id uuid, p_status text, p_now timestamptz)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_new int;
BEGIN
  v_new := notif_digest_provider_rank(p_status);
  UPDATE public.notification_digest_groups
     SET provider_status = p_status, provider_status_rank = v_new, updated_at = p_now
   WHERE id = p_group_id AND v_new > provider_status_rank;
END $$;

-- ===========================================================================
-- §P6 — record (idempotent by attempt_id; §ERR mapping). Writes the attempt outcome, then transitions the
-- group per the outcome class + sticky uncertainty + reservations + scrub + (probe-only) breaker.
CREATE OR REPLACE FUNCTION public.record_notification_digest_result(
    p_run_id uuid, p_attempt_id uuid, p_transport text, p_http_status int, p_error_name text,
    p_provider_message_id text, p_now timestamptz, p_retry_after_seconds int DEFAULT NULL,
    p_uncertainty_hours int DEFAULT 23)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a record; g record; v_class text; v_is_current boolean; v_is_probe boolean;
  v_backoff timestamptz; v_deadline timestamptz; v_n int;
BEGIN
  v_class := notif_digest_classify_error(p_transport, p_http_status, p_error_name);
  SELECT * INTO a FROM public.notification_digest_attempts WHERE attempt_id = p_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'record: attempt % not found', p_attempt_id; END IF;
  IF a.recorded_at IS NOT NULL THEN RETURN a.outcome_class; END IF;   -- idempotent replay

  SELECT * INTO g FROM public.notification_digest_groups WHERE id = a.digest_group_id FOR UPDATE;

  -- write the attempt outcome (the only permitted attempt mutation: NULL→recorded).
  UPDATE public.notification_digest_attempts
     SET recorded_at = p_now, outcome_class = v_class, resend_error_name = p_error_name,
         http_status = p_http_status, provider_message_id = p_provider_message_id
   WHERE attempt_id = p_attempt_id AND recorded_at IS NULL;

  v_is_current := (g.current_attempt_id = p_attempt_id);
  v_is_probe := EXISTS (SELECT 1 FROM public.notification_provider_circuit WHERE channel = g.channel AND probe_attempt_id = p_attempt_id);
  v_backoff := p_now + make_interval(mins => least(power(2, greatest(g.provider_attempts_started,1))::int, 60));
  v_deadline := coalesce(g.uncertain_deadline_at, p_now + make_interval(hours => p_uncertainty_hours));

  -- breaker transition FIRST (only the bound probe attempt may move the breaker).
  IF v_is_probe THEN
    IF v_class = 'accepted' OR v_class = 'retryable_definite' OR v_class = 'terminal' THEN
      UPDATE public.notification_provider_circuit SET state = 'closed', reason = NULL, retry_at = NULL,
        probe_group_id = NULL, probe_attempt_id = NULL, probe_locked_at = NULL WHERE channel = g.channel;
    ELSIF v_class = 'global_config' THEN
      PERFORM notif_digest_trip_breaker(g.channel, 'probe_global_config', p_now + interval '15 minutes', p_now);
    ELSIF v_class = 'ambiguous' THEN
      PERFORM notif_digest_trip_breaker(g.channel, 'probe_ambiguous', p_now + interval '2 minutes', p_now);
    END IF;
  END IF;

  -- ACCEPTED: positive acceptance monotonically completes the group (even if a newer attempt owns it),
  -- unless a rank≥3 provider outcome already resolved it (then keep that; just clear uncertainty).
  IF v_class = 'accepted' THEN
    IF p_provider_message_id IS NOT NULL AND g.provider_message_id IS NULL THEN
      UPDATE public.notification_digest_groups SET provider_message_id = p_provider_message_id, updated_at = p_now WHERE id = g.id;
    END IF;
    PERFORM notif_digest_advance_provider_status(g.id, 'sent', p_now);   -- rank 1, never regresses ≥2
    IF g.provider_status_rank < 3 AND g.state NOT IN ('sent','failed_terminal','oversize_failed') THEN
      PERFORM notif_digest_commit_reservations(g.id, p_now);
      PERFORM notif_digest_finalize_group(g.id, 'sent', 'accepted', p_now);
    ELSE
      UPDATE public.notification_digest_groups SET uncertain_since = NULL, uncertain_deadline_at = NULL, updated_at = p_now WHERE id = g.id;
    END IF;
    UPDATE public.notification_digest_groups SET uncertain_since = NULL, uncertain_deadline_at = NULL WHERE id = g.id;
    PERFORM notif_digest_ledger(p_run_id, g.id, p_attempt_id, 'sent', 0);
    RETURN v_class;
  END IF;

  -- Non-accepted → annotate the attempt only (no group change) if the attempt is STALE (a newer attempt owns
  -- the group) OR the group already reached a TERMINAL state (e.g. a late accepted or a provider event
  -- resolved it). Only the current attempt of a still-live group drives a non-accepted transition.
  IF NOT v_is_current OR g.state = ANY(notif_digest_terminal_states()) THEN
    PERFORM notif_digest_ledger(p_run_id, g.id, p_attempt_id, notif_digest_action_for_class(v_class), 0);
    RETURN v_class;
  END IF;

  -- current attempt, non-accepted outcomes:
  IF v_class = 'retryable_definite' THEN
    IF g.uncertain_since IS NULL THEN PERFORM notif_digest_release_reservations(g.id, p_now);
    ELSE PERFORM notif_digest_commit_reservations(g.id, p_now); END IF;
    UPDATE public.notification_digest_groups
       SET state = 'request_ready', locked_by = NULL, locked_at = NULL, current_attempt_id = NULL,
           available_at = greatest(coalesce(p_now + make_interval(secs => p_retry_after_seconds), v_backoff), v_backoff), updated_at = p_now
     WHERE id = g.id;
    PERFORM notif_digest_ledger(p_run_id, g.id, p_attempt_id, 'retryable', 0);

  ELSIF v_class = 'ambiguous' THEN
    PERFORM notif_digest_commit_reservations(g.id, p_now);   -- never released while uncertain
    UPDATE public.notification_digest_groups
       SET state = 'request_ready', uncertain_since = coalesce(uncertain_since, p_now),
           uncertain_deadline_at = coalesce(uncertain_deadline_at, v_deadline),
           locked_by = NULL, locked_at = NULL, current_attempt_id = NULL, available_at = v_backoff, updated_at = p_now
     WHERE id = g.id;
    PERFORM notif_digest_ledger(p_run_id, g.id, p_attempt_id, 'ambiguous', 0);

  ELSIF v_class = 'global_config' THEN
    IF g.uncertain_since IS NULL THEN PERFORM notif_digest_release_reservations(g.id, p_now);
    ELSE PERFORM notif_digest_commit_reservations(g.id, p_now); END IF;
    IF NOT v_is_probe THEN PERFORM notif_digest_trip_breaker(g.channel, 'global_config', p_now + interval '15 minutes', p_now); END IF;
    UPDATE public.notification_digest_groups
       SET state = 'request_ready', delivery_budget_used = greatest(delivery_budget_used - 1, 0),
           locked_by = NULL, locked_at = NULL, current_attempt_id = NULL, available_at = p_now + interval '15 minutes', updated_at = p_now
     WHERE id = g.id;
    PERFORM notif_digest_ledger(p_run_id, g.id, p_attempt_id, 'global_config', 0);

  ELSIF v_class = 'terminal' THEN
    IF g.uncertain_since IS NOT NULL THEN
      PERFORM notif_digest_commit_reservations(g.id, p_now);
      UPDATE public.notification_digest_groups
         SET state = 'awaiting_evidence', available_at = coalesce(uncertain_deadline_at, v_deadline),
             locked_by = NULL, locked_at = NULL, current_attempt_id = NULL, updated_at = p_now
       WHERE id = g.id;
      PERFORM notif_digest_ledger(p_run_id, g.id, p_attempt_id, 'awaiting_evidence', 0);
    ELSE
      PERFORM notif_digest_release_reservations(g.id, p_now);
      PERFORM notif_digest_finalize_group(g.id, 'failed_terminal', coalesce(p_error_name, 'terminal'), p_now);
      PERFORM notif_digest_ledger(p_run_id, g.id, p_attempt_id, 'terminal', 0);
    END IF;
  END IF;
  RETURN v_class;
END $$;

-- ===========================================================================
-- §PV — apply a provider callback (orphan-then-link, at-least-once/unordered safe, monotonic rank). Does the
-- SQL state transition (group dispatch + member + reservation + rank); the record_email_event/suppression
-- side effects belong to the webhook adapter (10c-a3). Idempotent by resend_event_id.
CREATE OR REPLACE FUNCTION public.apply_notification_provider_event(
    p_run_id uuid, p_resend_event_id text, p_provider_message_id text, p_digest_group_id uuid,
    p_status text, p_occurred_at timestamptz, p_now timestamptz)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g record; v_rank int; v_group_id uuid; v_inserted boolean := false; v_member_status text;
BEGIN
  -- correlate: explicit tag, else the group holding this provider_message_id.
  v_group_id := p_digest_group_id;
  IF v_group_id IS NULL THEN
    SELECT id INTO v_group_id FROM public.notification_digest_groups WHERE provider_message_id = p_provider_message_id;
  END IF;

  -- append the event (globally idempotent by resend_event_id; orphan if still uncorrelated).
  INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, digest_group_id, status, occurred_at, received_at)
  VALUES (p_resend_event_id, p_provider_message_id, v_group_id, p_status, p_occurred_at, p_now)
  ON CONFLICT (resend_event_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF NOT v_inserted THEN RETURN 'duplicate'; END IF;   -- webhook double-delivery → no double-apply
  IF v_group_id IS NULL THEN RETURN 'orphan'; END IF;  -- no group yet; link later via link_notification_provider_event

  SELECT * INTO g FROM public.notification_digest_groups WHERE id = v_group_id FOR UPDATE;
  v_rank := notif_digest_provider_rank(p_status);

  -- monotonic: a lower/equal-rank callback never regresses the resolution — only the event is recorded.
  IF v_rank IS NULL OR v_rank <= g.provider_status_rank THEN
    PERFORM notif_digest_ledger(p_run_id, v_group_id, NULL, 'sent', 0);
    RETURN 'noop_rank';
  END IF;

  PERFORM notif_digest_advance_provider_status(v_group_id, p_status, p_now);
  PERFORM notif_digest_commit_reservations(v_group_id, p_now);   -- capacity was consumed by a real dispatch

  IF p_status IN ('sent','delivery_delayed','delivered','complained') THEN
    -- positive acceptance / proven delivery → dispatch resolves to sent (overrides delivery_unknown/awaiting_evidence).
    IF g.state NOT IN ('sent') THEN
      PERFORM notif_digest_finalize_group(v_group_id, 'sent', p_status, p_now);
    END IF;
    PERFORM notif_digest_ledger(p_run_id, v_group_id, NULL, 'sent', 0);
    RETURN 'sent';
  ELSE
    -- bounced / failed / suppressed → proven non-delivery → failed_terminal (member failed, or cancelled for
    -- suppressed). Non-delivery is stronger than a prior accept, so a 'sent' member is flipped too; only a
    -- confirmed 'delivered' or an already-final failure/skip/cancel is left as-is.
    v_member_status := CASE WHEN p_status = 'suppressed' THEN 'cancelled' ELSE 'failed' END;
    UPDATE public.notification_outbox
       SET status = v_member_status, skip_reason = coalesce(skip_reason, p_status), payload = NULL, digest_item = NULL, updated_at = p_now
     WHERE digest_group_id = v_group_id AND status NOT IN ('delivered','failed','skipped','cancelled');
    UPDATE public.notification_digest_groups
       SET state = 'failed_terminal', terminal_reason = coalesce(terminal_reason, p_status),
           frozen_request = NULL, locked_by = NULL, locked_at = NULL, uncertain_since = NULL, updated_at = p_now
     WHERE id = v_group_id;
    PERFORM notif_digest_ledger(p_run_id, v_group_id, NULL, 'terminal', 0);
    RETURN 'failed_terminal';
  END IF;
END $$;

-- ===========================================================================
-- §SWEEP — operator-facing standalone sweep: age-out due awaiting_evidence groups (→ delivery_unknown) and
-- re-arm half-open breakers whose bound probe lease has expired (crash-before/after-HTTP recovery). Bounded.
CREATE OR REPLACE FUNCTION public.reconcile_notification_digest_stale(
    p_run_id uuid, p_channel text, p_now timestamptz, p_probe_lease_minutes int DEFAULT 10, p_limit int DEFAULT 500)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g record; v_n int := 0;
BEGIN
  -- awaiting_evidence age-out (§AE / §P1): capacity stays committed; members finalized delivery_unknown.
  FOR g IN SELECT id FROM public.notification_digest_groups
            WHERE channel = p_channel AND state = 'awaiting_evidence' AND available_at <= p_now
            ORDER BY available_at LIMIT greatest(p_limit, 0) FOR UPDATE SKIP LOCKED LOOP
    PERFORM notif_digest_finalize_group(g.id, 'delivery_unknown', 'age_out', p_now);
    PERFORM notif_digest_commit_reservations(g.id, p_now);
    PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'delivery_unknown', 0);
    v_n := v_n + 1;
  END LOOP;

  -- half-open breaker whose probe made no breaker-transitioning record within the lease → re-arm to open.
  UPDATE public.notification_provider_circuit
     SET state = 'open', probe_group_id = NULL, probe_attempt_id = NULL, probe_locked_at = NULL,
         retry_at = p_now + interval '1 minute', reason = coalesce(reason, 'probe_lease_expired')
   WHERE channel = p_channel AND state = 'half_open'
     AND probe_locked_at IS NOT NULL AND probe_locked_at < p_now - make_interval(mins => p_probe_lease_minutes);
  RETURN v_n;
END $$;

-- ===========================================================================
-- §13. ACL. Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE ON FUNCTIONS to anon/authenticated/service_role,
-- so a bare GRANT is not restrictive. REVOKE every state-machine function from PUBLIC/anon/authenticated and
-- GRANT EXECUTE to service_role only (by exact signature, all overloads).
DO $acl$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'notif_digest_%' OR p.proname IN (
         'start_notification_worker_run','finish_notification_worker_run',
         'materialize_notification_digest_groups','claim_notification_digest_group',
         'prepare_notification_digest_group','split_notification_digest_group',
         'store_notification_digest_request','begin_notification_digest_attempt',
         'record_notification_digest_result','reconcile_notification_digest_run',
         'reconcile_notification_digest_stale','apply_notification_provider_event'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $acl$;
