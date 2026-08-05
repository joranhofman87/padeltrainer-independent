-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N4 M2 — per-channel notification KILL SWITCHES. SET-ONLY, by design (contract CRITICAL 2):
-- the instant email/whatsapp workers run on live 2-minute crons, so an RPC that CLEARS a kill
-- is a send-enabling control — the exact thing the disable-only admin surface must not carry.
-- Clearing is an owner/runbook operation outside this surface (superuser: disable the guard
-- trigger, DELETE the row, re-enable), never an API path.
--
-- THE CONTRACT (HIGH finding 5):
--  * activation and every claim path share ONE per-channel advisory lock — a kill never
--    interleaves mid-claim; it waits out the in-flight claim transaction or is seen by the next;
--  * the kill check runs FIRST in claim_notification_outbox_batch — before the cap-cancel and
--    the reap — because a killed channel makes NO ledger mutations through its workers;
--  * digest: claim + materialize answer their idle values; begin (the step that mints the
--    attempt, immediately before the provider call) parks via NULL exactly like the breaker —
--    the core counts it deferred, no attempt burn, nothing terminal;
--  * instant workers re-check IMMEDIATELY before each provider send (claim-time alone leaves
--    already-claimed rows live) and on kill RELEASE their claims: status back to pending,
--    the claim's attempt increment undone, a short next_attempt_at backoff — never a terminal
--    failure, never budget burn. The check is FAIL-CLOSED in the worker: a read error defers.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.notification_channel_kill_switches (
  channel      text PRIMARY KEY CHECK (channel IN ('email', 'whatsapp')),
  activated_at timestamptz NOT NULL DEFAULT now(),
  activated_by uuid,                                   -- auth.uid() when an admin killed it; NULL for runbook/service
  reason       text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  request_id   uuid NOT NULL UNIQUE                    -- caller identity: an exact retry replays, never double-audits
);

-- OWNER-EFFECTIVE guard (the digest-ledger pattern): a kill row is immutable evidence. No
-- UPDATE ever; no DELETE/TRUNCATE through any code path — clearing a kill re-opens a live
-- channel and belongs to the owner's runbook, not to SQL reachable from the API.
CREATE OR REPLACE FUNCTION public.notif_channel_kill_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'notification_channel_kill_switches is SET-ONLY: no %. Clearing a kill re-opens a live channel and is an owner/runbook operation, never an API path', TG_OP;
END;
$$;

CREATE TRIGGER trg_notif_channel_kill_guard
  BEFORE UPDATE OR DELETE ON public.notification_channel_kill_switches
  FOR EACH ROW EXECUTE FUNCTION public.notif_channel_kill_guard();
CREATE TRIGGER trg_notif_channel_kill_no_truncate
  BEFORE TRUNCATE ON public.notification_channel_kill_switches
  FOR EACH STATEMENT EXECUTE FUNCTION public.notif_channel_kill_guard();

COMMENT ON TABLE public.notification_channel_kill_switches IS
  'N4 M2: a row here KILLS its channel — the instant claim refuses (zero ledger mutations), the digest claim/materialize idle, begin parks, and the workers'' pre-provider re-check releases already-claimed rows. SET-only: no RPC, role or owner code path clears a kill; removal is a reviewed runbook operation (guard-disable + DELETE as superuser).';

REVOKE ALL ON public.notification_channel_kill_switches FROM PUBLIC, anon, authenticated, service_role;

-- ── the shared serialization point ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.notif_channel_kill_gate(p_channel text) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- The per-channel lock BOTH the kill-set and every claim/materialize/begin path take: a kill
  -- transaction and a claim transaction can never interleave — one strictly precedes the other.
  PERFORM pg_advisory_xact_lock(hashtextextended('notif-channel-kill:' || p_channel, 0));
  RETURN EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = p_channel);
END;
$$;

