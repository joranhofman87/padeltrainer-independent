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
-- §0b. outbox canonical-key hash — the SINGLE source for grouping identity, shared by the stamping trigger,
-- the materializer, and the member-scan index. Same-key member lookup is O(index) instead of a computed-key
-- full scan/sort (the real expensive query at 100k same-boundary rows).
CREATE OR REPLACE FUNCTION public.notif_digest_canonical_key(
    p_channel text, p_recipient_key text, p_destination_fingerprint text, p_tenant_academy uuid,
    p_tenant_trainer uuid, p_event_type text, p_template_key text, p_template_version int,
    p_group_locale text, p_digest_frequency text, p_recipient_timezone text, p_digest_boundary_at timestamptz)
  RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  -- v2: recipient_timezone IS identity (Amsterdam and Tokyo recipients must never collapse into one
  -- group), and the boundary is EPOCH SECONDS — a raw timestamptz in jsonb serializes via the SESSION
  -- timezone, so two sessions under different SET TIME ZONE would mint different keys for one instant.
  SELECT jsonb_build_array('v2', p_channel, p_recipient_key, p_destination_fingerprint,
    p_tenant_academy, p_tenant_trainer, p_event_type, p_template_key, p_template_version,
    p_group_locale, p_digest_frequency, p_recipient_timezone,
    extract(epoch from p_digest_boundary_at)::bigint) $$;

ALTER TABLE public.notification_outbox ADD COLUMN IF NOT EXISTS digest_group_hash text;

-- stamp the hash on every digest row (INSERT, or the moment delivery_mode becomes 'digest'); the snapshot
-- guard makes it write-once thereafter.
CREATE OR REPLACE FUNCTION public.notification_outbox_digest_hash_stamp() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.delivery_mode = 'digest' AND (TG_OP = 'INSERT' OR NEW.digest_group_hash IS NULL) THEN
    -- ALWAYS server-derived on INSERT: a caller-supplied hash is overwritten, never trusted.
    NEW.digest_group_hash := encode(sha256(notif_digest_canonical_key(
      NEW.channel, NEW.recipient_key, NEW.destination_fingerprint, NEW.tenant_academy_profile_id,
      NEW.tenant_trainer_id, NEW.event_type, NEW.template_key, NEW.template_version,
      NEW.group_locale, NEW.digest_frequency, NEW.recipient_timezone, NEW.digest_boundary_at)::text::bytea), 'hex');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_outbox_digest_hash_stamp ON public.notification_outbox;
CREATE TRIGGER trg_outbox_digest_hash_stamp BEFORE INSERT OR UPDATE ON public.notification_outbox
  FOR EACH ROW EXECUTE FUNCTION public.notification_outbox_digest_hash_stamp();

-- backfill any pre-existing digest rows (prod has none — the engine is inert — but keep the chain total).
UPDATE public.notification_outbox o
   SET digest_group_hash = encode(sha256(notif_digest_canonical_key(
     o.channel, o.recipient_key, o.destination_fingerprint, o.tenant_academy_profile_id,
     o.tenant_trainer_id, o.event_type, o.template_key, o.template_version,
     o.group_locale, o.digest_frequency, o.recipient_timezone, o.digest_boundary_at)::text::bytea), 'hex')
 WHERE o.delivery_mode = 'digest' AND o.digest_group_hash IS NULL;

-- the member-scan index: equality on the hash + the deterministic member order → pure index scan, no sort.
CREATE INDEX IF NOT EXISTS idx_outbox_digest_member_scan
  ON public.notification_outbox (digest_group_hash, created_at, id)
  WHERE delivery_mode = 'digest' AND digest_group_id IS NULL AND status = 'pending';

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

-- run-identity assertion (used by EVERY state-changing RPC): the run must exist, be UNFINISHED, and match
-- the expected phase + channel — a null/finished/wrong-phase/wrong-channel/unrelated run id would make the
-- ledger (and causal reconciliation) confidently attribute work to the wrong run.
CREATE OR REPLACE FUNCTION public.notif_digest_assert_run(p_run_id uuid, p_phase text, p_channel text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  IF p_run_id IS NULL THEN RAISE EXCEPTION 'worker run id is required'; END IF;
  -- FOR UPDATE: the run row is held for the transition's whole transaction, so a concurrent
  -- finish_notification_worker_run serializes AFTER it (and a finished run can never own an in-flight one).
  SELECT * INTO r FROM public.notification_worker_runs WHERE run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'worker run % not found', p_run_id; END IF;
  IF r.ended_at IS NOT NULL THEN RAISE EXCEPTION 'worker run % is already finished', p_run_id; END IF;
  IF p_phase IS NOT NULL AND r.phase <> p_phase THEN
    RAISE EXCEPTION 'worker run % has phase %, expected %', p_run_id, r.phase, p_phase; END IF;
  IF p_channel IS NOT NULL AND r.channel <> p_channel THEN
    RAISE EXCEPTION 'worker run % has channel %, expected %', p_run_id, r.channel, p_channel; END IF;
END $$;

-- ===========================================================================
-- §CAPS — attempt-aware reservation/cap helpers (never release while uncertain). counter_key is per
-- destination + bucket. A reservation carries the ORIGINATING attempt_id (immutable across reuse).
CREATE OR REPLACE FUNCTION public.notif_digest_counter_key(
    p_channel text, p_event_type text, p_fingerprint text, p_bucket_kind text, p_bucket_start timestamptz)
  RETURNS text LANGUAGE sql IMMUTABLE AS $$
  -- epoch seconds: timestamptz::text depends on the SESSION timezone — two workers under different
  -- SET TIME ZONE would mint different keys for the same bucket and split the cap.
  SELECT p_channel||':'||p_event_type||':'||p_fingerprint||':'||p_bucket_kind||':'
         ||extract(epoch from p_bucket_start)::bigint::text $$;

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
-- §RECON — reconcile_notification_digest_run: CAUSAL — the 'group' family reports the state THIS run drove
-- each group to (its LAST ledger action within this run), not the group's later current state, so a group
-- another run completed is never attributed to an earlier run. 'superseded' is its own lineage metric
-- (excluded from groups_touched by summing the non-superseded rows); non-final actions roll up to 'in_flight'.
CREATE OR REPLACE FUNCTION public.reconcile_notification_digest_run(p_run_id uuid)
  RETURNS TABLE (family text, metric text, count int) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.notification_worker_runs w WHERE w.run_id = p_run_id) THEN
    RAISE EXCEPTION 'reconcile: worker run % not found', p_run_id;
  END IF;
  RETURN QUERY
  -- family 'event': raw ledger action counts (repeated deferrals are distinct events; attempt==provider sends)
  SELECT 'event'::text, l.action, count(*)::int
    FROM public.notification_digest_group_attempts l WHERE l.worker_run_id = p_run_id GROUP BY l.action
  UNION ALL
  -- family 'group': causal — the LAST action this run logged per group, mapped to its outcome metric.
  SELECT 'group'::text, outcome, count(*)::int FROM (
    SELECT DISTINCT ON (l.digest_group_id)
           CASE WHEN l.action IN ('sent','no_work','superseded','delivery_unknown','retry_stopped',
                                  'oversize_failed','awaiting_evidence') THEN l.action
                WHEN l.action = 'terminal' THEN 'failed_terminal'
                ELSE 'in_flight' END AS outcome
      FROM public.notification_digest_group_attempts l
     WHERE l.worker_run_id = p_run_id
     ORDER BY l.digest_group_id, l.seq DESC) last_actions
  GROUP BY outcome;
