-- N4 whole-unit seam review, ROUND 2 (thread 019fd319). Four defects that survived round 1 —
-- three of them created or left half-corrected BY round 1, which is why they only surface when
-- the unit is read as one system:
--
--   1. admin_preview_circuit_release still described the INSTANT backlog as work the reset
--      releases, contradicting the authority matrix round 1 had just corrected.
--   2. admin_preview_notification_decision still diverged from the resolver on blank
--      destinations, on a contact row whose destination is NULL, and on the ORDER in which an
--      unsupported channel is decided (the resolver never resolves it at all).
--   3. The cross-actor request-id collision was only detected under the per-CHANNEL kill lock,
--      so two actors on DIFFERENT channels could still race into the raw unique violation.
--   4. Round 1's evidence backfills used ON CONFLICT DO NOTHING, which silently accepts an
--      audit/registry row that CONTRADICTS a kill — exactly the evidence loss they existed to
--      repair.
--
-- (The fifth round-2 finding, the invocation-gate lock inversion, is a rollout artifact and is
-- fixed in scripts/rollout/notif-10cb/sql/_invocation_gate_replay.sql.)

-- ── SEAM 8: what closing the circuit actually releases ──────────────────────────────────────
-- The corrected authority matrix (round 1) established that the INSTANT claim never reads
-- notification_provider_circuit — the breaker is a digest-path mechanism, tripped and cleared by
-- the digest state machine. So an open circuit does not hold instant rows back, and closing it
-- releases none of them. Reporting them under "what a reset would release" invited the opposite
-- operational conclusion: reset the breaker to get instant email moving. The count is still
-- useful context (it says how much instant work is queued behind whatever IS stopping it), so it
-- is kept and RENAMED to say what it is.
CREATE OR REPLACE FUNCTION public.admin_preview_circuit_release(p_channel text) RETURNS TABLE (
  metric text, value bigint, capped boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE CAP constant int := 10000; v bigint;
BEGIN
  PERFORM public.notif_admin_gate();
  -- RELEASED: request_ready groups are exactly what the breaker holds — the digest send path
  -- consults the circuit before dispatching them.
  SELECT count(*) INTO v FROM (
    SELECT 1 FROM public.notification_digest_groups g
     WHERE g.channel = p_channel AND g.state = 'request_ready' AND g.terminal_at IS NULL LIMIT CAP + 1) b;
  metric := 'digest_groups_request_ready'; value := least(v, CAP); capped := v > CAP; RETURN NEXT;
  -- NOT RELEASED: context only. If these are not moving, the cause is the kill switch, the
  -- send-enabling env switch, or the worker — never this breaker.
  SELECT count(*) INTO v FROM (
    SELECT 1 FROM public.notification_outbox o
     WHERE o.channel = p_channel AND o.status = 'pending'
       AND o.delivery_mode IS DISTINCT FROM 'digest' LIMIT CAP + 1) b;
  metric := 'instant_rows_pending_not_released'; value := least(v, CAP); capped := v > CAP; RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.admin_preview_circuit_release(text) IS
  'N4 M5 (seam round 2): what closing the circuit RELEASES — request_ready digest groups only, because the instant claim never reads the breaker. The instant backlog is reported as explicitly NOT released, so a reset is not mistaken for a way to unstick instant sends. Read-only, saturating, admin fail-closed.';
REVOKE ALL ON FUNCTION public.admin_preview_circuit_release(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_preview_circuit_release(text) TO authenticated, service_role;

-- ── SEAM 9: the decision preview must be the resolver, not a paraphrase of it ────────────────
-- Three remaining divergences from enqueue_notification (20261015120000):
--   (a) UNSUPPORTED CHANNEL. The resolver's `CONTINUE WHEN NOT v_supports` fires BEFORE any
--       preference, cap, opt-in, contact or suppression logic runs. The preview computed all of
--       them and only ordered the skip first in the final CASE — so it reported an "APPLIED"
--       academy cap and a resolved destination for a channel the event never emits on. Those
--       fields were fabrications: production never evaluates them. Return the catalog verdict
--       and NOTHING derived from a resolution that does not happen.
--   (b) BLANK destination. The resolver treats '' as no contact (`v_dest IS NULL OR btrim(...)
--       = ''`); the preview only tested NULL, so a whitespace contact or account email reported
--       deliver:*. persons.email and notification_contacts.destination_normalized both permit it.
--   (c) A contact row that EXISTS with a NULL destination. The resolver's fallback lives in the
--       ELSIF of `IF FOUND` — a found-but-empty contact does NOT fall back to the account email.
--       The preview branched on v_dest IS NULL, so it fell back where production would not.
--   The whatsapp branch is mirrored as-is, blank tolerance included: equivalence means reporting
--   what production does, not what it ought to do. (WhatsApp cannot send at all — N7 gate.)
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
  v_dest text; v_source text := 'none'; v_supported boolean; v_has_dest boolean := false;
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

  -- channel-level facts, true whether or not resolution runs
  kill_state := CASE WHEN EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = p_channel)
                     THEN 'killed' ELSE 'live' END;
  circuit_state := coalesce((SELECT cb.state FROM public.notification_provider_circuit cb WHERE cb.channel = p_channel), 'none');
  event_type := p_event_key; channel := p_channel;
  catalog_supported := v_supported; catalog_default := v_default; required_delivery := evt.required_delivery;

  IF NOT v_supported THEN
    -- (a) THE RESOLVER STOPS HERE. Everything below is left NULL/false because production never
    -- computes it — a reported value would be this function's invention, not a preview.
    explicit_preference := NULL; whatsapp_optin_arm := false;
    academy_cap := NULL; cap_applied := false; required_override_applied := false;
    final_frequency := NULL;
    contact_found := false; destination_masked := NULL; contact_source := 'none'; suppressed := false;
    final_decision := 'skip:channel_unsupported';
    RETURN NEXT;
    RETURN;
  END IF;

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
    -- (c) branch on FOUND, exactly like the resolver: a contact row that exists CONSUMES the
    -- decision even when its destination is empty. Branching on v_dest IS NULL fell back to the
    -- account email in a case where production does not.
    IF FOUND THEN
      v_source := 'contact';
    ELSIF p_user_id IS NOT NULL THEN
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
    IF FOUND THEN v_source := 'contact'; END IF;
  END IF;

  -- (b) the resolver's own blank test, EMAIL ONLY — its whatsapp branch marks a found contact
  -- deliverable without one, and the preview mirrors production rather than improving on it.
  v_has_dest := CASE
    WHEN p_channel = 'email' THEN (v_dest IS NOT NULL AND btrim(v_dest) <> '')
    ELSE (v_source = 'contact')
  END;
  IF NOT v_has_dest THEN v_source := 'none'; END IF;

  explicit_preference := v_explicit;
  whatsapp_optin_arm := v_optin;
  academy_cap := v_cap; cap_applied := v_cap_applied;
  required_override_applied := v_req;
  final_frequency := v_freq;
  contact_found := v_has_dest;
  destination_masked := CASE WHEN NOT v_has_dest THEN NULL
                             ELSE public.notification_redact_destination(v_dest, p_channel) END;
  contact_source := v_source;
  suppressed := (p_channel = 'email' AND v_has_dest AND public.is_email_suppressed(v_dest));
  final_decision := CASE
    WHEN v_freq = 'off' THEN 'skip:frequency_off'
    WHEN NOT v_has_dest THEN 'skip:no_contact'
    WHEN p_channel = 'email' AND public.is_email_suppressed(v_dest) THEN 'skip:suppressed'
    ELSE 'deliver:' || v_freq
  END;
  RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.admin_preview_notification_decision(uuid, text, text, uuid) IS
  'N4 (seam round 2): one user''s effective-preference provenance, mirroring enqueue_notification — its account-email fallback (contact_source), its found-contact-wins branch, its blank-destination rule, and its unsupported-channel skip taken BEFORE any resolution (every derived column is then NULL, because production computes none of them). Masked destination only.';
REVOKE ALL ON FUNCTION public.admin_preview_notification_decision(uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_preview_notification_decision(uuid, text, text, uuid) TO authenticated, service_role;

-- ── SEAM 10: the cross-actor collision must be detected under a lock that BOTH actors take ──
-- Round 1 checked for a foreign kill row carrying this request id, but only after taking
-- 'notif-channel-kill:<channel>'. Two admins killing DIFFERENT channels with the same uuid take
-- DIFFERENT locks: both saw no collision and both inserted, and the second died on the kill
-- table's global unique constraint — rolling back its rejected-attempt evidence, which is the
-- precise failure round 1 set out to remove.
--
-- The fix is a lock keyed by the REQUEST ID itself, taken AFTER the channel lock (it is the last
-- lock this function acquires, and nothing else acquires it, so it cannot close a wait cycle).
-- Under READ COMMITTED the collision SELECT runs after the wait, on a fresh snapshot, so the
-- loser sees the winner's committed row and returns the typed verdict.
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
  -- the GLOBAL request-id lock: the kill table's uniqueness is global, so its guard must be too
  PERFORM pg_advisory_xact_lock(hashtextextended('notif-kill-request:' || p_request_id::text, 0));

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
COMMENT ON FUNCTION public.admin_activate_channel_kill(text, text, uuid) IS
  'N4 M2 (seam round 2): the channel kill. Ordering: replay gate (actor-scoped identity) → channel lock → GLOBAL request-id lock → cross-actor collision check (typed rejected_id_collision, evidence committed) → kill + audit + registry verdict.';
REVOKE ALL ON FUNCTION public.admin_activate_channel_kill(text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_activate_channel_kill(text, text, uuid) TO authenticated, service_role;

-- ── SEAM 11: the round-1 backfills must not accept a CONTRADICTION silently ─────────────────
-- Round 1 repaired M2-era kill evidence with ON CONFLICT DO NOTHING. A conflict there is not a
-- benign re-run: it means (actor, request_id) is already bound to a DIFFERENT decision, so the
-- kill has no evidence and the id claims to be something else. Swallowing that is the same class
-- of silent evidence loss the backfill was written to repair, so it is asserted instead. This
-- cannot fire on a system that has never activated notifications (the kill table is empty); if it
-- ever does, the named rows are a genuine identity contradiction for a human to reconcile.
DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(format('kill(channel=%s, actor=%s, request_id=%s)', k.channel, k.activated_by, k.request_id), '; ')
    INTO v_missing
    FROM public.notification_channel_kill_switches k
   WHERE k.activated_by IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.notification_admin_audit a
                      WHERE a.actor = k.activated_by AND a.request_id = k.request_id
                        AND a.action = 'channel_kill' AND a.target = k.channel);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'notif N4 seam: a kill has no matching audit evidence and its (actor, request_id) is already bound elsewhere — reconcile before deploying: %', v_missing;
  END IF;

  SELECT string_agg(format('audit(actor=%s, request_id=%s, target=%s)', a.actor, a.request_id, a.target), '; ')
    INTO v_missing
    FROM public.notification_admin_audit a
   WHERE a.action = 'channel_kill'
     AND NOT EXISTS (SELECT 1 FROM public.notification_admin_requests r
                      WHERE r.actor = a.actor AND r.request_id = a.request_id
                        AND r.action = 'channel_kill');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'notif N4 seam: a channel_kill audit row has no registry verdict and its (actor, request_id) is registered to another action — reconcile before deploying: %', v_missing;
  END IF;
END $$;
