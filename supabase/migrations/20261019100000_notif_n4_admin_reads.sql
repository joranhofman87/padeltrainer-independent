-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N4 M4 — the platform-admin READ surface (contract findings 4, 11, 13, 15, 16 + the pinned
-- kill/invocation exposure).
--
-- Doctrine, applied to every function here:
--  * FIXED COLUMNS only. enqueue accepts caller JSON, so payload/public_summary are NOT safe
--    for a cross-tenant feed (contract CRITICAL 4) — nothing below returns a payload, a frozen
--    request, a provider response body, or an unredacted destination.
--  * fail-closed platform-admin check; direct table ACLs stay revoked.
--  * keyset everywhere (the M3 pattern: composite (ts, id), both-or-neither cursor, clamp).
--  * bounded windows: p_days CHECK 1..90.
--  * saturating gauges: counts stop at a stated cap and SAY SO (capped=true) instead of
--    scanning an unbounded backlog.
--  * cron is read with a PLAIN SELECT on an allowlisted jobname — no FOR UPDATE (postgres does
--    not own cron.job in prod), and NEVER the command text (finding 13).
--  * the env switch DIGEST_SEND_ENABLED is UNVERIFIABLE from SQL — reported as its own visible
--    line, never inferred, never implied verified (finding 16).
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.notif_admin_gate() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'notification admin surface: platform admin only';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.notif_admin_gate() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notif_admin_gate() TO authenticated, service_role;

