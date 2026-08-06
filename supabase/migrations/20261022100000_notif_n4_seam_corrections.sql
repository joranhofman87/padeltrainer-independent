-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N4 SEAM CORRECTIONS — defects visible only when the seven milestones are combined.
--
-- Every one of these was invisible to the per-milestone reviews: each milestone was internally
-- consistent, and the disagreement lived BETWEEN them.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── SEAM 1: the authority matrix reported conclusions the execution paths do not enforce ────
-- Three separate lies, in both directions:
--   * INSTANT was reported 'stopped' on an open circuit — but the instant claim consults ONLY
--     the kill switch (20261017100000); the breaker is a DIGEST-path mechanism (begin_…), so
--     instant email would keep sending while this page said stopped — including under a
--     correlation_mismatch manual hold. The M5 preview's "instant rows released" wording was
--     built on the same wrong model and is corrected in its comment.
--   * DIGEST was reported 'stopped' when digest_engine_enabled=false — but that flag gates
--     ENQUEUE ROUTING only; the worker drains EXISTING groups regardless (the rollout
--     artifacts say so explicitly). Engine-off means "no NEW digest work", not "nothing sends".
--   * INSTANT was reported as having no unverifiable env authority — but the whatsapp worker
--     exits unless WHATSAPP_SEND_ENABLED === 'true'. That is exactly the same class of
--     unverifiable switch as DIGEST_SEND_ENABLED, and it applies to the INSTANT path.
-- the projection GAINS columns, so the return type changes: an explicit DROP is required
-- (CREATE OR REPLACE cannot change a RETURNS TABLE shape). Both are admin readers with no
-- dependents; the grants are re-applied below, as always.
DROP FUNCTION IF EXISTS public.admin_notification_event_states();
CREATE OR REPLACE FUNCTION public.admin_notification_event_states() RETURNS TABLE (
  event_type text, channel text,
  catalog_supported boolean, catalog_default text, required_delivery boolean,
  digest_engine_enabled boolean,     -- ENQUEUE routing only: existing groups still drain
  academy_off_caps int,
  cron_state text,
  circuit_state text,
  circuit_reason text,
  circuit_tripped_at timestamptz,
  kill_state text,
  send_env text,                     -- the channel/path-specific unverifiable env switch
  instant_conclusion text,
  digest_conclusion text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cron text;
BEGIN
  PERFORM public.notif_admin_gate();
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
         -- the env switch that actually governs each channel, named honestly
         CASE ch.channel
           WHEN 'email' THEN 'DIGEST_SEND_ENABLED (digest path only) — unverifiable'
           ELSE 'WHATSAPP_SEND_ENABLED (instant path) — unverifiable'
         END,
         -- INSTANT: kill + catalog are its ONLY DB-visible authorities (the breaker governs the
         -- digest path; the instant claim never reads it). WhatsApp additionally depends on an
         -- unverifiable env switch, so it can never conclude 'sendable' from SQL.
         CASE
           WHEN EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = ch.channel) THEN 'stopped'
           WHEN NOT (CASE ch.channel WHEN 'email' THEN et.supports_email ELSE et.supports_whatsapp END) THEN 'stopped'
           WHEN ch.channel = 'whatsapp' THEN 'unknown'
           ELSE 'sendable'
         END,
         -- DIGEST: kill / circuit / catalog / cron are definitive; the engine flag is NOT a
         -- stop (existing groups drain), so it can only ever leave the verdict 'unknown' —
         -- DIGEST_SEND_ENABLED has the last word and SQL cannot read it.
         CASE
           WHEN EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = ch.channel) THEN 'stopped'
           WHEN coalesce((SELECT cb.state FROM public.notification_provider_circuit cb WHERE cb.channel = ch.channel), 'closed') IN ('open', 'half_open') THEN 'stopped'
           WHEN NOT (CASE ch.channel WHEN 'email' THEN et.supports_email ELSE et.supports_whatsapp END) THEN 'stopped'
           WHEN v_cron IN ('inactive', 'absent') THEN 'stopped'
           ELSE 'unknown'
         END
    FROM public.notification_event_types et
    CROSS JOIN (VALUES ('email'), ('whatsapp')) AS ch(channel);
