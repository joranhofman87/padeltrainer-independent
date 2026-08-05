-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N4 M6 — READINESS ENVELOPE + RECIPIENT PROVENANCE PREVIEW + DESTINATION SEARCH
-- (contract findings 9, 10, 12; M4/M5 pins carried: kill state is authoritative DB state, the
-- env switch is UNVERIFIABLE from SQL and says so; search is masked/exact-safe — NEVER a
-- substring over raw destinations).
--
-- HONESTY BOUNDARIES, stated up front:
--  * The N5-dependent checks (durable activation boundary, zero-backlog proof) do not exist
--    yet. They are reported as status 'not_provable' — never invented, never omitted — and the
--    overall readiness can therefore NEVER be 'pass' before N5 ships them.
--  * The preview covers the RESOLVER stages (preference → cap → required override → contact/
--    consent → suppression) for a named user. It does NOT enumerate a producer's audience
--    (who a booking/slot event would fan out to is producer business logic, not resolver
--    state); the per-event recipient list is bounded to users holding preference rows or
--    eligible contacts, and says so.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. the readiness envelope (finding 9): versioned, typed, honest ─────────────────────────
CREATE OR REPLACE FUNCTION public.admin_notification_readiness() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  checks jsonb := '[]'::jsonb;
  v bigint; v2 bigint;
  v_cron text;
  v_txt text;
  add_fail boolean := false;
BEGIN
  PERFORM public.notif_admin_gate();

  -- kill switches: authoritative DB state (M4 pin)
  SELECT count(*) INTO v FROM public.notification_channel_kill_switches;
  checks := checks || jsonb_build_object('id', 'channel_kills', 'status', CASE WHEN v = 0 THEN 'pass' ELSE 'fail' END,
    'detail', v || ' channel(s) killed');
  add_fail := add_fail OR v > 0;

  -- circuit state
  SELECT count(*) INTO v FROM public.notification_provider_circuit WHERE state <> 'closed';
  checks := checks || jsonb_build_object('id', 'provider_circuits', 'status', CASE WHEN v = 0 THEN 'pass' ELSE 'fail' END,
    'detail', v || ' circuit(s) not closed');
  add_fail := add_fail OR v > 0;

  -- unresolved deliberate invocations (M1)
  SELECT count(*) INTO v FROM public.notification_worker_invocations WHERE status IN ('pending', 'started');
  checks := checks || jsonb_build_object('id', 'unresolved_invocations', 'status', CASE WHEN v = 0 THEN 'pass' ELSE 'fail' END,
    'detail', v || ' deliberate invocation(s) unresolved');
  add_fail := add_fail OR v > 0;

  -- in-flight work: claimed/sending/uncertain
  SELECT count(*) INTO v FROM public.notification_outbox WHERE status = 'processing';
  SELECT count(*) INTO v2 FROM public.notification_digest_groups
   WHERE state IN ('sending', 'awaiting_evidence') OR (uncertain_since IS NOT NULL AND terminal_at IS NULL);
  checks := checks || jsonb_build_object('id', 'in_flight_work', 'status', CASE WHEN v + v2 = 0 THEN 'pass' ELSE 'fail' END,
    'detail', v || ' instant row(s) processing, ' || v2 || ' digest group(s) mid-send/uncertain');
  add_fail := add_fail OR (v + v2) > 0;

  -- quarantined orphans await a human
  SELECT count(*) INTO v FROM public.notification_orphan_reconcile_state WHERE quarantined;
  checks := checks || jsonb_build_object('id', 'quarantined_orphans', 'status', CASE WHEN v = 0 THEN 'pass' ELSE 'fail' END,
    'detail', v || ' orphan(s) quarantined');
  add_fail := add_fail OR v > 0;

  -- cron IDENTITY, not merely active (finding 9): plain allowlisted SELECT, no command text
  BEGIN
    SELECT CASE WHEN j.active THEN 'active' ELSE 'inactive' END INTO v_cron
      FROM cron.job j WHERE j.jobname = 'notification-digest-worker' LIMIT 1;
    v_txt := coalesce(v_cron, 'absent');
  EXCEPTION WHEN OTHERS THEN
    v_txt := 'unavailable';
  END;
  checks := checks || jsonb_build_object('id', 'digest_cron', 'status',
    CASE v_txt WHEN 'inactive' THEN 'pass' WHEN 'unavailable' THEN 'not_provable' ELSE 'fail' END,
    'detail', 'notification-digest-worker: ' || v_txt || ' (identity/hash verification lives in the reviewed rollout artifacts, not here)');
  add_fail := add_fail OR v_txt IN ('active', 'absent');

  -- THE ENV SWITCH — the visible line, never a tooltip, never implied verified (finding 16)
  checks := checks || jsonb_build_object('id', 'digest_send_enabled_env', 'status', 'not_provable',
    'detail', 'DIGEST_SEND_ENABLED is an edge env var no SQL can read — operator assertion only');

  -- N5-DEPENDENT CHECKS: reported, not invented. Their machinery does not exist yet, so the
  -- envelope can never read pass before N5 ships it.
  checks := checks || jsonb_build_object('id', 'durable_activation_boundary', 'status', 'not_provable',
    'detail', 'N5 not shipped: no durable activation boundary/high-water mark exists yet');
  checks := checks || jsonb_build_object('id', 'pre_activation_backlog_eligible_count', 'status', 'not_provable',
    'detail', 'N5 not shipped: the zero-backlog proof (eligible count = 0 before the boundary) does not exist yet');

  RETURN jsonb_build_object(
    'schema_version', 1,
    'as_of', now(),
    -- 'fail' when anything failed; otherwise 'not_provable' — NEVER 'pass' while any check
    -- cannot be proven (and the N5 checks cannot be, yet)
    'readiness', CASE WHEN add_fail THEN 'fail' ELSE 'not_provable' END,
    'checks', checks
  );