END $$;

-- ===========================================================================
-- §MAT — Phase A materialize (concurrency-safe + bounded). One canonical key per outer iteration:
--   (1) pick the EARLIEST unassigned candidate via the forming partial index (Index Scan + LIMIT 1,
--       FOR UPDATE SKIP LOCKED — concurrent materializers skip each other's rows, never re-point);
--   (2) advisory-xact-lock the key hash (serializes chunk numbering per key across materializers);
--   (3) lock + chunk that key's members (bounded LIMIT, FOR UPDATE SKIP LOCKED), assigning each with a
--       CONDITIONAL count-checked update (digest_group_id IS NULL) — a member joins exactly one group.
-- Work per call is bounded by p_max_groups + p_max_members_per_call + a hard outer-iteration cap; there is
-- no global ORDER BY over a computed key (the old full-scan+sort), no OFFSET, no unbounded loop.
CREATE OR REPLACE FUNCTION public.materialize_notification_digest_groups(
    p_run_id uuid, p_channel text, p_now timestamptz, p_max_groups int, p_max_members_per_call int)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_budget int := 92160;                 -- ~90 KB cumulative byte budget per group
  v_groups int := 0; v_members int := 0; v_iter int := 0; v_lock_skips int := 0;
  cand record; m record;
  v_ckey jsonb; v_hash text; v_group uuid; v_count int; v_bytes int; v_next_chunk int; v_n int;
BEGIN
  PERFORM notif_digest_assert_run(p_run_id, 'materialize', p_channel);
  LOOP
    v_iter := v_iter + 1;
    EXIT WHEN v_groups >= p_max_groups OR v_members >= p_max_members_per_call
           OR v_iter > (2 * greatest(p_max_groups, 1) + 8);   -- hard bound: never unbounded
    -- (1) earliest unassigned candidate — Index Scan on idx_outbox_digest_forming, one row.
    -- ORDER BY the index prefix ONLY (channel, digest_boundary_at): with LIMIT 1 this is a pure index scan —
    -- no sort over same-boundary ties. Any due candidate is fine (the per-key member query below imposes the
    -- deterministic created_at,id order WITHIN the key); earliest-boundary keys still drain first.
    SELECT o.id, o.recipient_key, o.destination_fingerprint, o.event_type, o.template_key, o.template_version,
           o.group_locale, o.digest_frequency, o.digest_boundary_at, o.tenant_academy_profile_id,
           o.tenant_trainer_id, o.digest_group_hash, coalesce(o.recipient_timezone,'Europe/Amsterdam') AS tz
      INTO cand
      FROM public.notification_outbox o
     WHERE o.channel = p_channel AND o.delivery_mode = 'digest'
       AND o.digest_group_id IS NULL AND o.status = 'pending'
     ORDER BY o.digest_boundary_at
     LIMIT 1 FOR UPDATE SKIP LOCKED;
    EXIT WHEN NOT FOUND;

    v_ckey := notif_digest_canonical_key(p_channel, cand.recipient_key, cand.destination_fingerprint,
      cand.tenant_academy_profile_id, cand.tenant_trainer_id, cand.event_type, cand.template_key,
      cand.template_version, cand.group_locale, cand.digest_frequency, cand.tz, cand.digest_boundary_at);
    v_hash := coalesce(cand.digest_group_hash, encode(sha256(v_ckey::text::bytea), 'hex'));
    -- (2) NONBLOCKING per-key serialization: a busy key means another materializer owns it right now —
    -- skip it (its members complete there or on the next call). Blocking acquisition of MULTIPLE keys per
    -- transaction could deadlock two materializers acquiring in opposite order; try-lock cannot.
    IF NOT pg_try_advisory_xact_lock(hashtext(v_hash)) THEN
      v_lock_skips := v_lock_skips + 1;
      IF v_lock_skips >= 3 THEN EXIT; END IF;   -- persistent contention → yield; the next call resumes
      CONTINUE;
    END IF;
    v_next_chunk := coalesce((SELECT max(chunk_ordinal) FROM public.notification_digest_groups
                              WHERE canonical_group_key = v_ckey), -1);
    v_group := NULL; v_count := 0; v_bytes := 0;

    -- (3) this key's members, bounded + locked; chunk into ≤50-item / ≤budget groups.
    FOR m IN
      SELECT o.id, coalesce(o.digest_item_bytes, 0) AS bytes
        FROM public.notification_outbox o
       WHERE o.digest_group_hash = v_hash                      -- index equality (idx_outbox_digest_member_scan)
         AND o.channel = p_channel AND o.delivery_mode = 'digest'
         AND o.digest_group_id IS NULL AND o.status = 'pending'
         -- exact-field checks retained: a (theoretical) hash collision must never co-mingle keys
         AND o.recipient_key = cand.recipient_key AND o.destination_fingerprint = cand.destination_fingerprint
         AND o.digest_boundary_at = cand.digest_boundary_at
         AND o.event_type IS NOT DISTINCT FROM cand.event_type
         AND o.template_key IS NOT DISTINCT FROM cand.template_key
         AND o.template_version IS NOT DISTINCT FROM cand.template_version
         AND o.group_locale IS NOT DISTINCT FROM cand.group_locale
         AND o.digest_frequency IS NOT DISTINCT FROM cand.digest_frequency
         AND o.tenant_academy_profile_id IS NOT DISTINCT FROM cand.tenant_academy_profile_id
         AND o.tenant_trainer_id IS NOT DISTINCT FROM cand.tenant_trainer_id
         AND coalesce(o.recipient_timezone,'Europe/Amsterdam') = cand.tz
       ORDER BY o.created_at, o.id
       LIMIT greatest(p_max_members_per_call - v_members, 1)
       FOR UPDATE SKIP LOCKED
    LOOP
      -- raw single-item oversize: its own oversize_failed group (member finalized).
      IF m.bytes > v_budget THEN
        EXIT WHEN v_groups >= p_max_groups;
        v_next_chunk := v_next_chunk + 1;
        INSERT INTO public.notification_digest_groups
          (canonical_group_key, group_key_hash, chunk_ordinal, channel, event_type, recipient_key,
           destination_fingerprint, tenant_academy_profile_id, tenant_trainer_id, recipient_timezone,
           digest_boundary_at, available_at, state, item_count, total_item_bytes, terminal_reason)
        VALUES (v_ckey, v_hash, v_next_chunk, p_channel, cand.event_type, cand.recipient_key,
                cand.destination_fingerprint, cand.tenant_academy_profile_id, cand.tenant_trainer_id, cand.tz,
                cand.digest_boundary_at, cand.digest_boundary_at, 'oversize_failed', 1, m.bytes, 'single_item_oversize')
        RETURNING id INTO v_group;
        UPDATE public.notification_outbox SET digest_group_id = v_group, status = 'failed',
               skip_reason = 'single_item_oversize', payload = NULL, digest_item = NULL, updated_at = p_now
         WHERE id = m.id AND digest_group_id IS NULL;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n <> 1 THEN RAISE EXCEPTION 'materialize: oversize member % re-point race', m.id; END IF;
        PERFORM notif_digest_ledger(p_run_id, v_group, NULL, 'oversize_failed', 1);
        v_groups := v_groups + 1; v_members := v_members + 1; v_group := NULL; v_count := 0; v_bytes := 0;
        CONTINUE;
      END IF;

      -- open a new chunk when none is open, the 50-item cap is hit, or the byte budget would overflow.
      IF v_group IS NULL OR v_count >= 50 OR (v_bytes + m.bytes) > v_budget THEN
        EXIT WHEN v_groups >= p_max_groups;
        v_next_chunk := v_next_chunk + 1;
        INSERT INTO public.notification_digest_groups
          (canonical_group_key, group_key_hash, chunk_ordinal, channel, event_type, recipient_key,
           destination_fingerprint, tenant_academy_profile_id, tenant_trainer_id, recipient_timezone,
           digest_boundary_at, available_at, state)
        VALUES (v_ckey, v_hash, v_next_chunk, p_channel, cand.event_type, cand.recipient_key,
                cand.destination_fingerprint, cand.tenant_academy_profile_id, cand.tenant_trainer_id, cand.tz,
                cand.digest_boundary_at, cand.digest_boundary_at, 'pending')
        RETURNING id INTO v_group;
        v_groups := v_groups + 1; v_count := 0; v_bytes := 0;
        PERFORM notif_digest_ledger(p_run_id, v_group, NULL, 'materialized', 0);
      END IF;

      -- conditional, count-checked assignment: a member joins exactly one group (locked + still unassigned).
      UPDATE public.notification_outbox SET digest_group_id = v_group, updated_at = p_now
       WHERE id = m.id AND digest_group_id IS NULL;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 1 THEN
        v_count := v_count + 1; v_bytes := v_bytes + m.bytes; v_members := v_members + 1;
        UPDATE public.notification_digest_groups SET item_count = v_count, total_item_bytes = v_bytes,
               updated_at = p_now WHERE id = v_group;
      END IF;
    END LOOP;

    -- defensive: an opened chunk that ended up with zero members (all conditional assigns lost) → no_work.
    IF v_group IS NOT NULL AND v_count = 0 THEN
      UPDATE public.notification_digest_groups SET state = 'no_work', terminal_reason = 'no_members', updated_at = p_now
       WHERE id = v_group;
      PERFORM notif_digest_ledger(p_run_id, v_group, NULL, 'no_work', 0);
    END IF;
  END LOOP;
  RETURN v_groups;
END $$;

-- ===========================================================================
-- §P1 — claim (breaker-PREFLIGHTED, quiet-hours, awaiting_evidence age-out, crash reclaim). Returns ONE
-- leased group id (or NULL). The breaker is evaluated ONCE before any group scan: a held/not-due open
-- circuit returns immediately (NO group writes, NO ledger churn — a manual hold must not rewrite
-- available_at across the backlog every poll); under half_open only the bound probe group is claimable;
-- open+due promotes exactly one candidate to the probe (CAS under the circuit row lock).
CREATE OR REPLACE FUNCTION public.claim_notification_digest_group(
    p_run_id uuid, p_channel text, p_now timestamptz, p_worker text, p_stale_minutes int DEFAULT 15)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g record; v_iter int := 0; v_bump timestamptz; v_cb record; v_promote boolean := false; v_n int;
BEGIN
  PERFORM notif_digest_assert_run(p_run_id, 'dispatch', p_channel);

  -- breaker preflight (one read; lock only when the state machine must move).
  SELECT * INTO v_cb FROM public.notification_provider_circuit WHERE channel = p_channel;
  IF FOUND AND v_cb.state = 'open' THEN
    IF v_cb.retry_at IS NULL OR p_now < v_cb.retry_at THEN RETURN NULL; END IF;  -- held / not due: no scan
    v_promote := true;                                       -- due → first claimable group becomes the probe
  ELSIF FOUND AND v_cb.state = 'half_open' THEN
    IF v_cb.probe_locked_at IS NOT NULL AND v_cb.probe_locked_at < p_now - make_interval(mins => p_stale_minutes) THEN
      -- stale probe lease (crash before/after HTTP) → re-arm under the row lock, then promote a fresh probe.
      UPDATE public.notification_provider_circuit SET state = 'open', probe_group_id = NULL,
             probe_attempt_id = NULL, probe_locked_at = NULL, retry_at = p_now
       WHERE channel = p_channel AND state = 'half_open'
         AND probe_locked_at IS NOT NULL AND probe_locked_at < p_now - make_interval(mins => p_stale_minutes);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 1 THEN v_promote := true; ELSE RETURN NULL; END IF;   -- someone else moved it → back off
    ELSIF v_cb.probe_group_id IS NOT NULL THEN
      -- only the bound probe is claimable; everything else waits (untouched — no deferral writes).
      SELECT * INTO g FROM public.notification_digest_groups
       WHERE id = v_cb.probe_group_id AND channel = p_channel
         AND state = 'request_ready' AND locked_by IS NULL AND available_at <= p_now
       FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN RETURN NULL; END IF;
      UPDATE public.notification_digest_groups
         SET locked_by = p_worker, locked_at = p_now, worker_run_id = p_run_id, updated_at = p_now
       WHERE id = g.id;
      PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'leased', 0);
      RETURN g.id;
    ELSE
      RETURN NULL;                                           -- half_open with no probe yet bound elsewhere
    END IF;
  END IF;

  LOOP  -- circuit closed, or open+due (v_promote): scan for work
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

    -- quiet hours: bump available_at (a genuine SCHEDULING change), do not claim.
    v_bump := notif_digest_quiet_hours_bump(p_now, g.recipient_timezone);
    IF v_bump > p_now THEN
      UPDATE public.notification_digest_groups SET available_at = v_bump, updated_at = p_now WHERE id = g.id;
      PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'deferred', 0);
      CONTINUE;
    END IF;

    -- open+due: promote THIS candidate to the probe — CAS under the circuit row lock, re-validated.
    IF v_promote THEN
      UPDATE public.notification_provider_circuit
         SET state = 'half_open', probe_group_id = g.id, probe_attempt_id = NULL, probe_locked_at = p_now
       WHERE channel = p_channel AND state = 'open' AND (retry_at IS NOT NULL AND p_now >= retry_at);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN RETURN NULL; END IF;   -- another worker promoted/re-tripped first → back off, no writes
      v_promote := false;
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
-- §PS — LIVE stop-check for one member (generic revalidation; the event-specific policy hook is 10c-b).
-- Re-resolves the CURRENT destination with the resolver's own semantics — the linked contact row (must
-- still exist, not revoked, not opted out) else the account email (persons.email) — and requires its
-- fingerprint to still match the member's frozen destination_fingerprint. required_delivery bypasses ONLY
-- preference_off: a missing/revoked/changed contact or a suppressed address is NEVER sent, required or not.
-- Returns the stop reason, or NULL if the member may still be sent.
CREATE OR REPLACE FUNCTION public.notif_digest_member_stop_reason(p_member_id uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o record; v_required boolean; v_dest text;
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
  RETURN NULL;
END $$;

-- §P2 — prepare (ownership-gated, from leased): §PS live revalidation DROPS stopped members (finalized
-- 'skipped' with the stop reason, scrubbed); survivors → prepared, else the whole group → no_work.
CREATE OR REPLACE FUNCTION public.prepare_notification_digest_group(
    p_run_id uuid, p_group_id uuid, p_worker text, p_now timestamptz)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int; v_survivors int; m record; v_reason text; v_channel text;
BEGIN
  SELECT channel INTO v_channel FROM public.notification_digest_groups WHERE id = p_group_id;
  PERFORM notif_digest_assert_run(p_run_id, 'dispatch', v_channel);
  UPDATE public.notification_digest_groups SET updated_at = p_now
   WHERE id = p_group_id AND state = 'leased' AND locked_by = p_worker AND worker_run_id = p_run_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'prepare: group % not owned/leased by % (run %)', p_group_id, p_worker, p_run_id; END IF;

  -- §PS: drop members that fail the LIVE checks (opt-out / lost contact / suppression since enqueue).
  FOR m IN SELECT id FROM public.notification_outbox WHERE digest_group_id = p_group_id AND status = 'pending' LOOP
    v_reason := notif_digest_member_stop_reason(m.id);
    IF v_reason IS NOT NULL THEN
      UPDATE public.notification_outbox
         SET status = 'skipped', skip_reason = v_reason, payload = NULL, digest_item = NULL, updated_at = p_now
       WHERE id = m.id;
    END IF;
  END LOOP;

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
   WHERE id = p_group_id AND state IN ('pending','prepared') AND locked_by = p_worker AND worker_run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'split: group % not owned/splittable', p_group_id; END IF;
  PERFORM notif_digest_assert_run(p_run_id, 'dispatch', g.channel);
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
-- the CANONICAL destination fingerprint: sha256 of the lower-trimmed destination. The resolver (10c-b) MUST
-- snapshot outbox.destination_fingerprint with this same function, and store proves the frozen request's
-- 'to' matches the group's fingerprint — a wrong-recipient request can never be frozen.
CREATE OR REPLACE FUNCTION public.notif_digest_destination_fingerprint(p_destination text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT encode(sha256(lower(btrim(p_destination))::bytea), 'hex') $$;

-- §P4 — store (ownership-gated, from prepared): SERVER-SIDE validation — exact request schema, byte ceiling,
-- destination↔fingerprint proof — and a server-side recomputed hash (never caller-supplied). Then freeze,
-- set the reused idempotency key, → request_ready, available_at = now (immediately due).
CREATE OR REPLACE FUNCTION public.store_notification_digest_request(
    p_run_id uuid, p_group_id uuid, p_worker text, p_frozen_request jsonb, p_now timestamptz)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g record; v_n int; v_to text;
BEGIN
  SELECT * INTO g FROM public.notification_digest_groups
   WHERE id = p_group_id AND state = 'prepared' AND locked_by = p_worker AND worker_run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'store: group % not owned/prepared by %', p_group_id, p_worker; END IF;
  PERFORM notif_digest_assert_run(p_run_id, 'dispatch', g.channel);

  -- exact request schema: an object with non-empty string to/subject/html — nothing else is a valid freeze.
  IF p_frozen_request IS NULL OR jsonb_typeof(p_frozen_request) <> 'object'
     OR jsonb_typeof(p_frozen_request->'to') <> 'string' OR length(p_frozen_request->>'to') = 0
     OR jsonb_typeof(p_frozen_request->'subject') <> 'string' OR length(p_frozen_request->>'subject') = 0
     OR jsonb_typeof(p_frozen_request->'html') <> 'string' OR length(p_frozen_request->>'html') = 0 THEN
    RAISE EXCEPTION 'store: malformed frozen request for group % (need object with to/subject/html)', p_group_id;
  END IF;
  -- STRICT allow-list: the worker dispatches this stored request verbatim, so any extra provider field
  -- (bcc/cc/headers/attachments/unknown) frozen here would be SENT. Nothing outside to/subject/html.
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_frozen_request) AS k(key)
              WHERE k.key NOT IN ('to','subject','html')) THEN
    RAISE EXCEPTION 'store: frozen request for group % carries a key outside the to/subject/html allow-list', p_group_id;
  END IF;
  -- byte ceiling (~90 KB): the render-time oversize check belongs to the worker (§CH), but a frozen request
  -- over budget must never be stored.
  IF octet_length(p_frozen_request::text) > 92160 THEN
    RAISE EXCEPTION 'store: frozen request for group % exceeds the 90 KB budget (% bytes)',
      p_group_id, octet_length(p_frozen_request::text);
  END IF;
  -- destination proof: the request's 'to' must fingerprint to the group's immutable destination_fingerprint.
  v_to := p_frozen_request->>'to';
  IF notif_digest_destination_fingerprint(v_to) <> g.destination_fingerprint THEN
    RAISE EXCEPTION 'store: frozen request destination does not match group % fingerprint', p_group_id;
  END IF;

  UPDATE public.notification_digest_groups
     SET frozen_request = p_frozen_request,
         request_hash = encode(sha256(p_frozen_request::text::bytea), 'hex'),   -- server-side, never trusted
         provider_idempotency_key = 'dg:v1:' || p_group_id::text,
         state = 'request_ready', available_at = p_now, updated_at = p_now
   WHERE id = p_group_id AND state = 'prepared' AND locked_by = p_worker AND worker_run_id = p_run_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'store: group % concurrent change', p_group_id; END IF;
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
  g record; v_attempt uuid; v_survivors int; v_bump timestamptz; v_stop text; v_n int;
  v_hb timestamptz; v_db timestamptz; v_hkey text; v_dkey text; v_hgate text; v_dgate text;
  v_breaker record;