-- ── 0. bounded error classification — raw provider text never crosses the tenant boundary ──
-- last_error is worker-supplied free text (raw Resend/Twilio/network messages) and can echo a
-- destination or response fragment; TRUNCATION IS NOT SANITIZATION. Only label-shaped internal
-- codes pass through; everything else collapses to 'provider_error'.
CREATE OR REPLACE FUNCTION public.notif_error_class(p_error text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  -- an explicit ALLOWLIST, not a shape rule: last_error is provider-controlled free text, and
  -- label-SHAPED values can still be PII (a bare phone number, a username, a lowercase token).
  -- Only codes OUR workers write pass; everything else — including unknown future internal
  -- codes, deliberately, fail-closed — reads as provider_error.
  SELECT CASE
    WHEN p_error IS NULL THEN NULL
    WHEN p_error IN (
      'stuck_in_processing',
      'email_suppressed', 'suppression_check_failed', 'consent_check_failed',
      'stop_policy_check_failed', 'missing_subject_or_html', 'missing_destination',
      'invalid_phone', 'no_whatsapp_template', 'whatsapp_not_consented', 'missing_content_sid'
    ) THEN p_error
    ELSE 'provider_error'
  END;
$$;
REVOKE ALL ON FUNCTION public.notif_error_class(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_error_class(text) TO service_role;

-- ── 1. saturating gauges ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_notification_gauges() RETURNS TABLE (
  metric text, channel text, event_type text, value bigint, capped boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  CAP constant int := 10000;
  ch text;
  st text;
  ev text;
  v bigint;
BEGIN
  PERFORM public.notif_admin_gate();
  FOREACH ch IN ARRAY ARRAY['email', 'whatsapp'] LOOP
    FOREACH st IN ARRAY ARRAY['pending', 'processing', 'failed', 'skipped'] LOOP
      SELECT count(*) INTO v FROM (
        SELECT 1 FROM public.notification_outbox o
         WHERE o.channel = ch AND o.status = st LIMIT CAP + 1) b;
      metric := 'outbox_' || st; channel := ch; event_type := NULL;
      value := least(v, CAP); capped := v > CAP;
      RETURN NEXT;
    END LOOP;
    -- the EVENT dimension (which event is failing / backing up): every catalog event x status
    -- pair gets its OWN saturating count — a channel-wide sample could silently omit whole
    -- events under saturation, making "zero" and "not sampled" indistinguishable. The catalog
    -- is bounded, so this loop is too; zero pairs are skipped (their absence is PROVEN zero,
    -- because every pair was counted).
    FOR ev IN SELECT et.key FROM public.notification_event_types et ORDER BY et.key LOOP
      FOREACH st IN ARRAY ARRAY['pending', 'processing', 'failed', 'skipped'] LOOP
        SELECT count(*) INTO v FROM (
          SELECT 1 FROM public.notification_outbox o
           WHERE o.channel = ch AND o.event_type = ev AND o.status = st LIMIT CAP + 1) b;
        IF v > 0 THEN
          metric := 'outbox_by_event_' || st; channel := ch; event_type := ev;
          value := least(v, CAP); capped := v > CAP;
          RETURN NEXT;
        END IF;
      END LOOP;
    END LOOP;
    event_type := NULL;
    -- oldest-pending, split by phase (finding 15): a single "oldest" hides whether the backlog
    -- is unclaimed work, wedged claims, or provider uncertainty
    SELECT coalesce(extract(epoch FROM (now() - min(o.scheduled_for)))::bigint, 0) INTO v
      FROM public.notification_outbox o WHERE o.channel = ch AND o.status = 'pending';
    metric := 'oldest_pending_seconds'; channel := ch; value := greatest(v, 0); capped := false;
    RETURN NEXT;
    SELECT coalesce(extract(epoch FROM (now() - min(o.locked_at)))::bigint, 0) INTO v
      FROM public.notification_outbox o WHERE o.channel = ch AND o.status = 'processing';
    metric := 'oldest_processing_seconds'; channel := ch; value := greatest(v, 0); capped := false;
    RETURN NEXT;
    SELECT coalesce(extract(epoch FROM (now() - min(g.uncertain_since)))::bigint, 0) INTO v
      FROM public.notification_digest_groups g
     WHERE g.channel = ch AND g.uncertain_since IS NOT NULL AND g.terminal_at IS NULL;
    metric := 'oldest_uncertain_seconds'; channel := ch; value := greatest(v, 0); capped := false;
    RETURN NEXT;
    SELECT count(*) INTO v FROM (
      SELECT 1 FROM public.notification_digest_groups g
       WHERE g.channel = ch AND g.terminal_at IS NULL LIMIT CAP + 1) b;
    metric := 'digest_groups_live'; channel := ch; value := least(v, CAP); capped := v > CAP;
    RETURN NEXT;
    SELECT count(*) INTO v FROM public.notification_channel_kill_switches k WHERE k.channel = ch;
    metric := 'channel_killed'; channel := ch; value := v; capped := false;
    RETURN NEXT;
  END LOOP;
  SELECT count(*) INTO v FROM (
    SELECT 1 FROM public.notification_orphan_reconcile_state s WHERE s.quarantined LIMIT CAP + 1) b;
  metric := 'orphans_quarantined'; channel := NULL; event_type := NULL;
  value := least(v, CAP); capped := v > CAP;
  RETURN NEXT;
  SELECT count(*) INTO v FROM public.notification_worker_invocations i WHERE i.status IN ('pending', 'started');
  metric := 'invocations_unresolved'; channel := NULL; event_type := NULL; value := v; capped := false;   -- single-flight: structurally 0..1
  RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.admin_notification_gauges() IS
  'N4 M4: saturating pipeline gauges — counts stop at 10000 and say so (capped=true); oldest-pending split pending/processing/uncertain; kill + quarantine + unresolved-invocation exposure. Fixed rows, admin fail-closed.';
REVOKE ALL ON FUNCTION public.admin_notification_gauges() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_notification_gauges() TO authenticated, service_role;

-- ── 2. the outbox feed ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_list_notification_outbox(
  p_channel text DEFAULT NULL,
  p_event_type text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_days int DEFAULT 7,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_limit int DEFAULT 50
) RETURNS TABLE (
  id uuid, channel text, event_type text, template_key text, status text,
  skip_reason text, error_class text, destination_redacted text, delivery_mode text,
  attempts int, max_attempts int, scheduled_for timestamptz,
  tenant_academy_profile_id uuid, tenant_trainer_id uuid,
  created_at timestamptz, updated_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.notif_admin_gate();
  IF p_days IS NULL OR p_days NOT BETWEEN 1 AND 90 THEN
    RAISE EXCEPTION 'admin_list_notification_outbox: p_days must be 1..90';
  END IF;
  IF (p_before_created_at IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'admin_list_notification_outbox: a keyset cursor needs BOTH created_at and id (or neither)';
  END IF;
  RETURN QUERY
  SELECT o.id, o.channel, o.event_type, o.template_key, o.status,
         o.skip_reason, public.notif_error_class(o.last_error), o.destination_redacted, o.delivery_mode,
         o.attempts, o.max_attempts, o.scheduled_for,
         o.tenant_academy_profile_id, o.tenant_trainer_id,
         o.created_at, o.updated_at
    FROM public.notification_outbox o
   WHERE o.created_at >= now() - make_interval(days => p_days)
     AND (p_channel IS NULL OR o.channel = p_channel)
     AND (p_event_type IS NULL OR o.event_type = p_event_type)
     AND (p_status IS NULL OR o.status = p_status)
     AND (p_before_created_at IS NULL OR (o.created_at, o.id) < (p_before_created_at, p_before_id))
   ORDER BY o.created_at DESC, o.id DESC
   LIMIT LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
END;
$$;
COMMENT ON FUNCTION public.admin_list_notification_outbox(text, text, text, int, timestamptz, uuid, int) IS
  'N4 M4: cross-tenant outbox feed — FIXED columns (no payload: enqueue accepts caller JSON and no sanitizer makes it cross-tenant-safe), redacted destination only, last_error truncated, p_days 1..90, composite keyset, clamp 1..200.';
REVOKE ALL ON FUNCTION public.admin_list_notification_outbox(text, text, text, int, timestamptz, uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_notification_outbox(text, text, text, int, timestamptz, uuid, int) TO authenticated, service_role;

-- ── 3. the digest-group feed ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_list_digest_groups(
  p_channel text DEFAULT NULL,
  p_state text DEFAULT NULL,
  p_days int DEFAULT 7,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_limit int DEFAULT 50
) RETURNS TABLE (
  id uuid, channel text, event_type text, state text, terminal_reason text,
  item_count int, provider_attempts_started int, delivery_budget_used int,
  digest_boundary_at timestamptz, available_at timestamptz,
  locked_by text, worker_run_id uuid, provider_message_id text, provider_status text,
  uncertain_since timestamptz, first_send_at timestamptz,
  created_at timestamptz, updated_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.notif_admin_gate();
  IF p_days IS NULL OR p_days NOT BETWEEN 1 AND 90 THEN
    RAISE EXCEPTION 'admin_list_digest_groups: p_days must be 1..90';
  END IF;
  IF (p_before_created_at IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'admin_list_digest_groups: a keyset cursor needs BOTH created_at and id (or neither)';
  END IF;
  RETURN QUERY
  SELECT g.id, g.channel, g.event_type, g.state, g.terminal_reason,
         g.item_count, g.provider_attempts_started, g.delivery_budget_used,
         g.digest_boundary_at, g.available_at,
         g.locked_by, g.worker_run_id, g.provider_message_id, g.provider_status,
         g.uncertain_since, g.first_send_at,
         g.created_at, g.updated_at
    FROM public.notification_digest_groups g
   WHERE g.created_at >= now() - make_interval(days => p_days)
     AND (p_channel IS NULL OR g.channel = p_channel)
     AND (p_state IS NULL OR g.state = p_state)
     AND (p_before_created_at IS NULL OR (g.created_at, g.id) < (p_before_created_at, p_before_id))
   ORDER BY g.created_at DESC, g.id DESC
   LIMIT LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
END;
$$;
COMMENT ON FUNCTION public.admin_list_digest_groups(text, text, int, timestamptz, uuid, int) IS
  'N4 M4: digest-group feed — states, provider ids/status, budgets, boundaries; NEVER the frozen request or a destination (only the fingerprinted key exists on groups and it is not returned). p_days 1..90, keyset, clamp.';
REVOKE ALL ON FUNCTION public.admin_list_digest_groups(text, text, int, timestamptz, uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_digest_groups(text, text, int, timestamptz, uuid, int) TO authenticated, service_role;

-- ── 4. worker runs ──────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_list_worker_runs(
  p_days int DEFAULT 7,
  p_before_started_at timestamptz DEFAULT NULL,
  p_before_run_id uuid DEFAULT NULL,
  p_limit int DEFAULT 50
) RETURNS TABLE (
  run_id uuid, worker text, channel text, phase text, status text,
  started_at timestamptz, ended_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.notif_admin_gate();
  IF p_days IS NULL OR p_days NOT BETWEEN 1 AND 90 THEN
    RAISE EXCEPTION 'admin_list_worker_runs: p_days must be 1..90';
  END IF;
  IF (p_before_started_at IS NULL) <> (p_before_run_id IS NULL) THEN
    RAISE EXCEPTION 'admin_list_worker_runs: a keyset cursor needs BOTH started_at and run_id (or neither)';
  END IF;
  RETURN QUERY
  SELECT r.run_id, r.worker, r.channel, r.phase, r.status, r.started_at, r.ended_at
    FROM public.notification_worker_runs r
   WHERE r.started_at >= now() - make_interval(days => p_days)
     AND (p_before_started_at IS NULL OR (r.started_at, r.run_id) < (p_before_started_at, p_before_run_id))
   ORDER BY r.started_at DESC, r.run_id DESC
   LIMIT LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
END;
$$;
COMMENT ON FUNCTION public.admin_list_worker_runs(int, timestamptz, uuid, int) IS
  'N4 M4: worker-run feed (did it run, did it succeed) — p_days 1..90, keyset, clamp.';
REVOKE ALL ON FUNCTION public.admin_list_worker_runs(int, timestamptz, uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_worker_runs(int, timestamptz, uuid, int) TO authenticated, service_role;

-- ── 5. delivery history for ONE outbox row — the lifecycle, typed, bounded, no bodies ───────
CREATE OR REPLACE FUNCTION public.admin_notification_delivery_history(
  p_outbox_id uuid,
  p_before_at timestamptz DEFAULT NULL,
  p_before_ref text DEFAULT NULL,
  p_limit int DEFAULT 50
) RETURNS TABLE (
  at timestamptz, kind text, a text, b text, c text, ref text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_group uuid;
BEGIN
  PERFORM public.notif_admin_gate();
  IF NOT EXISTS (SELECT 1 FROM public.notification_outbox o WHERE o.id = p_outbox_id) THEN
    RAISE EXCEPTION 'admin_notification_delivery_history: outbox row % does not exist', p_outbox_id;
  END IF;
  IF (p_before_at IS NULL) <> (p_before_ref IS NULL) THEN
    RAISE EXCEPTION 'admin_notification_delivery_history: a keyset cursor needs BOTH at and ref (or neither)';
  END IF;
  SELECT o.digest_group_id INTO v_group
    FROM public.notification_outbox o WHERE o.id = p_outbox_id;
  RETURN QUERY
  SELECT * FROM (
    -- the row itself: status + redacted destination + CLASSIFIED error (raw provider text is
    -- worker-supplied and can echo a destination — it never crosses this boundary)
    SELECT o.created_at AS at, 'outbox_created'::text AS kind,
           o.event_type AS a, o.channel AS b, o.destination_redacted AS c,
           'ob-created:' || o.id::text AS ref
      FROM public.notification_outbox o WHERE o.id = p_outbox_id
    UNION ALL
    SELECT o.updated_at, 'outbox_state', o.status,
           coalesce(o.skip_reason, public.notif_error_class(o.last_error)), o.attempts::text,
           'ob-state:' || o.id::text
      FROM public.notification_outbox o WHERE o.id = p_outbox_id
    UNION ALL
    -- INSTANT delivery outcomes: the email delivery-event ledger, joined on the provider
    -- message id this row was accepted under. Typed columns only — reason and the raw
    -- recipient are deliberately omitted (finding 4).
    -- joined on outbox_id (the foundation migration generalized this ledger and both instant
    -- workers populate it): send_failed rows deliberately carry NO provider id, and an earlier
    -- attempt's outcome must not vanish when the row's current provider id changes
    SELECT de.occurred_at, 'delivery_event', de.event_type, de.bounce_type, de.resend_email_id,
           'de:' || de.id::text
      FROM public.email_delivery_events de
     WHERE de.outbox_id = p_outbox_id
    UNION ALL
    -- digest attempts (when the row is a digest member): outcome_class + http + provider id
    SELECT a2.started_at, 'digest_attempt', a2.outcome_class,
           a2.http_status::text, a2.provider_message_id,
           'da:' || a2.attempt_id::text
      FROM public.notification_digest_attempts a2
     WHERE v_group IS NOT NULL AND a2.digest_group_id = v_group
    UNION ALL
    -- provider events: status transitions only — never a body
    SELECT e.received_at, 'provider_event', e.status, e.provider_message_id, NULL::text,
           'pe:' || e.resend_event_id
      FROM public.notification_provider_events e
     WHERE v_group IS NOT NULL AND e.digest_group_id = v_group
    UNION ALL
    SELECT s2.updated_at, 'orphan_state',
           CASE WHEN s2.quarantined THEN 'quarantined' ELSE 'reconciling' END,
           s2.last_error_code, s2.attempts::text,
           'orphan:' || s2.resend_event_id
      FROM public.notification_orphan_reconcile_state s2
     WHERE v_group IS NOT NULL AND s2.digest_group_id = v_group
  ) t
  WHERE p_before_at IS NULL OR (t.at, t.ref) < (p_before_at, p_before_ref)
  ORDER BY t.at DESC, t.ref DESC
  LIMIT LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
END;
$$;
COMMENT ON FUNCTION public.admin_notification_delivery_history(uuid, timestamptz, text, int) IS
  'N4 M4: one outbox row''s lifecycle as typed timeline rows — outbox state (error CLASSIFIED, never raw), INSTANT delivery events (email_delivery_events via the provider message id; reason/recipient omitted), digest attempts, provider-event transitions, orphan state. Bounded: composite (at, ref) keyset, both-or-neither cursor, clamp 1..200. Never a payload or provider response body.';
REVOKE ALL ON FUNCTION public.admin_notification_delivery_history(uuid, timestamptz, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_notification_delivery_history(uuid, timestamptz, text, int) TO authenticated, service_role;

-- ── 6. per-event, PER-AUTHORITY state — each authority its own column, honestly (finding 16) ─
CREATE OR REPLACE FUNCTION public.admin_notification_event_states() RETURNS TABLE (
  event_type text, channel text,
  catalog_supported boolean, catalog_default text, required_delivery boolean,
  digest_engine_enabled boolean,
  academy_off_caps int,
  cron_state text,          -- 'active' | 'inactive' | 'absent' | 'unavailable' (no pg_cron / no read)
  circuit_state text,       -- circuit row state, or 'none'
  circuit_reason text,      -- the trip reason label (internal enum-ish; needed for the M5 typed confirmation)
  circuit_tripped_at timestamptz,   -- the trip VERSION the reset confirmation must name
  kill_state text,          -- 'killed' | 'live' — authoritative DB state (the pinned exposure)
  send_env text,            -- ALWAYS 'unverifiable': DIGEST_SEND_ENABLED is an edge env var no SQL can read
  instant_conclusion text,  -- the instant path: no cron/env authority applies to it
  digest_conclusion text    -- the digest path: engine + cron + the unverifiable env all apply
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cron text;
BEGIN
  PERFORM public.notif_admin_gate();
  -- finding 13: a PLAIN SELECT on an allowlisted jobname; no FOR UPDATE (postgres does not own
  -- cron.job on hosted supabase), and NEVER the command text. Absence of pg_cron or of read
  -- privilege reads as its own honest value, not as a guess.
  BEGIN
    SELECT CASE WHEN j.active THEN 'active' ELSE 'inactive' END INTO v_cron
      FROM cron.job j WHERE j.jobname = 'notification-digest-worker' LIMIT 1;
    IF v_cron IS NULL THEN v_cron := 'absent'; END IF;
  EXCEPTION WHEN OTHERS THEN
    v_cron := 'unavailable';
  END;

  RETURN QUERY
  SELECT et.key, ch.channel,
         CASE ch.channel WHEN 'email' THEN et.supports_email ELSE et.supports_whatsapp END,
         CASE ch.channel WHEN 'email' THEN et.default_email_frequency ELSE et.default_whatsapp_frequency END,
         et.required_delivery,
         et.digest_engine_enabled,
         (SELECT count(*)::int FROM public.academy_notification_restrictions r
           WHERE r.event_type = et.key AND r.channel = ch.channel AND r.max_frequency = 'off'),
         v_cron,
         coalesce((SELECT cb.state FROM public.notification_provider_circuit cb WHERE cb.channel = ch.channel), 'none'),
         (SELECT cb.reason FROM public.notification_provider_circuit cb WHERE cb.channel = ch.channel),
         (SELECT cb.tripped_at FROM public.notification_provider_circuit cb WHERE cb.channel = ch.channel),
         CASE WHEN EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = ch.channel)
              THEN 'killed' ELSE 'live' END,
         'unverifiable'::text,
         -- INSTANT: kill / circuit / catalog are its only authorities — no cron, no env
         CASE
           WHEN EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = ch.channel) THEN 'stopped'
           WHEN coalesce((SELECT cb.state FROM public.notification_provider_circuit cb WHERE cb.channel = ch.channel), 'closed') IN ('open', 'half_open') THEN 'stopped'
           WHEN NOT (CASE ch.channel WHEN 'email' THEN et.supports_email ELSE et.supports_whatsapp END) THEN 'stopped'
           ELSE 'sendable'
         END,
         -- DIGEST: engine + cron are additional DEFINITIVE authorities; an active chain still
         -- ends 'unknown' because DIGEST_SEND_ENABLED is unverifiable from SQL — the digest
         -- path can NEVER conclude 'sendable' here, and says so rather than implying a check
         CASE
           WHEN EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = ch.channel) THEN 'stopped'
           WHEN coalesce((SELECT cb.state FROM public.notification_provider_circuit cb WHERE cb.channel = ch.channel), 'closed') IN ('open', 'half_open') THEN 'stopped'
           WHEN NOT (CASE ch.channel WHEN 'email' THEN et.supports_email ELSE et.supports_whatsapp END) THEN 'stopped'
           WHEN NOT et.digest_engine_enabled THEN 'stopped'
           WHEN v_cron IN ('inactive', 'absent') THEN 'stopped'
           ELSE 'unknown'   -- engine on + cron active/unavailable: the env has the last word, and SQL cannot read it
         END
    FROM public.notification_event_types et
    CROSS JOIN (VALUES ('email'), ('whatsapp')) AS ch(channel);
END;
$$;
COMMENT ON FUNCTION public.admin_notification_event_states() IS
  'N4 M4 (finding 16): per event x channel, EVERY authority reported separately — catalog, engine flag, academy off-caps, cron (plain allowlisted SELECT, no command, absence/no-read honest), circuit, kill (authoritative DB state), and send_env ALWAYS ''unverifiable'' (DIGEST_SEND_ENABLED is an edge env var no SQL can read — the UI must show this line, not a tooltip). Conclusion is the honest tri-state: stopped on any definitive SQL-visible stop; unknown when the path depends on the unverifiable env; sendable only when every SQL-visible authority allows and none is unverifiable.';
REVOKE ALL ON FUNCTION public.admin_notification_event_states() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_notification_event_states() TO authenticated, service_role;

-- ── read-work bounds (M4 round-2 finding 4): the readers' scans need leading indexes — an
-- outer LIMIT bounds the OUTPUT, not the union/sort work underneath it ─────────────────────
CREATE INDEX IF NOT EXISTS idx_ede_outbox_timeline
  ON public.email_delivery_events (outbox_id, occurred_at DESC, id DESC)
  WHERE outbox_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_digest_attempts_timeline
  ON public.notification_digest_attempts (digest_group_id, started_at DESC, attempt_id DESC);
CREATE INDEX IF NOT EXISTS idx_provider_events_timeline
  ON public.notification_provider_events (digest_group_id, received_at DESC, resend_event_id DESC);
CREATE INDEX IF NOT EXISTS idx_orphan_state_timeline
  ON public.notification_orphan_reconcile_state (digest_group_id, updated_at DESC, resend_event_id DESC);
-- the oldest-age gauges: partial, channel-leading
CREATE INDEX IF NOT EXISTS idx_outbox_oldest_pending
  ON public.notification_outbox (channel, scheduled_for) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_oldest_processing
  ON public.notification_outbox (channel, locked_at) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_digest_groups_oldest_uncertain
  ON public.notification_digest_groups (channel, uncertain_since)
  WHERE uncertain_since IS NOT NULL AND terminal_at IS NULL;

-- ── 7. the orphan queue (M7 exposed the gap: resolve/requeue controls need a LIST) ──────────
CREATE OR REPLACE FUNCTION public.admin_list_notification_orphans(
  p_before_updated_at timestamptz DEFAULT NULL,
  p_before_event_id text DEFAULT NULL,
  p_limit int DEFAULT 50
) RETURNS TABLE (
  resend_event_id text,
  channel text,
  digest_group_id uuid,
  attempts int,
  last_error_code text,
  quarantined boolean,
  next_eligible_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.notif_admin_gate();
  IF (p_before_updated_at IS NULL) <> (p_before_event_id IS NULL) THEN
    RAISE EXCEPTION 'admin_list_notification_orphans: a keyset cursor needs BOTH updated_at and event id (or neither)';
  END IF;
  RETURN QUERY
  SELECT s.resend_event_id, s.channel, s.digest_group_id, s.attempts,
         s.last_error_code, s.quarantined, s.next_eligible_at, s.updated_at
    FROM public.notification_orphan_reconcile_state s
   WHERE p_before_updated_at IS NULL
      OR (s.updated_at, s.resend_event_id) < (p_before_updated_at, p_before_event_id)
   ORDER BY s.quarantined DESC, s.updated_at DESC, s.resend_event_id DESC
   LIMIT LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
END;
$$;
COMMENT ON FUNCTION public.admin_list_notification_orphans(timestamptz, text, int) IS
  'N4 M7: the orphan reconcile queue, quarantined-first — fixed columns (ids, codes, states; no provider bodies), composite keyset, clamp 1..200, admin fail-closed. The resolve/requeue controls act on these rows.';
REVOKE ALL ON FUNCTION public.admin_list_notification_orphans(timestamptz, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_notification_orphans(timestamptz, text, int) TO authenticated, service_role;