END;
$$;
COMMENT ON FUNCTION public.admin_notification_readiness() IS
  'N4 M6 (finding 9): the versioned readiness envelope {schema_version, as_of, readiness, checks[]}. Named check ids; kill/circuit/invocation/in-flight/orphan/cron states from authoritative DB reads; DIGEST_SEND_ENABLED and the two N5-dependent checks (durable boundary, zero-backlog proof) reported not_provable — the envelope can NEVER read pass before N5 ships them. Overall: fail if anything failed, else not_provable.';
REVOKE ALL ON FUNCTION public.admin_notification_readiness() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_notification_readiness() TO authenticated, service_role;

-- ── 2. per-user decision PROVENANCE (finding 10): every source its own column ───────────────
CREATE OR REPLACE FUNCTION public.admin_preview_notification_decision(
  p_user_id uuid,
  p_event_key text,
  p_channel text,
  p_tenant_academy_profile_id uuid DEFAULT NULL
) RETURNS TABLE (
  event_type text, channel text,
  catalog_supported boolean, catalog_default text, required_delivery boolean,
  explicit_preference text,
  whatsapp_optin_arm boolean,
  academy_cap text, cap_applied boolean,
  required_override_applied boolean,
  final_frequency text,
  contact_found boolean, destination_masked text, suppressed boolean,
  kill_state text, circuit_state text,
  final_decision text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  evt public.notification_event_types%ROWTYPE;
  v_person uuid;
  v_freq text; v_explicit text; v_default text; v_cap text;
  v_optin boolean := false; v_cap_applied boolean := false; v_req boolean := false;
  v_dest text;
BEGIN
  PERFORM public.notif_admin_gate();
  IF p_channel NOT IN ('email', 'whatsapp') THEN
    RAISE EXCEPTION 'admin_preview_notification_decision: unknown channel %', p_channel;
  END IF;
  SELECT * INTO evt FROM public.notification_event_types WHERE key = p_event_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_preview_notification_decision: unknown event %', p_event_key;
  END IF;
  SELECT p.id INTO v_person FROM public.persons p WHERE p.user_id = p_user_id;

  -- STAGE MIRROR of enqueue_notification (20261015120000) — each stage surfaced as its own
  -- column; the equivalence suite proves preview == the real resolver on shared fixtures, so
  -- a resolver change that is not mirrored here FAILS TESTS rather than silently diverging.
  v_default := CASE p_channel WHEN 'email' THEN evt.default_email_frequency ELSE evt.default_whatsapp_frequency END;
  SELECT CASE p_channel WHEN 'email' THEN v2.email_frequency ELSE v2.whatsapp_frequency END
    INTO v_explicit
    FROM public.notification_preferences_v2 v2
   WHERE v2.user_id = p_user_id AND v2.event_type = p_event_key;
  v_freq := v_explicit;
  IF p_channel = 'whatsapp' AND v_freq IS NULL AND evt.whatsapp_optin_via_booking
     AND public.whatsapp_optin_in_scope(v_person, p_user_id, NULL, p_tenant_academy_profile_id, NULL) THEN
    v_optin := true;
    v_freq := 'instant';
  END IF;
  v_freq := coalesce(v_freq, v_default);
  IF NOT evt.required_delivery AND p_tenant_academy_profile_id IS NOT NULL AND v_freq <> 'off' THEN
    SELECT r.max_frequency INTO v_cap
      FROM public.academy_notification_restrictions r
     WHERE r.academy_profile_id = p_tenant_academy_profile_id
       AND r.event_type = p_event_key AND r.channel = p_channel;
    IF FOUND AND public.notif_frequency_rank(v_cap) > public.notif_frequency_rank(v_freq) THEN
      v_freq := v_cap;
      v_cap_applied := true;
    END IF;
  END IF;
  IF evt.required_delivery AND p_channel = 'email' THEN
    v_req := (v_freq <> 'instant');
    v_freq := 'instant';
  END IF;

  -- contact + suppression, the resolver's own predicates
  IF p_channel = 'email' THEN
    SELECT nc.destination_normalized INTO v_dest
      FROM public.notification_contacts nc
     WHERE nc.channel = 'email' AND nc.revoked_at IS NULL AND nc.consent_status <> 'opted_out'
       AND (nc.consent_scope <> 'global' OR p_user_id IS NOT NULL)
       AND public.is_notification_consent_in_scope(
             nc.consent_scope, nc.consent_academy_profile_id, nc.consent_trainer_id,
             p_tenant_academy_profile_id, NULL)
       AND (nc.user_id = p_user_id OR nc.person_id = v_person)
     ORDER BY nc.is_primary DESC, nc.verified_at DESC NULLS LAST
     LIMIT 1;
  ELSE
    SELECT nc.destination_normalized INTO v_dest
      FROM public.notification_contacts nc
     WHERE nc.channel = p_channel AND nc.revoked_at IS NULL AND nc.consent_status = 'opted_in'
       AND (nc.consent_scope <> 'global' OR p_user_id IS NOT NULL)
       AND public.is_notification_consent_in_scope(
             nc.consent_scope, nc.consent_academy_profile_id, nc.consent_trainer_id,
             p_tenant_academy_profile_id, NULL)
       AND (nc.user_id = p_user_id OR nc.person_id = v_person)
     ORDER BY nc.is_primary DESC, nc.verified_at DESC NULLS LAST
     LIMIT 1;
  END IF;

  event_type := p_event_key; channel := p_channel;
  catalog_supported := CASE p_channel WHEN 'email' THEN evt.supports_email ELSE evt.supports_whatsapp END;
  catalog_default := v_default; required_delivery := evt.required_delivery;
  explicit_preference := v_explicit;
  whatsapp_optin_arm := v_optin;
  academy_cap := v_cap; cap_applied := v_cap_applied;
  required_override_applied := v_req;
  final_frequency := v_freq;
  contact_found := v_dest IS NOT NULL;
  destination_masked := CASE WHEN v_dest IS NULL THEN NULL
                             ELSE public.notification_redact_destination(v_dest, p_channel) END;
  suppressed := (p_channel = 'email' AND v_dest IS NOT NULL AND public.is_email_suppressed(v_dest));
  kill_state := CASE WHEN EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = p_channel)
                     THEN 'killed' ELSE 'live' END;
  circuit_state := coalesce((SELECT cb.state FROM public.notification_provider_circuit cb WHERE cb.channel = p_channel), 'none');
  final_decision := CASE
    WHEN v_freq = 'off' THEN 'skip:frequency_off'
    WHEN v_dest IS NULL THEN 'skip:no_contact'
    WHEN p_channel = 'email' AND public.is_email_suppressed(v_dest) THEN 'skip:suppressed'
    ELSE 'deliver:' || v_freq
  END;
  RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.admin_preview_notification_decision(uuid, text, text, uuid) IS
  'N4 M6 (finding 10): one user''s effective-preference PROVENANCE — every contributing source (catalog default, explicit v2 preference, the whatsapp booking-opt-in arm, academy cap, required override, contact/consent, suppression, kill/circuit context) as its own column, plus the final decision. A STAGE MIRROR of enqueue_notification, held honest by the equivalence suite (preview == real resolver on shared fixtures). Masked destination only.';