BEGIN
  SELECT * INTO g FROM public.notification_digest_groups
   WHERE id = p_group_id AND state = 'request_ready' AND locked_by = p_worker AND worker_run_id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'begin: group % not owned/request_ready by %', p_group_id, p_worker; END IF;
  PERFORM notif_digest_assert_run(p_run_id, 'dispatch', g.channel);

  -- uncertainty age-out → delivery_unknown (never re-sent past the 23 h window).
  IF g.uncertain_since IS NOT NULL AND g.uncertain_deadline_at IS NOT NULL AND p_now >= g.uncertain_deadline_at THEN
    PERFORM notif_digest_finalize_group(p_group_id, 'delivery_unknown', 'uncertain_age_out', p_now);
    PERFORM notif_digest_commit_reservations(p_group_id, p_now);
    PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'delivery_unknown', 0);
    RETURN NULL;
  END IF;

  -- whole-group stop (§PS): live revalidation before EVERY attempt (no member rewrite here — the group
  -- shares one recipient/destination, so a live stop condition stops the whole group). While uncertain →
  -- awaiting_evidence (capacity committed); else retry_stopped + release.
  SELECT count(*) INTO v_survivors FROM public.notification_outbox
   WHERE digest_group_id = p_group_id AND status = 'pending';
  IF v_survivors > 0 THEN
    SELECT notif_digest_member_stop_reason(o.id) INTO v_stop
      FROM public.notification_outbox o
     WHERE o.digest_group_id = p_group_id AND o.status = 'pending'
     ORDER BY o.created_at, o.id LIMIT 1;
  END IF;
  IF v_survivors = 0 OR v_stop IS NOT NULL THEN
    IF g.uncertain_since IS NOT NULL THEN
      PERFORM notif_digest_commit_reservations(p_group_id, p_now);
      UPDATE public.notification_digest_groups
         SET state = 'awaiting_evidence', available_at = coalesce(uncertain_deadline_at, p_now),
             locked_by = NULL, locked_at = NULL, updated_at = p_now
       WHERE id = p_group_id;
      PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'awaiting_evidence', 0);
    ELSE
      PERFORM notif_digest_finalize_group(p_group_id, 'retry_stopped', coalesce(v_stop, 'no_survivors'), p_now);
      PERFORM notif_digest_release_reservations(p_group_id, p_now);
      PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'retry_stopped', 0);
    END IF;
    RETURN NULL;
  END IF;

  -- breaker gate: ENSURE the circuit row exists, then LOCK it — SELECT FOR UPDATE on a MISSING row locks
  -- nothing, so a first-ever trip could otherwise slip in between the read and the attempt insert. With the
  -- row always present, this acquired row lock is the LINEARIZATION POINT of send authorization: every
  -- trip/re-arm serializes through it, and the state read here is authoritative for the whole transaction.
  INSERT INTO public.notification_provider_circuit (channel, state) VALUES (g.channel, 'closed')
  ON CONFLICT (channel) DO NOTHING;
  SELECT * INTO v_breaker FROM public.notification_provider_circuit WHERE channel = g.channel FOR UPDATE;
  IF FOUND AND v_breaker.state IN ('open','half_open') AND v_breaker.probe_group_id IS DISTINCT FROM p_group_id THEN
    UPDATE public.notification_digest_groups
       SET available_at = p_now + interval '5 minutes', locked_by = NULL, locked_at = NULL, updated_at = p_now
     WHERE id = p_group_id;
    PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'deferred', 0);
    RETURN NULL;
  END IF;

  -- quiet hours: bump + defer (ownership cleared — no stale-reclaim churn).
  v_bump := notif_digest_quiet_hours_bump(p_now, g.recipient_timezone);
  IF v_bump > p_now THEN
    UPDATE public.notification_digest_groups
       SET available_at = v_bump, locked_by = NULL, locked_at = NULL, updated_at = p_now
     WHERE id = p_group_id;
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
      UPDATE public.notification_digest_groups
         SET available_at = p_now + interval '10 minutes', locked_by = NULL, locked_at = NULL, updated_at = p_now
       WHERE id = p_group_id;
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

  -- if this group is the breaker probe (per the LOCKED read above), bind probe_attempt_id to this (fresh or
  -- replacement) attempt — count-checked: under the row lock the binding cannot silently vanish, and a zero
  -- row-count would mean the invariant broke.
  IF v_breaker.channel IS NOT NULL AND v_breaker.state = 'half_open' AND v_breaker.probe_group_id = p_group_id THEN
    UPDATE public.notification_provider_circuit SET probe_attempt_id = v_attempt
     WHERE channel = g.channel AND probe_group_id = p_group_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'begin: probe binding for group % changed underfoot', p_group_id; END IF;
  END IF;

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

