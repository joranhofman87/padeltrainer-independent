-- 10c-a3 PR-1 (SQL reliability) — tag-faithful atomic orphan enrollment + bounded, poison-safe reconciliation.
--
-- WHY (Codex 10c-a3 rounds 1-6): a Resend callback that arrives BEFORE its digest group binds provider_message_id
-- is stored as an ORPHAN. It must be correlated ONLY to its ORIGINAL tagged group (never reassigned by a bare
-- provider-message-id search — round-6 f1), invalid tags must fail LOUDLY (not be laundered into `not_digest` —
-- round-6 f2), continuation must be concurrency-safe (round-6 f3), and quarantine must be recoverable and distinct
-- from temporary deferral (round-6 f4). Enrollment is ATOMIC (inside apply), event-first-locked (no apply↔reconcile
-- deadlock), bounded at scale, and the queue table is SELECT-only for service_role.
-- Deploy BEFORE any webhook may ack an `orphan` (PR-2). INERT until PR-2.

-- ── durable, indexed WORK QUEUE — retains the TAGGED correlation source (digest_group_id) ────────────────────
CREATE TABLE IF NOT EXISTS public.notification_orphan_reconcile_state (
  resend_event_id     text PRIMARY KEY REFERENCES public.notification_provider_events(resend_event_id) ON DELETE CASCADE,
  channel             text NOT NULL,
  digest_group_id     uuid NOT NULL,   -- the ORIGINAL tagged group; reconcile links ONLY to this (never reassigns)
  attempts            int  NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code     text,   -- domain reason ('not_ready'|'tagged_mismatch'|'tagged_group_missing'|'requeued') OR a link SQLSTATE
  next_eligible_at    timestamptz NOT NULL DEFAULT now(),
  quarantined         boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_orphan_quarantine_attempted CHECK (quarantined IS FALSE OR attempts > 0),
  -- a quarantined row MUST carry a reason (so requeue/resolve can classify transient vs permanent — never a NULL that
  -- silently slips past permanent-reason validation).
  CONSTRAINT chk_orphan_quarantine_reason CHECK (quarantined IS FALSE OR last_error_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_orphan_reconcile_due
  ON public.notification_orphan_reconcile_state (channel, next_eligible_at, resend_event_id) WHERE NOT quarantined;
CREATE INDEX IF NOT EXISTS idx_orphan_reconcile_channel ON public.notification_orphan_reconcile_state (channel);
ALTER TABLE public.notification_orphan_reconcile_state ENABLE ROW LEVEL SECURITY;
-- ACL: REVOKE from service_role FIRST (default-privilege footgun, #611), then SELECT ONLY — all MUTATIONS go through
-- the owner-executed SECURITY DEFINER functions below.
REVOKE ALL ON TABLE public.notification_orphan_reconcile_state FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.notification_orphan_reconcile_state TO service_role;
COMMENT ON TABLE public.notification_orphan_reconcile_state IS
  '10c-a3: durable, indexed orphan reconcile queue. Retains the ORIGINAL tagged digest_group_id (reconcile links only to it). Enrolled ATOMICALLY by apply_notification_provider_event; drained by reconcile_orphan_provider_events. service_role SELECT-only.';

-- ── APPEND-ONLY operator-action audit (who requeued/resolved a stuck orphan, when, and why) ───────────────────
CREATE TABLE IF NOT EXISTS public.notification_orphan_reconcile_actions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resend_event_id  text NOT NULL,
  action           text NOT NULL CHECK (action IN ('requeue', 'resolve')),
  prior_error_code text,                 -- the last_error_code at the time of the action (why it was stuck)
  actor            text NOT NULL,        -- operator identity supplied by the caller (PR-2's audited wrapper)
  reason           text NOT NULL,        -- non-blank human justification
  acted_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orphan_actions_event ON public.notification_orphan_reconcile_actions (resend_event_id, acted_at);
ALTER TABLE public.notification_orphan_reconcile_actions ENABLE ROW LEVEL SECURITY;
-- APPEND-ONLY: even the owner-executed functions only INSERT; nobody gets UPDATE/DELETE. service_role may read.
REVOKE ALL ON TABLE public.notification_orphan_reconcile_actions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.notification_orphan_reconcile_actions TO service_role;
-- lock the IDENTITY sequence too: no role writes it directly (the owner SECURITY DEFINER functions advance it).
REVOKE ALL ON SEQUENCE public.notification_orphan_reconcile_actions_id_seq FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.notification_orphan_reconcile_actions IS
  '10c-a3: append-only audit of operator requeue/resolve actions on the orphan reconcile queue (actor/reason/time). service_role SELECT-only; UPDATE/DELETE blocked for EVERYONE incl. the owner (immutable-row trigger).';
-- Grants block the API roles, but the table OWNER (and any SECURITY DEFINER function running as owner) would still be
-- able to rewrite or delete history. A trigger makes the audit OWNER-EFFECTIVELY append-only: no row may ever be
-- updated or deleted, by anyone. (An intentional retention purge would require dropping the trigger deliberately.)
CREATE OR REPLACE FUNCTION public.notification_orphan_reconcile_actions_immutable()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'notification_orphan_reconcile_actions is append-only: % is not permitted', TG_OP;
END $$;
REVOKE ALL ON FUNCTION public.notification_orphan_reconcile_actions_immutable() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_orphan_actions_immutable ON public.notification_orphan_reconcile_actions;
CREATE TRIGGER trg_orphan_actions_immutable
  BEFORE UPDATE OR DELETE ON public.notification_orphan_reconcile_actions
  FOR EACH ROW EXECUTE FUNCTION public.notification_orphan_reconcile_actions_immutable();
-- TRUNCATE bypasses row-level triggers, so guard it with a STATEMENT-level trigger too (owner-effective too).
DROP TRIGGER IF EXISTS trg_orphan_actions_no_truncate ON public.notification_orphan_reconcile_actions;
CREATE TRIGGER trg_orphan_actions_no_truncate
  BEFORE TRUNCATE ON public.notification_orphan_reconcile_actions
  FOR EACH STATEMENT EXECUTE FUNCTION public.notification_orphan_reconcile_actions_immutable();

-- ── apply_notification_provider_event (re-emit): tag-faithful, loud on invalid tag, atomic enrollment ───────────
CREATE OR REPLACE FUNCTION public.apply_notification_provider_event(
    p_run_id uuid, p_resend_event_id text, p_provider_message_id text, p_digest_group_id uuid,
    p_status text, p_occurred_at timestamptz, p_now timestamptz)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_group_id uuid; v_channel text; v_inserted int := 0; v_bind text; v_now timestamptz := coalesce(p_now, now());
  v_ex_pm text; v_ex_status text; v_ex_found boolean;
BEGIN
  -- 1. EVENT-FIRST IDEMPOTENCY (before ANY tag/run validation): a retry of an already-recorded resend_event_id is a
  --    duplicate regardless of later group deletion or run completion. Locks the EVENT first (global EVENT → GROUP
  --    order, matching link_). A collision (same id, different immutable provider payload) fails loudly.
  SELECT provider_message_id, status, true INTO v_ex_pm, v_ex_status, v_ex_found
    FROM public.notification_provider_events WHERE resend_event_id = p_resend_event_id FOR UPDATE;
  IF v_ex_found THEN
    IF v_ex_pm IS DISTINCT FROM p_provider_message_id OR v_ex_status IS DISTINCT FROM p_status THEN
      RAISE EXCEPTION 'apply_notification_provider_event: resend_event_id % collision (recorded %/% vs supplied %/%)',
        p_resend_event_id, v_ex_pm, v_ex_status, p_provider_message_id, p_status;
    END IF;
    RETURN 'duplicate';
  END IF;

  -- 2. NEW event: validate any supplied run as an UNFINISHED email/dispatch run BEFORE any mutation or attribution.
  IF p_run_id IS NOT NULL THEN PERFORM notif_digest_assert_run(p_run_id, 'dispatch', 'email'); END IF;

  -- 3. tag/channel resolution (unknown/stale/wrong-channel = LOUD; untagged-no-match = not_digest, nothing stored).
  IF p_digest_group_id IS NOT NULL THEN
    SELECT channel INTO v_channel FROM public.notification_digest_groups WHERE id = p_digest_group_id;
    IF v_channel IS NULL THEN RAISE EXCEPTION 'apply_notification_provider_event: unknown/stale digest_group_id % (a present tag must resolve)', p_digest_group_id; END IF;
    IF v_channel <> 'email' THEN RAISE EXCEPTION 'apply_notification_provider_event: digest_group_id % is channel %, not email', p_digest_group_id, v_channel; END IF;
    v_group_id := p_digest_group_id;
  ELSE
    SELECT id, channel INTO v_group_id, v_channel FROM public.notification_digest_groups WHERE provider_message_id = p_provider_message_id;
    IF v_group_id IS NULL OR v_channel IS DISTINCT FROM 'email' THEN RETURN 'not_digest'; END IF;
  END IF;

  -- 4. store the NEW event (event lock). ON CONFLICT covers a concurrent insert since the step-1 SELECT held no lock
  --    on a not-yet-existing row; re-read + classify as duplicate/collision.
  INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, digest_group_id, status, occurred_at, received_at)
  VALUES (p_resend_event_id, p_provider_message_id, NULL, p_status, p_occurred_at, v_now)
  ON CONFLICT (resend_event_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;   -- ROW_COUNT is int8 → assign to int (the repo's proven pattern), not boolean
  IF v_inserted = 0 THEN
    SELECT provider_message_id, status INTO v_ex_pm, v_ex_status
      FROM public.notification_provider_events WHERE resend_event_id = p_resend_event_id;
    IF v_ex_pm IS DISTINCT FROM p_provider_message_id OR v_ex_status IS DISTINCT FROM p_status THEN
      RAISE EXCEPTION 'apply_notification_provider_event: resend_event_id % concurrent collision', p_resend_event_id;
    END IF;
    RETURN 'duplicate';
  END IF;

  -- 5. bind the group (GROUP lock, AFTER the event lock) + correlate.
  v_bind := notif_digest_bind_provider_message(v_group_id, p_provider_message_id, v_now);
  IF v_bind = 'ok' THEN
    UPDATE public.notification_provider_events SET digest_group_id = v_group_id WHERE resend_event_id = p_resend_event_id;
    RETURN notif_digest_apply_provider_transition(p_run_id, v_group_id, p_status, v_now);
  END IF;
  -- uncorrelated (no_live_send / mismatch): enrol with the TAG group preserved. reconcile links ONLY to this group.
  INSERT INTO public.notification_orphan_reconcile_state (resend_event_id, channel, digest_group_id, next_eligible_at)
  VALUES (p_resend_event_id, v_channel, v_group_id, v_now) ON CONFLICT (resend_event_id) DO NOTHING;
  IF v_bind = 'mismatch' THEN RETURN 'mismatch'; ELSE RETURN 'orphan'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.apply_notification_provider_event(uuid, text, text, uuid, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_notification_provider_event(uuid, text, text, uuid, text, timestamptz, timestamptz) TO service_role;

-- ── the linker — OWNER-ONLY; validates the run + the group's channel; links ONLY to the given group ────────────
CREATE OR REPLACE FUNCTION public.link_notification_provider_event(
  p_resend_event_id text, p_digest_group_id uuid, p_run_id uuid, p_now timestamptz)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_current uuid; v_pm text; v_status text; v_n int; v_ch text; v_now timestamptz := coalesce(p_now, now());
BEGIN
  IF p_run_id IS NOT NULL THEN
    SELECT channel INTO v_ch FROM public.notification_digest_groups WHERE id = p_digest_group_id;
    PERFORM notif_digest_assert_run(p_run_id, 'dispatch', v_ch);
  END IF;
  SELECT digest_group_id, provider_message_id, status INTO v_current, v_pm, v_status
    FROM public.notification_provider_events WHERE resend_event_id = p_resend_event_id FOR UPDATE;   -- event lock
  IF NOT FOUND THEN RAISE EXCEPTION 'provider event % not found', p_resend_event_id; END IF;
  IF v_current IS NOT NULL THEN
    IF v_current = p_digest_group_id THEN RETURN true; END IF;
    RAISE EXCEPTION 'provider event % already linked to a different group', p_resend_event_id;
  END IF;
  CASE notif_digest_bind_provider_message(p_digest_group_id, v_pm, v_now)   -- group lock (AFTER event lock)
    WHEN 'ok' THEN NULL;
    WHEN 'missing' THEN RAISE EXCEPTION 'link: group % not found', p_digest_group_id;
    WHEN 'mismatch' THEN RAISE EXCEPTION 'link: event % message id does not match group %', p_resend_event_id, p_digest_group_id;
    WHEN 'no_live_send' THEN RAISE EXCEPTION 'link: group % has no live send to correlate', p_digest_group_id;
  END CASE;
  UPDATE public.notification_provider_events SET digest_group_id = p_digest_group_id
   WHERE resend_event_id = p_resend_event_id AND digest_group_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'provider event % link affected % rows (concurrent change)', p_resend_event_id, v_n; END IF;
  PERFORM notif_digest_apply_provider_transition(p_run_id, p_digest_group_id, v_status, v_now);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.link_notification_provider_event(text, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.link_notification_provider_event(p_resend_event_id text, p_digest_group_id uuid)
  RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.link_notification_provider_event(p_resend_event_id, p_digest_group_id, NULL::uuid, now());
$$;
REVOKE ALL ON FUNCTION public.link_notification_provider_event(text, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ── audited recovery — two DISTINCT operator actions, both owner-only and both durably audited ────────────────
-- PERMANENT reasons (an immutable group/event pairing that reconcile can never satisfy) must NOT be blindly
-- requeued (they would re-quarantine on the next pass); they require an explicit human RESOLVE decision.
CREATE OR REPLACE FUNCTION public.notification_orphan_reconcile_permanent_reason(p_code text)
  RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT p_code IN ('tagged_mismatch', 'tagged_group_missing') $$;
REVOKE ALL ON FUNCTION public.notification_orphan_reconcile_permanent_reason(text) FROM PUBLIC, anon, authenticated, service_role;

-- REQUEUE: for genuinely TRANSIENT failures only (a link exception / a not-ready group that later recovered).
CREATE OR REPLACE FUNCTION public.notification_orphan_reconcile_requeue(p_resend_event_id text, p_actor text, p_reason text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_code text;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN RAISE EXCEPTION 'requeue: p_actor is required'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'requeue: p_reason is required'; END IF;
  SELECT last_error_code INTO v_code FROM public.notification_orphan_reconcile_state
   WHERE resend_event_id = p_resend_event_id AND quarantined FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF public.notification_orphan_reconcile_permanent_reason(v_code) THEN
    RAISE EXCEPTION 'requeue: % is a PERMANENT reason (%) — use notification_orphan_reconcile_resolve, not requeue', p_resend_event_id, v_code;
  END IF;
  INSERT INTO public.notification_orphan_reconcile_actions (resend_event_id, action, prior_error_code, actor, reason)
  VALUES (p_resend_event_id, 'requeue', v_code, p_actor, p_reason);
  UPDATE public.notification_orphan_reconcile_state
     SET quarantined = false, attempts = 0, last_error_code = 'requeued', next_eligible_at = now(), updated_at = now()
   WHERE resend_event_id = p_resend_event_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.notification_orphan_reconcile_requeue(text, text, text) FROM PUBLIC, anon, authenticated, service_role;

-- RESOLVE / ACKNOWLEDGE: for PERMANENT mismatches. Records actor/reason/time durably (append-only), PRESERVES the
-- provider event, and DEQUEUES the row so it stops counting toward the operational backlog. Reconcile can never fix
-- these on its own, so an explicit human decision is the only way they leave the queue.
CREATE OR REPLACE FUNCTION public.notification_orphan_reconcile_resolve(p_resend_event_id text, p_actor text, p_reason text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_code text; v_quar boolean;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN RAISE EXCEPTION 'resolve: p_actor is required'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'resolve: p_reason is required'; END IF;
  SELECT last_error_code, quarantined INTO v_code, v_quar FROM public.notification_orphan_reconcile_state
   WHERE resend_event_id = p_resend_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  -- resolve DELETES the row, so it must NEVER discard active/transient work: only a QUARANTINED row with a PERMANENT
  -- reason (a pairing reconcile can never satisfy) may be resolved. A non-quarantined row is still live; a
  -- transient quarantine must be REQUEUEd (retried), not dropped.
  IF NOT v_quar THEN
    RAISE EXCEPTION 'resolve: % is not quarantined — active/transient work cannot be resolved (would lose a correlatable callback)', p_resend_event_id;
  END IF;
  -- FAIL-CLOSED: only a KNOWN permanent reason may be resolved. IS NOT TRUE rejects both a NULL code and any unknown/
  -- transient reason (NOT NULL would let a NULL slip through as "not-false").
  IF public.notification_orphan_reconcile_permanent_reason(v_code) IS NOT TRUE THEN
    RAISE EXCEPTION 'resolve: % has reason % which is not a KNOWN permanent reason — only tagged_mismatch/tagged_group_missing may be resolved (use requeue for transient)', p_resend_event_id, coalesce(v_code, '<null>');
  END IF;
  INSERT INTO public.notification_orphan_reconcile_actions (resend_event_id, action, prior_error_code, actor, reason)
  VALUES (p_resend_event_id, 'resolve', v_code, p_actor, p_reason);
  DELETE FROM public.notification_orphan_reconcile_state WHERE resend_event_id = p_resend_event_id;  -- provider event untouched
  RETURN true;
END $$;
-- OWNER-ONLY: both recoveries are reviewed actions; PR-2 exposes them only through an authorized operator wrapper.
REVOKE ALL ON FUNCTION public.notification_orphan_reconcile_resolve(text, text, text) FROM PUBLIC, anon, authenticated, service_role;

-- ── the bounded, claim-first, tag-faithful reconcile RPC ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reconcile_orphan_provider_events(
  p_run_id uuid, p_channel text, p_now timestamptz, p_limit int)
  RETURNS TABLE (examined int, linked int, errors int, deferred int, quarantined int, has_more boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record; v_epm text; v_linked_gid uuid; v_gpm text; v_grp_found boolean;
  v_examined int := 0; v_linked int := 0; v_errors int := 0; v_deferred int := 0; v_quar int := 0;
  v_sqlstate text; v_now timestamptz := coalesce(p_now, now());
  c_max_attempts constant int := 8; c_gauge_cap constant int := 1000;
BEGIN
  IF p_channel IS NULL OR btrim(p_channel) = '' THEN RAISE EXCEPTION 'reconcile: p_channel is required (nonblank)'; END IF;
  IF p_channel <> 'email' THEN RAISE EXCEPTION 'reconcile: p_channel % unsupported (this Resend path is email-only)', p_channel; END IF;
  PERFORM notif_digest_assert_run(p_run_id, 'dispatch', p_channel);
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION 'reconcile: p_limit must be between 1 and 1000, got %', p_limit; END IF;

  FOR r IN
    SELECT rs.resend_event_id, rs.digest_group_id
      FROM public.notification_orphan_reconcile_state rs
     WHERE rs.channel = p_channel AND NOT rs.quarantined AND rs.next_eligible_at <= v_now
     ORDER BY rs.next_eligible_at
     LIMIT p_limit
     FOR UPDATE OF rs SKIP LOCKED
  LOOP
    v_examined := v_examined + 1;
    SELECT pe.provider_message_id, pe.digest_group_id INTO v_epm, v_linked_gid
      FROM public.notification_provider_events pe WHERE pe.resend_event_id = r.resend_event_id;
    IF NOT FOUND OR v_linked_gid IS NOT NULL THEN
      DELETE FROM public.notification_orphan_reconcile_state WHERE resend_event_id = r.resend_event_id;  -- stale → cleanup
      CONTINUE;
    END IF;
    -- classify against the ORIGINAL tagged group ONLY (never a provider-message-id search over other groups).
    SELECT provider_message_id INTO v_gpm
      FROM public.notification_digest_groups WHERE id = r.digest_group_id;
    v_grp_found := FOUND;
    IF NOT v_grp_found THEN
      -- the tagged group was DELETED → PERMANENT (reconcile can never bind it) → quarantine immediately, no pointless
      -- retries. Distinct from "exists but unbound" below.
      v_errors := v_errors + 1;
      RAISE WARNING 'reconcile: event % tagged group % is missing — quarantined', r.resend_event_id, r.digest_group_id;
      UPDATE public.notification_orphan_reconcile_state rs
         SET attempts = rs.attempts + 1, quarantined = true, last_error_code = 'tagged_group_missing', updated_at = now()
       WHERE rs.resend_event_id = r.resend_event_id;
      CONTINUE;
    ELSIF v_gpm IS NULL THEN
      -- early orphan: the tagged group EXISTS but has not bound its provider_message_id yet → durably DEFER (temporary).
      UPDATE public.notification_orphan_reconcile_state rs
         SET attempts = rs.attempts + 1, last_error_code = 'not_ready',
             next_eligible_at = v_now + (least(power(2, rs.attempts + 1)::int, 1440) || ' minutes')::interval,
             quarantined = (rs.attempts + 1 >= c_max_attempts), updated_at = now()
       WHERE rs.resend_event_id = r.resend_event_id;
      CONTINUE;
    ELSIF v_gpm <> v_epm THEN
      -- TAGGED MISMATCH: the tagged group bound a DIFFERENT message id → hard conflict → QUARANTINE + alert (never
      -- reassign to whatever group holds this provider_message_id).
      v_errors := v_errors + 1;
      RAISE WARNING 'reconcile: event % is a tagged mismatch (group % bound a different message id) — quarantined', r.resend_event_id, r.digest_group_id;
      UPDATE public.notification_orphan_reconcile_state rs
         SET attempts = rs.attempts + 1, quarantined = true, last_error_code = 'tagged_mismatch', updated_at = now()
       WHERE rs.resend_event_id = r.resend_event_id;
      CONTINUE;
    END IF;
    BEGIN   -- tagged group is bound to THIS event's message id → link + apply under the run id
      IF public.link_notification_provider_event(r.resend_event_id, r.digest_group_id, p_run_id, v_now) THEN
        v_linked := v_linked + 1;
        DELETE FROM public.notification_orphan_reconcile_state WHERE resend_event_id = r.resend_event_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
      v_errors := v_errors + 1;
      RAISE WARNING 'reconcile: event % failed to link (sqlstate %)', r.resend_event_id, v_sqlstate;
      UPDATE public.notification_orphan_reconcile_state rs
         SET attempts = rs.attempts + 1, last_error_code = v_sqlstate,
             next_eligible_at = v_now + (least(power(2, rs.attempts + 1)::int, 1440) || ' minutes')::interval,
             quarantined = (rs.attempts + 1 >= c_max_attempts), updated_at = now()
       WHERE rs.resend_event_id = r.resend_event_id;
    END;
  END LOOP;

  -- SEPARATE saturated gauges (bounded scans): temporary DEFERRED (not-quarantined, future) vs QUARANTINED
  -- (permanent, needs a reviewed requeue). PR-2: alert (deduped) on quarantined>0 or errors>0; deferred is transient.
  SELECT count(*) INTO v_deferred FROM (SELECT 1 FROM public.notification_orphan_reconcile_state rs
     WHERE rs.channel = p_channel AND NOT rs.quarantined AND rs.next_eligible_at > v_now LIMIT c_gauge_cap + 1) a;
  SELECT count(*) INTO v_quar FROM (SELECT 1 FROM public.notification_orphan_reconcile_state rs
     WHERE rs.channel = p_channel AND rs.quarantined LIMIT c_gauge_cap + 1) b;
  -- CONTINUATION is concurrency-safe: a FULL batch (examined = p_limit) means keep draining; a short pass ends the
  -- loop (rows another worker holds via SKIP LOCKED are its responsibility — never spin waiting on them).
  RETURN QUERY SELECT v_examined, v_linked, v_errors, v_deferred, v_quar, (v_examined = p_limit);
END $$;
COMMENT ON FUNCTION public.reconcile_orphan_provider_events(uuid, text, timestamptz, int) IS
  'Bounded, claim-first, TAG-FAITHFUL orphan reconciliation (links ONLY to the original tagged group; a tagged mismatch is quarantined, never reassigned). email-only. Returns examined/linked/errors/deferred/quarantined/has_more; has_more = examined==p_limit (concurrency-safe drain). PR-2 keeps draining while has_more, alerts (deduped) on errors>0 OR quarantined>0. service_role EXECUTE; queue table SELECT-only.';
REVOKE ALL ON FUNCTION public.reconcile_orphan_provider_events(uuid, text, timestamptz, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_orphan_provider_events(uuid, text, timestamptz, int) TO service_role;