REVOKE ALL ON FUNCTION public.notif_channel_kill_gate(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_channel_kill_gate(text) TO service_role;

-- ── the workers' pre-provider re-check: lock-free STABLE read, fail-closed at the caller ────
CREATE OR REPLACE FUNCTION public.is_notification_channel_killed(p_channel text) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- The SAME shared lock as every other kill-ordered path. A lock-free read here left a race:
  -- an admin's kill INSERT, uncommitted but already holding the channel lock, was invisible
  -- under READ COMMITTED — so a worker's pre-provider check answered false and reached the
  -- provider while the kill transaction was open. Taking the lock serializes this check behind
  -- an in-progress kill; a kill arriving AFTER a completed false check is the unavoidable,
  -- correctly-ordered residual. Kill transactions are one INSERT — the wait is bounded.
  PERFORM pg_advisory_xact_lock(hashtextextended('notif-channel-kill:' || p_channel, 0));
  RETURN EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = p_channel);
END;
$$;

COMMENT ON FUNCTION public.is_notification_channel_killed(text) IS
  'N4 M2: the workers'' pre-provider re-check — called immediately before EACH provider send, because the claim-time gate alone leaves already-claimed rows live. Takes the shared per-channel advisory lock so an in-progress kill (uncommitted, lock held) is WAITED OUT and then seen — never raced past. The caller treats a read ERROR as killed: fail closed.';