-- reason-aware breaker trip (ADR §CB): auth/config +15m; daily quota +coalesce(Retry-After, 24h);
-- monthly quota + invalid_idempotent_request (invariant breach) → retry_at NULL = MANUAL HOLD;
-- any other definite global_config (unknown 4xx) +15m.
CREATE OR REPLACE FUNCTION public.notif_digest_trip_breaker_for(
    p_channel text, p_http_status int, p_error_name text, p_retry_after_seconds int, p_now timestamptz)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_error_name = 'monthly_quota_exceeded' THEN
    PERFORM notif_digest_trip_breaker(p_channel, 'monthly_quota', NULL, p_now);            -- manual hold
  ELSIF p_error_name = 'invalid_idempotent_request' THEN
    PERFORM notif_digest_trip_breaker(p_channel, 'invariant_breach', NULL, p_now);         -- manual hold + alert
  ELSIF p_error_name = 'daily_quota_exceeded' THEN
    PERFORM notif_digest_trip_breaker(p_channel, 'daily_quota',
      p_now + coalesce(make_interval(secs => p_retry_after_seconds), interval '24 hours'), p_now);
  ELSIF p_http_status IN (401, 403) THEN
    PERFORM notif_digest_trip_breaker(p_channel, 'auth_config', p_now + interval '15 minutes', p_now);
  ELSE
    PERFORM notif_digest_trip_breaker(p_channel, 'global_config', p_now + interval '15 minutes', p_now);
  END IF;
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
  -- serialize concurrent recorders on the ATTEMPT row: exactly one caller records; every other returns the
  -- stored outcome (one authoritative outcome, one outcome ledger transition per attempt).
  SELECT * INTO a FROM public.notification_digest_attempts WHERE attempt_id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'record: attempt % not found', p_attempt_id; END IF;
  IF a.recorded_at IS NOT NULL THEN RETURN a.outcome_class; END IF;   -- idempotent replay
  -- exact run linkage: only the attempt's CREATING run may record it — the worker that made the HTTP call
  -- is the only process holding its outcome. (Crash recovery never records an old attempt; it begins a new
  -- one. A cross-run record would let reconciliation attribute the outcome to the wrong run.)
  IF a.worker_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'record: run % does not own attempt % (created by run %)', p_run_id, p_attempt_id, a.worker_run_id;
  END IF;

  SELECT * INTO g FROM public.notification_digest_groups WHERE id = a.digest_group_id FOR UPDATE;
  PERFORM notif_digest_assert_run(p_run_id, 'dispatch', g.channel);

  -- write the attempt outcome (the only permitted attempt mutation: NULL→recorded), count-checked.
  UPDATE public.notification_digest_attempts
     SET recorded_at = p_now, outcome_class = v_class, resend_error_name = p_error_name,
         http_status = p_http_status, provider_message_id = p_provider_message_id
   WHERE attempt_id = p_attempt_id AND recorded_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN   -- a concurrent recorder won between our checks (belt-and-braces under the row lock)
    SELECT outcome_class INTO v_class FROM public.notification_digest_attempts WHERE attempt_id = p_attempt_id;
    RETURN v_class;
  END IF;

  v_is_current := (g.current_attempt_id = p_attempt_id);
  v_is_probe := EXISTS (SELECT 1 FROM public.notification_provider_circuit WHERE channel = g.channel AND probe_attempt_id = p_attempt_id);
  v_backoff := p_now + make_interval(mins => least(power(2, greatest(g.provider_attempts_started,1))::int, 60));
  v_deadline := coalesce(g.uncertain_deadline_at, p_now + make_interval(hours => p_uncertainty_hours));

  -- breaker transition FIRST (only the bound probe attempt may move the breaker); reason-aware timing.
  IF v_is_probe THEN
    IF v_class = 'accepted' OR v_class = 'retryable_definite' OR v_class = 'terminal' THEN
      UPDATE public.notification_provider_circuit SET state = 'closed', reason = NULL, retry_at = NULL,
        probe_group_id = NULL, probe_attempt_id = NULL, probe_locked_at = NULL WHERE channel = g.channel;
    ELSIF v_class = 'global_config' THEN
      PERFORM notif_digest_trip_breaker_for(g.channel, p_http_status, p_error_name, p_retry_after_seconds, p_now);
    ELSIF v_class = 'ambiguous' THEN
      PERFORM notif_digest_trip_breaker(g.channel, 'probe_ambiguous', p_now + interval '2 minutes', p_now);
    END IF;
  END IF;

  -- ACCEPTED: positive acceptance monotonically completes the group (even if a newer attempt owns it),
  -- unless a rank≥3 provider outcome already resolved it (then keep that; just clear uncertainty).
  IF v_class = 'accepted' THEN
    -- a real Resend accept ALWAYS carries a message id — a blank one is a worker bug, never a valid accept.
    IF p_provider_message_id IS NULL OR length(btrim(p_provider_message_id)) = 0 THEN
      RAISE EXCEPTION 'record: accepted outcome for attempt % requires a provider_message_id', p_attempt_id;
    END IF;
    -- correlation-mismatch: the group is already bound to a DIFFERENT provider message (e.g. an early tagged
    -- callback). Silently finalizing would permanently correlate the wrong message → invariant breach:
    -- annotate the attempt only + manual-hold the channel for operator review.
    IF g.provider_message_id IS NOT NULL AND g.provider_message_id <> p_provider_message_id THEN
      PERFORM notif_digest_trip_breaker(g.channel, 'correlation_mismatch', NULL, p_now);   -- manual hold
      PERFORM notif_digest_ledger(p_run_id, g.id, p_attempt_id, 'global_config', 0);
      RETURN 'correlation_mismatch';
    END IF;
    IF g.provider_message_id IS NULL THEN
      UPDATE public.notification_digest_groups SET provider_message_id = p_provider_message_id, updated_at = p_now WHERE id = g.id;
    END IF;
    PERFORM notif_digest_advance_provider_status(g.id, 'sent', p_now);   -- rank 1, never regresses ≥2
    IF g.provider_status_rank < 3 AND g.state NOT IN ('sent','failed_terminal','oversize_failed') THEN
      PERFORM notif_digest_commit_reservations(g.id, p_now);
      PERFORM notif_digest_finalize_group(g.id, 'sent', 'accepted', p_now);
    END IF;
    UPDATE public.notification_digest_groups SET uncertain_since = NULL, uncertain_deadline_at = NULL, updated_at = p_now WHERE id = g.id;
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
    IF NOT v_is_probe THEN
      PERFORM notif_digest_trip_breaker_for(g.channel, p_http_status, p_error_name, p_retry_after_seconds, p_now);
    END IF;
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
-- §PV — the ONE atomic provider transition: group state + provider rank + EVERY member + reservations +
-- BOTH uncertainty fields + terminal_reason move together (no contradictory group/member split). The caller
-- holds the group lock. Positive evidence (sent/delivery_delayed/delivered/complained) resolves the group to
-- 'sent' and OVERRIDES previously bounce-failed / delivery_unknown / cancelled members back to 'sent'
-- (rank ordering: complained(5) > bounced/failed/suppressed(4) > delivered(3) — a higher-rank outcome always
-- wins, per ADR §PV). Negative evidence resolves to 'failed_terminal' with members failed (or cancelled for
-- suppressed). Members dropped PRE-SEND at prepare (status 'skipped') were never in the email — untouched.
CREATE OR REPLACE FUNCTION public.notif_digest_apply_provider_transition(
    p_run_id uuid, p_group_id uuid, p_status text, p_now timestamptz)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g record; v_rank int; v_member_status text;