END;
$$;
COMMENT ON FUNCTION public.admin_notification_event_states() IS
  'N4 (seam-corrected): per event x channel, every authority reported separately AND truthfully against what the execution paths actually enforce — the circuit governs the DIGEST path only (the instant claim reads the kill switch alone); digest_engine_enabled gates ENQUEUE routing only, so it is reported but is NOT a stop (existing groups drain); send_env names the channel-specific unverifiable switch (DIGEST_SEND_ENABLED for the email digest path, WHATSAPP_SEND_ENABLED for the whatsapp instant path). Instant whatsapp therefore can never read sendable from SQL either.';
REVOKE ALL ON FUNCTION public.admin_notification_event_states() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_notification_event_states() TO authenticated, service_role;


-- ── SEAM 4: a row-lock / advisory-lock inversion between M6's two triggers ──────────────────
-- person-sync takes the person-link advisory then row-locks every linked contact; each of those
-- rows' BEFORE trigger then took the per-user CAP advisory. A concurrent direct update holding
-- another of that person's rows and waiting on the same cap advisory closes the cycle, and
-- PostgreSQL must abort one side. The cap advisory now fires on INSERT ONLY — the one path
-- where no other transaction can already hold the new row's lock. On UPDATE the count check
-- still runs (the cap is still enforced), it is simply not serialized against a concurrent
-- insert; the preview below no longer treats an over-cap user as an impossible state.
CREATE OR REPLACE FUNCTION public.notif_contact_cap_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v int;
BEGIN
  IF NEW.effective_user_id IS NOT NULL AND NEW.revoked_at IS NULL THEN
    -- INSERT only: acquiring this while holding an existing row's lock inverts against the
    -- person-sync path (advisory → rows) and deadlocks.
    IF TG_OP = 'INSERT' THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('notif-contact-cap:' || NEW.channel || ':' || NEW.effective_user_id::text, 0));
    END IF;
    SELECT count(*) INTO v FROM (
      SELECT 1 FROM public.notification_contacts nc
       WHERE nc.channel = NEW.channel AND nc.effective_user_id = NEW.effective_user_id
         AND nc.revoked_at IS NULL AND nc.id IS DISTINCT FROM NEW.id
       LIMIT 500) b;
    IF v >= 500 THEN
      RAISE EXCEPTION 'notification_contacts: at most 500 active contacts per user per channel — the bounded recipient crawl depends on this cap';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


-- ── SEAM 5: internal evidence helpers were reachable by service_role ────────────────────────
-- notif_admin_replay_gate / _record_verdict / _record_refusal accept an arbitrary actor and
-- carry no admin gate — they are INTERNAL steps of an audited RPC. A direct service_role call
-- could consume a registry id with no audit row, or append a rejection with no decision. The
-- outer SECURITY DEFINER RPCs run them as the owner, so no role grant is needed at all (the
-- digest state machine revokes its comparable helpers for exactly this reason).
REVOKE ALL ON FUNCTION public.notif_admin_replay_gate(uuid, uuid, text, text, text, text) FROM service_role;
REVOKE ALL ON FUNCTION public.notif_admin_record_verdict(uuid, uuid, text, text, text) FROM service_role;
REVOKE ALL ON FUNCTION public.notif_admin_record_refusal(uuid, uuid, text, text, text, text) FROM service_role;
REVOKE ALL ON FUNCTION public.notif_admin_fingerprint(jsonb) FROM service_role;