REVOKE ALL ON FUNCTION public.is_notification_channel_killed(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_notification_channel_killed(text) TO service_role;

-- ── the SET (the only write this surface carries) ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_activate_channel_kill(
  p_channel text,
  p_reason text,
  p_request_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v public.notification_channel_kill_switches%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin_activate_channel_kill: platform admin only';
  END IF;
  IF p_channel NOT IN ('email', 'whatsapp') THEN
    RAISE EXCEPTION 'admin_activate_channel_kill: unknown channel %', p_channel;
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'admin_activate_channel_kill: a caller-generated request_id is required';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'admin_activate_channel_kill: a reason (3-500 chars) is required';
  END IF;

  -- REQUEST lock, then replay lookup, then the channel lock — the same ordering as the M1
  -- open(). Concurrent IDENTICAL calls serialize here and CONVERGE on 'killed' (the loser finds
  -- the winner's row and replays); a reused id is refused TYPED, on any mismatch of what the
  -- request said (channel or reason) — an id names one decision, exactly.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('notif-channel-kill-req:' || p_request_id::text, 0));
  SELECT * INTO v FROM public.notification_channel_kill_switches WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v.channel = p_channel AND v.reason = btrim(p_reason) THEN RETURN 'killed'; END IF;
    RAISE EXCEPTION 'admin_activate_channel_kill: request % was already used for a different decision (channel %, reason %)', p_request_id, v.channel, v.reason;
  END IF;

  -- the shared per-channel lock: the kill lands strictly before or after any in-flight claim
  PERFORM pg_advisory_xact_lock(hashtextextended('notif-channel-kill:' || p_channel, 0));
  IF EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = p_channel) THEN
    RETURN 'already_killed';   -- idempotent-safe: the FIRST kill's evidence stands untouched
  END IF;
  INSERT INTO public.notification_channel_kill_switches (channel, activated_by, reason, request_id)
  VALUES (p_channel, auth.uid(), btrim(p_reason), p_request_id);
  RETURN 'killed';
END;
$$;

COMMENT ON FUNCTION public.admin_activate_channel_kill(text, text, uuid) IS
  'N4 M2: the ONLY write on the kill surface — SET a channel kill (admin-checked, request-id idempotent, reason mandatory). There is deliberately NO clearing counterpart: clearing re-opens a live channel (the instant workers run on live crons) and is an owner/runbook operation.';

REVOKE ALL ON FUNCTION public.admin_activate_channel_kill(text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_activate_channel_kill(text, text, uuid) TO authenticated, service_role;

-- ── release: what a worker does with rows it had ALREADY claimed when the kill landed ───────
CREATE OR REPLACE FUNCTION public.release_notification_claims_on_kill(
  p_channel text,
  p_worker text
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n int;
BEGIN
  -- Token-guarded like record_notification_send_result: only the claiming run may release its
  -- own rows. Undo exactly what the claim did — back to pending, the claim's attempt increment
  -- reverted (a kill must never burn a row''s retry budget), a short backoff so nothing
  -- hot-loops while the channel is down. Digest members excluded structurally (the instant
  -- claim never takes them).
  UPDATE public.notification_outbox o
  SET status = 'pending',
      attempts = greatest(o.attempts - 1, 0),
      locked_at = NULL, locked_by = NULL,
      next_attempt_at = now() + interval '5 minutes',
      updated_at = now()
  WHERE o.channel = p_channel
    AND o.status = 'processing'
    AND o.locked_by = p_worker
    AND o.delivery_mode IS DISTINCT FROM 'digest';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public.release_notification_claims_on_kill(text, text) IS
  'N4 M2: token-guarded release of a worker''s still-claimed instant rows when the pre-provider re-check finds the channel killed (or cannot be read — fail closed). Rows return to pending with the claim''s attempt increment undone and a 5-minute backoff: a kill defers, it never terminal-fails and never burns retry budget.';

REVOKE ALL ON FUNCTION public.release_notification_claims_on_kill(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_notification_claims_on_kill(text, text) TO service_role;

-- ═══ the four gated paths — each body reproduced VERBATIM from its newest prior definition ═══
-- claim_notification_outbox_batch: 20261015120000 (N3 cap integration)
-- claim_notification_digest_group + begin_notification_digest_attempt: 20261004100000
-- materialize_notification_digest_groups: 20261005110000
-- Forward-only CREATE OR REPLACE; signatures unchanged, so privileges persist.

CREATE OR REPLACE FUNCTION public.claim_notification_outbox_batch(
  p_channel text,
  p_worker  text,
  p_limit   int DEFAULT 20,
  p_stale_after_minutes int DEFAULT 15   -- 'processing' longer than this = a crashed/orphaned worker
) RETURNS TABLE (
  outbox_id              uuid,
  event_type             text,
  template_key           text,
  destination_normalized text,
  destination_redacted   text,
  payload                jsonb,
  attempts               int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
-- RETURNS TABLE OUT names (status/attempts/...) would shadow columns; every real
-- reference here is table-qualified or p_-prefixed, so prefer the column always.
#variable_conflict use_column
BEGIN
  -- N4 M2 KILL SWITCH — FIRST, before the cap-cancel, the reap and the claim scan: a killed
  -- channel makes NO ledger mutations through this worker. The gate takes the per-channel
  -- advisory lock the kill-set shares, so a kill never interleaves mid-claim: it either waits
  -- out an in-flight claim transaction or is visible to the next one.
  IF public.notif_channel_kill_gate(p_channel) THEN
    RETURN;
  END IF;

  -- N3 LIVE CAP ENFORCEMENT (design contract finding 3): "disable" governs ALL unsent optional
  -- work, not only future intents. Before claiming anything, convert every still-pending
  -- academy-attributed row whose (academy, event, channel) now carries an 'off' cap into a
  -- terminal tenant_restricted skipped row — the ledger stays truthful, and the claim scan
  -- below can never pick one up. Required events are exempt by predicate (belt) and by M2's
  -- write trigger (braces); digest members are exempt — their live authority is the stop
  -- predicate, which runs the same check at prepare AND begin. Residual window: a cap landing
  -- AFTER a row is claimed ('processing') rides out with the in-flight batch — the same
  -- accepted family as N2 §7b's in-flight-mail race; daily/weekly caps shape cadence at
  -- ENQUEUE time only and do not re-bucket already-pending work.
  UPDATE public.notification_outbox o
  SET status = 'skipped', skip_reason = 'tenant_restricted',
      locked_at = NULL, locked_by = NULL, updated_at = now()
  FROM public.academy_notification_restrictions r
  JOIN public.notification_event_types et ON et.key = r.event_type
  WHERE o.channel = p_channel
    AND (
      o.status = 'pending'
      -- A STALE claim is not in-flight work: the system has declared that worker dead and is
      -- about to make a FRESH send decision (the reclaim arm below) — so the cap must win here
      -- too, and win over the reap as well (once the cap exists, tenant_restricted is the
      -- truthful terminal reason, not stuck_in_processing). Same threshold as the reclaim.
      OR (o.status = 'processing'
          AND o.locked_at < now() - make_interval(mins => greatest(p_stale_after_minutes, 1)))
    )
    AND o.delivery_mode IS DISTINCT FROM 'digest'
    AND o.tenant_academy_profile_id = r.academy_profile_id
    AND o.event_type = r.event_type
    AND o.channel = r.channel
    AND r.max_frequency = 'off'
    AND NOT et.required_delivery;

  -- REAP: a row wedged in 'processing' past the stale window AND out of retries is
  -- terminal — so a worker that keeps crashing on one row can't loop forever.
  -- Digest members are excluded: their lifecycle is owned by the digest state machine,
  -- and terminal-failing one here would strand a group member behind this worker's rules.
  UPDATE public.notification_outbox
  SET status = 'failed', failed_at = now(), last_error = 'stuck_in_processing',
      locked_at = NULL, locked_by = NULL, updated_at = now()
  WHERE channel = p_channel
    AND status = 'processing'
    AND delivery_mode IS DISTINCT FROM 'digest'
    AND locked_at < now() - make_interval(mins => greatest(p_stale_after_minutes, 1))
    AND attempts >= max_attempts;

  RETURN QUERY
  WITH due AS (
    SELECT o.id
    FROM public.notification_outbox o
    WHERE o.channel = p_channel
      -- INSTANT work only. A digest member is pending until the materializer takes it, and
      -- its scheduled_for IS the digest boundary, so without this predicate every digest
      -- member becomes claimable by the instant worker the moment its boundary passes.
      AND o.delivery_mode IS DISTINCT FROM 'digest'
      AND (
        -- fresh, due work
        (o.status = 'pending'
          AND o.scheduled_for <= now()
          AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now()))
        -- OR orphaned in-flight work (crashed after claim, before record) — reclaim it
        OR (o.status = 'processing'
          AND o.locked_at < now() - make_interval(mins => greatest(p_stale_after_minutes, 1))
          AND o.attempts < o.max_attempts)
      )
    ORDER BY o.scheduled_for
    FOR UPDATE SKIP LOCKED
    LIMIT greatest(p_limit, 0)
  )
  UPDATE public.notification_outbox o
  SET status          = 'processing',
      locked_at       = now(),
      locked_by       = p_worker,   -- the per-run lock token; only it may later finalize the row
      attempts        = o.attempts + 1,   -- claim == an attempt; RETURNING sees the new count
      next_attempt_at = NULL,
      updated_at      = now()
  FROM due
  WHERE o.id = due.id
  RETURNING o.id, o.event_type, o.template_key, o.destination_normalized,
            o.destination_redacted, o.payload, o.attempts;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_notification_digest_group(
    p_run_id uuid, p_channel text, p_now timestamptz, p_worker text, p_stale_minutes int DEFAULT 15)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g record; v_iter int := 0; v_bump timestamptz; v_cb record; v_promote boolean := false; v_n int;
BEGIN
  -- N4 M2 KILL SWITCH — FIRST. NULL is this function's own idle answer, so a killed channel
  -- reads as "no group due" and the worker ends the loop without touching the ledger. Shares
  -- the kill-set's per-channel advisory lock (no mid-claim interleave).
  IF public.notif_channel_kill_gate(p_channel) THEN
    RETURN NULL;
  END IF;

  PERFORM notif_digest_assert_run(p_run_id, 'dispatch', p_channel);
  PERFORM notif_digest_require_range(p_stale_minutes, 1, 1440, 'claim: p_stale_minutes');

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

    -- uncertainty age-out — ANY due uncertain group (request_ready | sending | awaiting_evidence), handled
    -- BEFORE the quiet-hours/breaker deferral branches. Otherwise a group whose deadline is already past
    -- would be deferred to least(bump, deadline) = the already-due deadline, re-selected, and hot-loop until
    -- the v_iter cap (one call emitting 200 'deferred' ledger rows). Finalize delivery_unknown, commit
    -- reservations, write exactly ONE outcome ledger event, and continue.
    IF g.uncertain_since IS NOT NULL AND g.uncertain_deadline_at IS NOT NULL AND p_now >= g.uncertain_deadline_at THEN
      PERFORM notif_digest_finalize_group(g.id, 'delivery_unknown', 'age_out', p_now);
      PERFORM notif_digest_commit_reservations(g.id, p_now);
      PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'delivery_unknown', 0);
      CONTINUE;
    END IF;

    -- crash reclaim of a stale-locked group.
    IF g.locked_at IS NOT NULL AND g.locked_at < p_now - make_interval(mins => p_stale_minutes)
       AND g.state IN ('leased','prepared','request_ready','sending') THEN
      IF g.state = 'sending' THEN
        -- the uncertainty window is anchored to the FIRST HTTP dispatch (the frozen idempotency key's
        -- provider-side dedup window starts there, not at crash discovery). Late discovery — at/after
        -- first_send_at + 23h — must finalize delivery_unknown, never become sendable again: a re-POST
        -- outside the provider window would DUPLICATE delivery.
        IF p_now >= notif_digest_uncertainty_deadline(g.first_send_at, g.uncertain_deadline_at) THEN
          PERFORM notif_digest_finalize_group(g.id, 'delivery_unknown', 'uncertain_age_out', p_now);
          PERFORM notif_digest_commit_reservations(g.id, p_now);
          PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'delivery_unknown', 0);
          CONTINUE;
        END IF;
        UPDATE public.notification_digest_groups
           SET uncertain_since = coalesce(uncertain_since, p_now),
               uncertain_deadline_at = notif_digest_uncertainty_deadline(first_send_at, uncertain_deadline_at),
               state = 'request_ready',
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

    -- quiet hours: bump available_at (a genuine SCHEDULING change), do not claim — capped at the uncertainty
    -- deadline (an uncertain group must never be scheduled past first_send_at + 23h).
    v_bump := notif_digest_quiet_hours_bump(p_now, g.recipient_timezone);
    IF v_bump > p_now THEN
      UPDATE public.notification_digest_groups
         SET available_at = least(v_bump, coalesce(g.uncertain_deadline_at, 'infinity'::timestamptz)), updated_at = p_now
       WHERE id = g.id;
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

CREATE OR REPLACE FUNCTION public.begin_notification_digest_attempt(
    p_run_id uuid, p_group_id uuid, p_worker text, p_now timestamptz,
    p_hour_cap int DEFAULT 1000, p_day_cap int DEFAULT 5000)
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
  PERFORM notif_digest_require_range(p_hour_cap, 1, 1000000, 'begin: p_hour_cap');
  PERFORM notif_digest_require_range(p_day_cap, 1, 10000000, 'begin: p_day_cap');

  -- N4 M2 KILL SWITCH — the digest pre-dispatch authority, at the step that mints the attempt.
  -- The SAME defer transition as the breaker below (ownership cleared, bounded available_at,
  -- ledger 'deferred', NULL back): request_ready + unowned is a legal due shape, so the group
  -- is genuinely PARKED — re-claimable the moment the kill is lifted — never stranded on this
  -- departing worker's lease until stale reclaim. Runs before the age-out so a kill defers
  -- everything; available_at is clamped to the uncertainty deadline, so age-out still fires on
  -- time at the next live pass.
  IF public.notif_channel_kill_gate(g.channel) THEN
    UPDATE public.notification_digest_groups
       SET available_at = least(p_now + interval '5 minutes', coalesce(g.uncertain_deadline_at, 'infinity'::timestamptz)),
           locked_by = NULL, locked_at = NULL, updated_at = p_now
     WHERE id = p_group_id;
    PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'deferred', 0);
    RETURN NULL;
  END IF;

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
         SET state = 'awaiting_evidence',
             available_at = notif_digest_uncertainty_deadline(first_send_at, uncertain_deadline_at),
             uncertain_deadline_at = notif_digest_uncertainty_deadline(first_send_at, uncertain_deadline_at),
             locked_by = NULL, locked_at = NULL, current_attempt_id = NULL, updated_at = p_now
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
       SET available_at = least(p_now + interval '5 minutes', coalesce(g.uncertain_deadline_at, 'infinity'::timestamptz)),
           locked_by = NULL, locked_at = NULL, updated_at = p_now
     WHERE id = p_group_id;
    PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'deferred', 0);
    RETURN NULL;
  END IF;

  -- quiet hours: bump + defer (ownership cleared — no stale-reclaim churn).
  v_bump := notif_digest_quiet_hours_bump(p_now, g.recipient_timezone);
  IF v_bump > p_now THEN
    UPDATE public.notification_digest_groups
       SET available_at = least(v_bump, coalesce(g.uncertain_deadline_at, 'infinity'::timestamptz)),
           locked_by = NULL, locked_at = NULL, updated_at = p_now
     WHERE id = p_group_id;
    PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'deferred', 0);
    RETURN NULL;
  END IF;

  -- budget bound: exhausted while uncertain → awaiting_evidence (committed); else → retry_stopped.
  IF g.delivery_budget_used >= g.max_delivery_budget THEN
    IF g.uncertain_since IS NOT NULL THEN
      PERFORM notif_digest_commit_reservations(p_group_id, p_now);
      UPDATE public.notification_digest_groups
         SET state = 'awaiting_evidence',
             available_at = notif_digest_uncertainty_deadline(first_send_at, uncertain_deadline_at),
             uncertain_deadline_at = notif_digest_uncertainty_deadline(first_send_at, uncertain_deadline_at),
             locked_by = NULL, locked_at = NULL, current_attempt_id = NULL, updated_at = p_now
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
  -- buckets are truncated in a FIXED zone (UTC): date_trunc on a timestamptz truncates in the SESSION
  -- TimeZone, so Tokyo and New York sessions would otherwise mint different day buckets → split caps.
  v_hb := date_trunc('hour', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_db := date_trunc('day',  p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_hkey := notif_digest_counter_key(g.channel, g.event_type, g.destination_fingerprint, 'hour', v_hb);
  v_dkey := notif_digest_counter_key(g.channel, g.event_type, g.destination_fingerprint, 'day', v_db);
  v_hgate := notif_digest_bucket_gate(p_group_id, v_hkey, 'hour', v_hb, p_hour_cap);
  v_dgate := notif_digest_bucket_gate(p_group_id, v_dkey, 'day', v_db, p_day_cap);
  IF v_hgate = 'full' OR v_dgate = 'full' THEN
    IF g.uncertain_since IS NOT NULL THEN
      PERFORM notif_digest_commit_reservations(p_group_id, p_now);
      UPDATE public.notification_digest_groups
         SET state = 'awaiting_evidence',
             available_at = notif_digest_uncertainty_deadline(first_send_at, uncertain_deadline_at),
             uncertain_deadline_at = notif_digest_uncertainty_deadline(first_send_at, uncertain_deadline_at),
             locked_by = NULL, locked_at = NULL, current_attempt_id = NULL, updated_at = p_now
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

CREATE OR REPLACE FUNCTION public.materialize_notification_digest_groups(
    p_run_id uuid, p_channel text, p_now timestamptz, p_max_groups int, p_max_members_per_call int)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_budget int := 92160;                 -- ~90 KB cumulative byte budget per group
  v_groups int := 0; v_members int := 0; v_iter int := 0; v_lock_skips int := 0;
  cand record; m record;
  v_ckey jsonb; v_hash text; v_group uuid; v_count int; v_bytes int; v_next_chunk int; v_n int;
BEGIN
  -- N4 M2 KILL SWITCH — a killed channel forms no new groups: materialization is a ledger
  -- mutation, and shaping work while killed would hand the un-kill a pre-built send backlog.
  IF public.notif_channel_kill_gate(p_channel) THEN
    RETURN 0;
  END IF;

  PERFORM notif_digest_assert_run(p_run_id, 'materialize', p_channel);
  PERFORM notif_digest_require_range(p_max_groups, 1, 1000, 'materialize: p_max_groups');
  PERFORM notif_digest_require_range(p_max_members_per_call, 1, 10000, 'materialize: p_max_members_per_call');
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
    v_hash := coalesce(cand.digest_group_hash, encode(sha256(convert_to(v_ckey::text, 'UTF8')), 'hex'));
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


-- prepare_notification_digest_group: reproduced VERBATIM from 20261004100000, with the
-- kill gate after the ownership assertion (see the arm's comment for why the lease is KEPT).
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

  -- N4 M2 KILL SWITCH — the worker-visible TYPED parked verdict. A leased group has no legal
  -- unowned-due shape (the due scan takes pending/request_ready + unowned; the reclaim arm
  -- keys on a STALE locked_at), so clearing ownership here would strand it: instead the lease
  -- is kept, the worker maps 'channel_killed' to deferred (no render, no store, no error), and
  -- the group rides the bounded stale-reclaim window — whose claim-side gate then refuses it
  -- while the kill holds. Send-safe either way; this makes the defer VISIBLE and counted.
  IF public.notif_channel_kill_gate(v_channel) THEN
    PERFORM notif_digest_ledger(p_run_id, p_group_id, NULL, 'deferred', 0);
    RETURN 'channel_killed';
  END IF;

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