BEGIN
  SELECT * INTO g FROM public.notification_digest_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing_group'; END IF;
  v_rank := notif_digest_provider_rank(p_status);

  -- monotonic: a lower/equal-rank callback never regresses the resolution. NO transition ledger row is
  -- written (the provider_events row itself is the audit) — a ledgered 'sent' here would make causal
  -- reconciliation claim this run sent the group when it merely ignored a late event.
  IF v_rank IS NULL OR v_rank <= g.provider_status_rank THEN
    RETURN 'noop_rank';
  END IF;

  PERFORM notif_digest_advance_provider_status(p_group_id, p_status, p_now);
  PERFORM notif_digest_commit_reservations(p_group_id, p_now);   -- capacity was consumed by a real dispatch

  IF p_status IN ('sent','delivery_delayed','delivered','complained') THEN
    -- positive: members override — anything that was part of the send flips to 'sent' (incl. a previous
    -- bounce-fail or suppression-cancel now outranked); pre-send 'skipped' drops stay.
    UPDATE public.notification_outbox
       SET status = 'sent', skip_reason = NULL, payload = NULL, digest_item = NULL, updated_at = p_now
     WHERE digest_group_id = p_group_id AND status IN ('pending','failed','delivery_unknown','cancelled','sent');
    UPDATE public.notification_digest_groups
       SET state = 'sent', terminal_reason = p_status, frozen_request = NULL,
           locked_by = NULL, locked_at = NULL, current_attempt_id = NULL,
           uncertain_since = NULL, uncertain_deadline_at = NULL, updated_at = p_now
     WHERE id = p_group_id;
    PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'sent', 0);
    RETURN 'sent';
  ELSE
    -- negative: proven non-delivery → failed_terminal; send members fail (cancelled for suppressed).
    v_member_status := CASE WHEN p_status = 'suppressed' THEN 'cancelled' ELSE 'failed' END;
    UPDATE public.notification_outbox
       SET status = v_member_status, skip_reason = p_status, payload = NULL, digest_item = NULL, updated_at = p_now
     WHERE digest_group_id = p_group_id AND status IN ('pending','sent','delivered','delivery_unknown','failed','cancelled');
    UPDATE public.notification_digest_groups
       SET state = 'failed_terminal', terminal_reason = p_status, frozen_request = NULL,
           locked_by = NULL, locked_at = NULL, current_attempt_id = NULL,
           uncertain_since = NULL, uncertain_deadline_at = NULL, updated_at = p_now
     WHERE id = p_group_id;
    PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'terminal', 0);
    RETURN 'failed_terminal';
  END IF;