-- ── SEAM 6: the preview diverged from the resolver it claims to mirror ──────────────────────
-- The resolver falls back to persons.email when a logged-in user has no eligible email CONTACT
-- (20261015120000) — the preview reported skip:no_contact for exactly those users, and its
-- candidate list omitted them entirely. It also reported catalog_supported without enforcing
-- it, while the resolver skips an unsupported channel before resolution.
DROP FUNCTION IF EXISTS public.admin_preview_notification_decision(uuid, text, text, uuid);
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
  contact_found boolean, destination_masked text, contact_source text, suppressed boolean,
  kill_state text, circuit_state text,
  final_decision text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  evt public.notification_event_types%ROWTYPE;
  v_person uuid;
  v_freq text; v_explicit text; v_default text; v_cap text;
  v_optin boolean := false; v_cap_applied boolean := false; v_req boolean := false;
  v_dest text; v_source text := 'none'; v_supported boolean;
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
  v_supported := CASE p_channel WHEN 'email' THEN evt.supports_email ELSE evt.supports_whatsapp END;

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
    IF v_dest IS NOT NULL THEN
      v_source := 'contact';
    ELSE
      -- the RESOLVER'S OWN FALLBACK: a logged-in user with no eligible email contact still
      -- receives at their account email. Omitting it made the preview report skip:no_contact
      -- for users production actually mails.
      SELECT p.email INTO v_dest FROM public.persons p WHERE p.id = v_person;
      IF v_dest IS NOT NULL THEN v_source := 'account_email'; END IF;
    END IF;
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
    IF v_dest IS NOT NULL THEN v_source := 'contact'; END IF;
  END IF;

  event_type := p_event_key; channel := p_channel;
  catalog_supported := v_supported;
  catalog_default := v_default; required_delivery := evt.required_delivery;
  explicit_preference := v_explicit;
  whatsapp_optin_arm := v_optin;
  academy_cap := v_cap; cap_applied := v_cap_applied;
  required_override_applied := v_req;
  final_frequency := v_freq;
  contact_found := v_dest IS NOT NULL;
  destination_masked := CASE WHEN v_dest IS NULL THEN NULL
                             ELSE public.notification_redact_destination(v_dest, p_channel) END;
  contact_source := v_source;
  suppressed := (p_channel = 'email' AND v_dest IS NOT NULL AND public.is_email_suppressed(v_dest));
  kill_state := CASE WHEN EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = p_channel)
                     THEN 'killed' ELSE 'live' END;
  circuit_state := coalesce((SELECT cb.state FROM public.notification_provider_circuit cb WHERE cb.channel = p_channel), 'none');
  final_decision := CASE
    -- the resolver skips an unsupported channel BEFORE resolution: report the same order
    WHEN NOT v_supported THEN 'skip:channel_unsupported'
    WHEN v_freq = 'off' THEN 'skip:frequency_off'
    WHEN v_dest IS NULL THEN 'skip:no_contact'
    WHEN p_channel = 'email' AND public.is_email_suppressed(v_dest) THEN 'skip:suppressed'
    ELSE 'deliver:' || v_freq
  END;
  RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.admin_preview_notification_decision(uuid, text, text, uuid) IS
  'N4 (seam-corrected): one user''s effective-preference provenance, mirroring enqueue_notification INCLUDING its account-email fallback (contact_source names which source resolved) and its unsupported-channel skip. Masked destination only.';
REVOKE ALL ON FUNCTION public.admin_preview_notification_decision(uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_preview_notification_decision(uuid, text, text, uuid) TO authenticated, service_role;


-- the collision verdict is a FIRST verdict for this actor (it never used the id before), so it
-- must be legal in the registry — unlike 'rejected_request_reuse', which by definition cannot be
ALTER TABLE public.notification_admin_requests DROP CONSTRAINT chk_notification_admin_requests_verdict;
ALTER TABLE public.notification_admin_requests ADD CONSTRAINT chk_notification_admin_requests_verdict CHECK (
  (action = 'channel_kill'   AND verdict IN ('killed', 'already_killed', 'rejected_id_collision'))
  OR (action = 'circuit_reset' AND verdict IN ('reset', 'already_closed', 'rejected_channel_killed', 'rejected_invocation_open', 'rejected_correlation_mismatch', 'rejected_stale_state'))
  OR (action = 'group_cancel'  AND verdict IN ('cancelled', 'rejected_not_found', 'rejected_not_pre_dispatch', 'rejected_stale_state'))
  OR (action = 'orphan_resolve' AND verdict IN ('resolved', 'rejected_not_found', 'rejected_not_quarantined', 'rejected_not_permanent', 'rejected_not_resolvable'))
  OR (action = 'orphan_requeue' AND verdict IN ('requeued', 'rejected_not_found', 'rejected_not_quarantined', 'rejected_permanent_reason', 'rejected_not_requeueable'))
);

-- ── SEAM 7: M2-era kill evidence, and a cross-actor request-id collision ────────────────────
-- (a) A kill committed before M3 existed has no audit row, so M5's registry backfill (which
--     reads the audit) cannot see it either: its (actor, request_id) could then be rebound to a
--     recovery decision. Backfill the AUDIT from the kill table itself, deterministically.
INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason, created_at)
SELECT k.activated_by, k.request_id, 'channel_kill', k.channel, 'live', 'killed', 'applied', k.reason, k.activated_at
  FROM public.notification_channel_kill_switches k
 WHERE k.activated_by IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.notification_admin_audit a
                    WHERE a.actor = k.activated_by AND a.request_id = k.request_id)
ON CONFLICT (actor, request_id) DO NOTHING;