REVOKE ALL ON FUNCTION public.admin_preview_notification_decision(uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_preview_notification_decision(uuid, text, text, uuid) TO authenticated, service_role;

-- the bounded per-event recipient preview: users with a preference row or an eligible contact
CREATE OR REPLACE FUNCTION public.admin_preview_notification_recipients(
  p_event_key text,
  p_channel text,
  p_tenant_academy_profile_id uuid DEFAULT NULL,
  p_after_user_id uuid DEFAULT NULL,
  p_limit int DEFAULT 25
) RETURNS TABLE (
  user_id uuid,
  final_frequency text,
  final_decision text,
  destination_masked text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE u record;
BEGIN
  PERFORM public.notif_admin_gate();
  -- STRICT MAX (finding 10: no export-all): the clamp is deliberately small
  FOR u IN
    SELECT DISTINCT cand.uid FROM (
      SELECT v2.user_id AS uid FROM public.notification_preferences_v2 v2 WHERE v2.event_type = p_event_key
      UNION
      SELECT nc.user_id FROM public.notification_contacts nc
       WHERE nc.channel = p_channel AND nc.revoked_at IS NULL AND nc.user_id IS NOT NULL
    ) cand
    WHERE cand.uid IS NOT NULL AND (p_after_user_id IS NULL OR cand.uid > p_after_user_id)
    ORDER BY cand.uid
    LIMIT LEAST(GREATEST(coalesce(p_limit, 25), 1), 50)
  LOOP
    RETURN QUERY
    SELECT u.uid, d.final_frequency, d.final_decision, d.destination_masked
      FROM public.admin_preview_notification_decision(u.uid, p_event_key, p_channel, p_tenant_academy_profile_id) d;
  END LOOP;
END;
$$;
COMMENT ON FUNCTION public.admin_preview_notification_recipients(text, text, uuid, uuid, int) IS
  'N4 M6 (finding 10): bounded keyset recipient preview per event/channel — the users holding a preference row or an eligible contact, each run through the SAME provenance preview. Clamp 1..50, no export-all. HONESTY BOUNDARY: this previews resolver state, not a producer''s audience — who an event actually fans out to is producer business logic.';
REVOKE ALL ON FUNCTION public.admin_preview_notification_recipients(text, text, uuid, uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_preview_notification_recipients(text, text, uuid, uuid, int) TO authenticated, service_role;

-- ── 3. destination search (finding 12 + the pinned rule) ────────────────────────────────────
-- EXACT normalized input only, compared by SERVER-SIDE FINGERPRINT — never a substring, never
-- a raw-destination scan the planner could leak through. Rate-limited per actor and logged
-- append-only WITHOUT the raw destination (the log stores the fingerprint).
CREATE TABLE public.notification_admin_search_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor       uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{16,128}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_notif_admin_search_guard
  BEFORE UPDATE OR DELETE ON public.notification_admin_search_log
  FOR EACH ROW EXECUTE FUNCTION public.notif_admin_audit_guard();
CREATE TRIGGER trg_notif_admin_search_no_truncate
  BEFORE TRUNCATE ON public.notification_admin_search_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.notif_admin_audit_guard();
REVOKE ALL ON public.notification_admin_search_log FROM PUBLIC, anon, authenticated, service_role;
CREATE INDEX idx_notif_admin_search_rate ON public.notification_admin_search_log (actor, created_at DESC);

CREATE OR REPLACE FUNCTION public.admin_search_notification_destination(
  p_destination text
) RETURNS TABLE (
  destination_masked text,
  contacts int,
  outbox_rows int,
  delivery_events int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm text;
  v_fp text;
  v_rate int;
BEGIN
  PERFORM public.notif_admin_gate();
  v_norm := lower(btrim(coalesce(p_destination, '')));
  IF length(v_norm) < 3 THEN
    RAISE EXCEPTION 'admin_search_notification_destination: an exact destination is required (no partial search exists, by design)';
  END IF;
  -- rate limit BEFORE the lookup: 30 searches / hour / actor
  SELECT count(*) INTO v_rate FROM public.notification_admin_search_log l
   WHERE l.actor = auth.uid() AND l.created_at > now() - interval '1 hour';
  IF v_rate >= 30 THEN
    RAISE EXCEPTION 'admin_search_notification_destination: rate limit reached (30/hour) — searches are logged and bounded by design';
  END IF;
  v_fp := public.notif_digest_destination_fingerprint(v_norm);
  INSERT INTO public.notification_admin_search_log (actor, fingerprint) VALUES (auth.uid(), v_fp);

  RETURN QUERY
  SELECT public.notification_redact_destination(v_norm, 'email'),
         (SELECT count(*)::int FROM public.notification_contacts nc
           WHERE public.notif_digest_destination_fingerprint(nc.destination_normalized) = v_fp),
         (SELECT count(*)::int FROM (
            SELECT 1 FROM public.notification_outbox o
             WHERE o.destination_fingerprint = v_fp
                OR public.notif_digest_destination_fingerprint(o.destination_normalized) = v_fp
             LIMIT 1001) b),
         (SELECT count(*)::int FROM (
            SELECT 1 FROM public.email_delivery_events de
             WHERE public.notif_digest_destination_fingerprint(de.recipient_email) = v_fp
             LIMIT 1001) b2);
END;
$$;
COMMENT ON FUNCTION public.admin_search_notification_destination(text) IS
  'N4 M6 (finding 12): EXACT-match destination lookup — normalized input, server-side fingerprint comparison (never substring, never a raw scan result), masked echo + bounded counts only. Rate-limited 30/hour/actor; every search logged append-only as a FINGERPRINT (the log itself carries no destination).';
REVOKE ALL ON FUNCTION public.admin_search_notification_destination(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_search_notification_destination(text) TO authenticated, service_role;