END $$;

-- the ONE correlation predicate + binder (used by BOTH the direct callback path AND orphan linking):
-- a provider message may correlate to a group ONLY when the group already carries that exact message id,
-- or is unbound but has a LIVE send (provider_attempts_started > 0). A never-sent (blank) group can never
-- accept an arbitrary provider message — through either path. Locks the group row.
CREATE OR REPLACE FUNCTION public.notif_digest_bind_provider_message(p_group_id uuid, p_provider_message_id text, p_now timestamptz)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_pm text; v_attempts int;
BEGIN
  SELECT provider_message_id, provider_attempts_started INTO v_pm, v_attempts
    FROM public.notification_digest_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF v_pm IS NOT NULL THEN
    IF v_pm = p_provider_message_id THEN RETURN 'ok'; END IF;
    RETURN 'mismatch';
  END IF;
  IF coalesce(v_attempts, 0) = 0 THEN RETURN 'no_live_send'; END IF;
  UPDATE public.notification_digest_groups SET provider_message_id = p_provider_message_id, updated_at = p_now
   WHERE id = p_group_id;
  RETURN 'ok';
END $$;

-- apply a provider callback (orphan-then-link, at-least-once/unordered safe). A TAGGED early callback —
-- arriving BEFORE the HTTP result is recorded — durably lands by setting the group's write-once
-- provider_message_id from the tag correlation (the composite FK then accepts the event); a tag whose
-- message id CONFLICTS with the group's is stored as an orphan ('mismatch'). The record_email_event/
-- suppression side effects belong to the webhook adapter (10c-a3). Idempotent by resend_event_id.
CREATE OR REPLACE FUNCTION public.apply_notification_provider_event(
    p_run_id uuid, p_resend_event_id text, p_provider_message_id text, p_digest_group_id uuid,
    p_status text, p_occurred_at timestamptz, p_now timestamptz)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_group_id uuid; v_pm text; v_attempts int; v_inserted boolean := false; v_mismatch boolean := false;