INSERT INTO public.notification_admin_requests (actor, request_id, action, fingerprint, verdict, created_at)
SELECT a.actor, a.request_id, 'channel_kill',
       public.notif_admin_fingerprint(jsonb_build_object(
         'action', 'channel_kill', 'channel', a.target, 'reason', a.reason)),
       CASE a.outcome WHEN 'applied' THEN 'killed' ELSE 'already_killed' END,
       a.created_at
  FROM public.notification_admin_audit a
 WHERE a.action = 'channel_kill'
ON CONFLICT (actor, request_id) DO NOTHING;

-- (b) the kill table makes request_id GLOBALLY unique while the audit/registry identity is
--     (actor, request_id): two admins using the same uuid for different channels each passed
--     their actor-scoped gate, and the second INSERT died on a raw unique violation — rolling
--     back its rejected-attempt record with it. Detect the collision and return a TYPED verdict.
CREATE OR REPLACE FUNCTION public.admin_activate_channel_kill(
  p_channel text,
  p_reason text,
  p_request_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v text;
  v_fp text;
  v_outcome text;
  v_old text;
  v_other uuid;
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

  v_fp := public.notif_admin_fingerprint(jsonb_build_object(
    'action', 'channel_kill', 'channel', p_channel, 'reason', btrim(p_reason)));
  v := public.notif_admin_replay_gate(auth.uid(), p_request_id, 'channel_kill', p_channel, p_reason, v_fp);
  IF v IS NOT NULL THEN RETURN v; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('notif-channel-kill:' || p_channel, 0));

  -- ANOTHER actor already used this uuid: the kill table's global uniqueness would raise and
  -- roll the evidence back. Record it and refuse with a typed verdict instead.
  SELECT k.activated_by INTO v_other FROM public.notification_channel_kill_switches k
   WHERE k.request_id = p_request_id;
  IF FOUND AND v_other IS DISTINCT FROM auth.uid() THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'channel_kill', p_channel, p_reason,
      'this request id is already recorded on another actor''s kill — request ids are not shared');
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'channel_kill', v_fp, 'rejected_id_collision');
  END IF;

  IF EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = p_channel) THEN
    v_old := 'killed'; v_outcome := 'already_killed';
  ELSE
    v_old := 'live'; v_outcome := 'applied';
    INSERT INTO public.notification_channel_kill_switches (channel, activated_by, reason, request_id)
    VALUES (p_channel, auth.uid(), btrim(p_reason), p_request_id);
  END IF;

  INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
  VALUES (auth.uid(), p_request_id, 'channel_kill', p_channel, v_old, 'killed', v_outcome, btrim(p_reason));

  RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'channel_kill', v_fp,
    CASE v_outcome WHEN 'applied' THEN 'killed' ELSE 'already_killed' END);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_activate_channel_kill(text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_activate_channel_kill(text, text, uuid) TO authenticated, service_role;


-- the recipient CANDIDATE list must include account-email-only users for the same reason: the
-- resolver mails a logged-in user at persons.email when no eligible contact exists, so a
-- preview sourced from contacts alone omitted recipients production actually reaches.
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
  destination_masked text,
  candidates_partial boolean,
  next_cursor uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  RAW_BUDGET constant int := 500;
  u record;
  v_partial boolean := false;
  v_boundary uuid;
  v_progress uuid;
  v_lookahead uuid;
  v_single boolean := false;
  v_raw int := 0;
  v_emitted int := 0;
BEGIN
  PERFORM public.notif_admin_gate();
  CREATE TEMP TABLE IF NOT EXISTS _preview_raw (
    uid uuid, cid uuid, consent_status text, consent_scope text,
    consent_academy_profile_id uuid, consent_trainer_id uuid
  ) ON COMMIT DROP;
  DELETE FROM _preview_raw;
  INSERT INTO _preview_raw
  SELECT nc.effective_user_id, nc.id, nc.consent_status, nc.consent_scope,
         nc.consent_academy_profile_id, nc.consent_trainer_id
    FROM public.notification_contacts nc
   WHERE nc.channel = p_channel AND nc.revoked_at IS NULL
     AND nc.effective_user_id IS NOT NULL
     AND (p_after_user_id IS NULL OR nc.effective_user_id > p_after_user_id)
   ORDER BY nc.effective_user_id, nc.id
   LIMIT RAW_BUDGET + 1;
  GET DIAGNOSTICS v_raw = ROW_COUNT;
  v_partial := (v_raw > RAW_BUDGET);
  IF v_partial THEN
    SELECT r.uid INTO v_lookahead FROM _preview_raw r ORDER BY r.uid DESC, r.cid DESC LIMIT 1;
    DELETE FROM _preview_raw r
     WHERE (r.uid, r.cid) = (SELECT r2.uid, r2.cid FROM _preview_raw r2 ORDER BY r2.uid DESC, r2.cid DESC LIMIT 1);
    SELECT r.uid INTO v_boundary FROM _preview_raw r ORDER BY r.uid DESC, r.cid DESC LIMIT 1;
    IF v_lookahead = v_boundary THEN
      SELECT count(DISTINCT r.uid) = 1 INTO v_single FROM _preview_raw r;
      IF NOT v_single THEN
        DELETE FROM _preview_raw WHERE uid = v_boundary;
        SELECT r.uid INTO v_progress FROM _preview_raw r ORDER BY r.uid DESC LIMIT 1;
      ELSE
        -- the cap is now best-effort on the UPDATE path (the deadlock fix above), so an
        -- over-cap user is POSSIBLE rather than impossible: judge them on the staged set and
        -- advance, flagged partial — a raise here would wedge the crawl on one bad row.
        v_progress := v_boundary;
      END IF;
    ELSE
      v_progress := v_boundary;
    END IF;
  END IF;

  FOR u IN
    SELECT cand.uid FROM (
      (SELECT v2.user_id AS uid FROM public.notification_preferences_v2 v2
        WHERE v2.event_type = p_event_key
          AND (p_after_user_id IS NULL OR v2.user_id > p_after_user_id)
          AND (NOT v_partial OR v2.user_id <= v_progress)
        ORDER BY v2.user_id LIMIT 50)
      UNION
      (SELECT DISTINCT r.uid FROM _preview_raw r
        WHERE (CASE p_channel WHEN 'email' THEN r.consent_status <> 'opted_out'
                              ELSE r.consent_status = 'opted_in' END)
          AND public.is_notification_consent_in_scope(
                r.consent_scope, r.consent_academy_profile_id, r.consent_trainer_id,
                p_tenant_academy_profile_id, NULL)
        ORDER BY 1 LIMIT 50)
      UNION
      -- ACCOUNT-EMAIL recipients: logged-in persons the resolver mails at persons.email when
      -- no eligible contact exists. Email only (whatsapp has no such fallback), bounded and
      -- cursored like every other source, and clamped to the same horizon on partial pages.
      (SELECT p.user_id FROM public.persons p
        WHERE p_channel = 'email' AND p.user_id IS NOT NULL AND p.email IS NOT NULL
          AND (p_after_user_id IS NULL OR p.user_id > p_after_user_id)
          AND (NOT v_partial OR p.user_id <= v_progress)
        ORDER BY p.user_id LIMIT 50)
    ) cand
    WHERE cand.uid IS NOT NULL
    ORDER BY cand.uid
    LIMIT LEAST(GREATEST(coalesce(p_limit, 25), 1), 50)
  LOOP
    v_emitted := v_emitted + 1;
    RETURN QUERY
    SELECT u.uid, d.final_frequency, d.final_decision, d.destination_masked, v_partial, u.uid
      FROM public.admin_preview_notification_decision(u.uid, p_event_key, p_channel, p_tenant_academy_profile_id) d;
  END LOOP;
  IF v_emitted = 0 AND v_partial THEN
    user_id := NULL; final_frequency := NULL; final_decision := NULL; destination_masked := NULL;
    candidates_partial := true; next_cursor := v_progress;
    RETURN NEXT;
  END IF;
END;
$$;
COMMENT ON FUNCTION public.admin_preview_notification_recipients(text, text, uuid, uuid, int) IS
  'N4 (seam-corrected): bounded recipient preview over THREE candidate sources — preference rows, eligible contacts (via the persisted effective-user projection, ≤500 rows examined) and, for email, logged-in persons with an account email (the resolver''s own fallback). Each source is cursored and clamped; candidates_partial + next_cursor keep omissions and progress honest.';
REVOKE ALL ON FUNCTION public.admin_preview_notification_recipients(text, text, uuid, uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_preview_notification_recipients(text, text, uuid, uuid, int) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_persons_user_email
  ON public.persons (user_id) WHERE user_id IS NOT NULL AND email IS NOT NULL;