BEGIN
  IF p_run_id IS NOT NULL THEN PERFORM notif_digest_assert_run(p_run_id, NULL, NULL); END IF;
  -- correlate: explicit tag, else the group holding this provider_message_id.
  v_group_id := p_digest_group_id;
  IF v_group_id IS NULL THEN
    SELECT id INTO v_group_id FROM public.notification_digest_groups WHERE provider_message_id = p_provider_message_id;
  END IF;

  IF v_group_id IS NOT NULL THEN
    CASE notif_digest_bind_provider_message(v_group_id, p_provider_message_id, p_now)
      WHEN 'ok' THEN NULL;
      WHEN 'mismatch' THEN v_group_id := NULL; v_mismatch := true;   -- conflict → durable orphan + flag
      ELSE v_group_id := NULL;              -- purged group / never-sent group → orphan (no binding)
    END CASE;
  END IF;

  -- append the event (globally idempotent by resend_event_id; orphan if uncorrelated/mismatched).
  INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, digest_group_id, status, occurred_at, received_at)
  VALUES (p_resend_event_id, p_provider_message_id, v_group_id, p_status, p_occurred_at, p_now)
  ON CONFLICT (resend_event_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF NOT v_inserted THEN RETURN 'duplicate'; END IF;   -- webhook double-delivery → no double-apply
  IF v_mismatch THEN RETURN 'mismatch'; END IF;
  IF v_group_id IS NULL THEN RETURN 'orphan'; END IF;  -- link later via link_notification_provider_event

  RETURN notif_digest_apply_provider_transition(p_run_id, v_group_id, p_status, p_now);
END $$;

-- orphan → link → APPLY (forward replacement of the 10c-a1 link RPC): linking a stored orphan to its group
-- now also applies the event's stored outcome exactly once (evidence is never stranded). Retry-idempotent:
-- same event + same group = success no-op; different group rejected. Sets the group's write-once
-- provider_message_id when still NULL so the composite FK accepts the link.
CREATE OR REPLACE FUNCTION public.link_notification_provider_event(p_resend_event_id text, p_digest_group_id uuid)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_current uuid; v_pm text; v_status text; v_gpm text; v_n int;
BEGIN
  SELECT digest_group_id, provider_message_id, status INTO v_current, v_pm, v_status
    FROM public.notification_provider_events WHERE resend_event_id = p_resend_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'provider event % not found', p_resend_event_id; END IF;
  IF v_current IS NOT NULL THEN
    IF v_current = p_digest_group_id THEN RETURN true; END IF;   -- idempotent retry
    RAISE EXCEPTION 'provider event % already linked to a different group', p_resend_event_id;
  END IF;
  CASE notif_digest_bind_provider_message(p_digest_group_id, v_pm, now())
    WHEN 'ok' THEN NULL;
    WHEN 'missing' THEN RAISE EXCEPTION 'link: group % not found', p_digest_group_id;
    WHEN 'mismatch' THEN RAISE EXCEPTION 'link: event % message id does not match group %', p_resend_event_id, p_digest_group_id;
    WHEN 'no_live_send' THEN RAISE EXCEPTION 'link: group % has no live send to correlate (never-sent groups cannot accept provider messages)', p_digest_group_id;
  END CASE;
  UPDATE public.notification_provider_events
     SET digest_group_id = p_digest_group_id
   WHERE resend_event_id = p_resend_event_id AND digest_group_id IS NULL;   -- conditional atomic link
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'provider event % link affected % rows (concurrent change)', p_resend_event_id, v_n;
  END IF;
  -- apply the stored outcome exactly once (the transition is rank-guarded, so a duplicate apply is a no-op).
  PERFORM notif_digest_apply_provider_transition(NULL, p_digest_group_id, v_status, now());
  RETURN true;
END $$;

-- ===========================================================================
-- §SWEEP — operator-facing standalone sweep: age-out due awaiting_evidence groups (→ delivery_unknown) and
-- re-arm half-open breakers whose bound probe lease has expired (crash-before/after-HTTP recovery). Bounded.
CREATE OR REPLACE FUNCTION public.reconcile_notification_digest_stale(
    p_run_id uuid, p_channel text, p_now timestamptz, p_probe_lease_minutes int DEFAULT 10, p_limit int DEFAULT 500)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g record; v_n int := 0;
BEGIN
  PERFORM notif_digest_assert_run(p_run_id, 'dispatch', p_channel);
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
-- §12b. Forward replacement of the 10c-a1 outbox snapshot guard: split_notification_digest_group must move a
-- member from a superseded parent to its child, but the deployed guard forbids EVERY re-point. Add ONE
-- narrowly authorized transition — a re-point is allowed only when the NEW group is a CHILD of the member's
-- current group (parent_group_id = OLD.digest_group_id), i.e. the §P3 split. Everything else (detach except
-- retention, arbitrary re-point, nested hijack) stays rejected exactly as before.
CREATE OR REPLACE FUNCTION public.notification_outbox_snapshot_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (OLD.delivery_mode           IS NOT NULL AND NEW.delivery_mode           IS DISTINCT FROM OLD.delivery_mode)
   OR (OLD.recipient_key          IS NOT NULL AND NEW.recipient_key          IS DISTINCT FROM OLD.recipient_key)
   OR (OLD.digest_frequency       IS NOT NULL AND NEW.digest_frequency       IS DISTINCT FROM OLD.digest_frequency)
   OR (OLD.group_locale           IS NOT NULL AND NEW.group_locale           IS DISTINCT FROM OLD.group_locale)
   OR (OLD.recipient_timezone     IS NOT NULL AND NEW.recipient_timezone     IS DISTINCT FROM OLD.recipient_timezone)
   OR (OLD.digest_boundary_at     IS NOT NULL AND NEW.digest_boundary_at     IS DISTINCT FROM OLD.digest_boundary_at)
   OR (OLD.template_version       IS NOT NULL AND NEW.template_version       IS DISTINCT FROM OLD.template_version)
   OR (OLD.destination_fingerprint IS NOT NULL AND NEW.destination_fingerprint IS DISTINCT FROM OLD.destination_fingerprint)
   OR (OLD.digest_group_hash       IS NOT NULL AND NEW.digest_group_hash       IS DISTINCT FROM OLD.digest_group_hash) THEN
    RAISE EXCEPTION 'notification_outbox digest snapshot fields are write-once';
  END IF;
  -- EVERY canonical grouping input is frozen on digest rows (they define the group hash/identity).
  IF OLD.delivery_mode = 'digest' AND (
       NEW.channel IS DISTINCT FROM OLD.channel
    OR (OLD.event_type IS NOT NULL AND NEW.event_type IS DISTINCT FROM OLD.event_type)
    OR (OLD.template_key IS NOT NULL AND NEW.template_key IS DISTINCT FROM OLD.template_key)
    OR (OLD.tenant_academy_profile_id IS NOT NULL AND NEW.tenant_academy_profile_id IS DISTINCT FROM OLD.tenant_academy_profile_id)
    OR (OLD.tenant_trainer_id IS NOT NULL AND NEW.tenant_trainer_id IS DISTINCT FROM OLD.tenant_trainer_id)) THEN
    RAISE EXCEPTION 'notification_outbox digest canonical identity fields are frozen';
  END IF;
  IF OLD.digest_group_id IS NOT NULL AND NEW.digest_group_id IS DISTINCT FROM OLD.digest_group_id THEN
    IF NEW.digest_group_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.notification_digest_groups WHERE id = OLD.digest_group_id) THEN
      NULL;   -- the group is gone → this is the retention FK SET NULL detach
    ELSIF NEW.digest_group_id IS NOT NULL
       AND EXISTS (SELECT 1
                     FROM public.notification_digest_groups c
                     JOIN public.notification_digest_groups par ON par.id = OLD.digest_group_id
                    WHERE c.id = NEW.digest_group_id AND c.parent_group_id = par.id
                      -- the child must carry the parent's COMPLETE immutable canonical identity (the
                      -- canonical key embeds recipient/destination/tenants/event/template/boundary) — a
                      -- parent-linked child with a DIFFERENT identity is not a split, it is a hijack.
                      AND c.canonical_group_key = par.canonical_group_key
                      AND c.channel = par.channel AND c.recipient_key = par.recipient_key
                      AND c.destination_fingerprint = par.destination_fingerprint
                      AND c.digest_boundary_at = par.digest_boundary_at) THEN
      NULL;   -- §P3 split: the ONLY authorized re-point — parent → its own identity-identical child
    ELSE
      RAISE EXCEPTION 'notification_outbox.digest_group_id may only detach via retention cascade or re-point to a split child';
    END IF;
  END IF;
  RETURN NEW;
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
