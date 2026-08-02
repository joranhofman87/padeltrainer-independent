-- 10c-b C (part 2) — enqueue_notification gains the DIGEST branch.
--
-- Forward-only CREATE OR REPLACE of the resolver. Same signature, so privileges and the
-- COMMENT from 20260911100000 persist; this file re-states the whole body because
-- plpgsql has no partial replacement.
--
-- WHAT CHANGED, and nothing else changed:
--
--   (a) A new §6d delivery-mode decision, reached ONLY when
--         channel = 'email' AND event.digest_cutover AND freq IN ('daily','weekly').
--       `digest_cutover` is true for open_slots_player alone. Every other event —
--       including the eight that merely carry supports_digest — takes the identical
--       path it took before, including the legacy delayed-instant daily/weekly branch,
--       which is reproduced here byte-for-byte.
--
--   (b) Engine ON  -> a real digest member: delivery_mode='digest', status='pending',
--       scheduled_for = the immutable DST-correct boundary, plus the full canonical
--       snapshot (prefixed recipient_key, destination fingerprint, frequency, locale,
--       timezone, template_version, server-minted immutable item). digest_group_hash and
--       digest_item_bytes are stamped by the existing trigger — never by this function.
--
--   (c) Engine OFF -> status='skipped', skip_reason='digest_engine_disabled',
--       scheduled_for = now(), and delivery_mode LEFT NULL. That last detail is the
--       whole no-backlog guarantee: the instant worker claims status='pending' and the
--       materializer scans delivery_mode='digest', so this row is invisible to BOTH.
--       There is nothing queued to burst when the engine is later enabled, and the
--       preference was NOT downgraded to an instant send. Enablement affects future
--       events only, structurally rather than by convention.
--
--   (d) required_delivery still forces email to 'instant' BEFORE this decision, so a
--       required event can never be digested or engine-off-skipped.
--
-- Consent, suppression, contact resolution, tenant scope, idempotency, the required-
-- delivery skipped row, the return projection and all grants are untouched.

CREATE OR REPLACE FUNCTION public.enqueue_notification(
  p_event_key                 text,
  p_recipient_person_id       uuid        DEFAULT NULL,
  p_recipient_user_id         uuid        DEFAULT NULL,
  p_recipient_guest_player_id uuid        DEFAULT NULL,
  p_tenant_academy_profile_id uuid        DEFAULT NULL,
  p_tenant_trainer_id         uuid        DEFAULT NULL,
  p_idempotency_subject       text        DEFAULT NULL,
  p_related_booking_ids       uuid[]      DEFAULT NULL,
  p_related_invoice_id        uuid        DEFAULT NULL,
  p_related_payment_id        text        DEFAULT NULL,
  p_template_key              text        DEFAULT NULL,
  p_payload                   jsonb       DEFAULT '{}'::jsonb,
  p_public_summary            jsonb       DEFAULT NULL,
  p_scheduled_for             timestamptz DEFAULT NULL
) RETURNS TABLE (
  outbox_id              uuid,
  channel                text,
  status                 text,
  skip_reason            text,
  visibility_scope       text,
  destination_normalized text,
  destination_redacted   text,
  idempotency_key        text,
  collapse_key           text,
  recipient_person_id    uuid,
  public_summary         jsonb,
  template_key           text,
  scheduled_for          timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_evt              public.notification_event_types%ROWTYPE;
  v_emitted          uuid[] := '{}';
  v_row_id           uuid;
  v_person_id        uuid;
  v_user_id          uuid;
  v_guest_id         uuid := p_recipient_guest_player_id;
  v_subject          text;
  v_recipient_key    text;
  v_idem_key         text;
  v_now              timestamptz := now();
  v_channel          text;
  v_supports         boolean;
  v_default_freq     text;
  v_freq             text;
  v_contact          public.notification_contacts%ROWTYPE;
  v_dest             text;
  v_dest_redacted    text;
  v_contact_id       uuid;
  v_deliverable      boolean;
  v_any_deliverable  boolean := false;
  v_email_skip       text;
  v_visibility       text;
  v_public_summary   jsonb;
  v_template         text;
  v_scheduled        timestamptz;
  v_collapse_key     text;
  -- 10c-b digest snapshot locals
  v_is_digest        boolean;
  v_status           text;
  v_skip             text;
  v_delivery_mode    text;
  v_digest_freq      text;
  v_tz               text;
  v_locale           text;
  v_boundary         timestamptz;
  v_item             jsonb;
  v_fingerprint      text;
  v_prefixed_key     text;
  v_tmpl_version     int;
BEGIN
  -- 1. resolve the event type (config drives every downstream decision)
  SELECT * INTO v_evt FROM public.notification_event_types WHERE key = p_event_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'enqueue_notification: unknown event_type %', p_event_key;
  END IF;

  -- 2. a recipient is mandatory
  IF p_recipient_person_id IS NULL AND p_recipient_user_id IS NULL AND p_recipient_guest_player_id IS NULL THEN
    RAISE EXCEPTION 'enqueue_notification: no recipient (person/user/guest all null) for %', p_event_key;
  END IF;

  -- 3. normalize to the one person across the dual-key transition
  v_person_id := p_recipient_person_id;
  IF v_person_id IS NULL AND p_recipient_user_id IS NOT NULL THEN
    SELECT id INTO v_person_id FROM public.persons WHERE user_id = p_recipient_user_id;
  END IF;
  IF v_person_id IS NULL AND v_guest_id IS NOT NULL THEN
    SELECT person_id INTO v_person_id FROM public.person_links WHERE guest_player_id = v_guest_id;
  END IF;
  v_user_id := p_recipient_user_id;
  IF v_user_id IS NULL AND v_person_id IS NOT NULL THEN
    SELECT user_id INTO v_user_id FROM public.persons WHERE id = v_person_id;
  END IF;

  -- 4. PER-RECIPIENT idempotency key
  v_subject := nullif(btrim(coalesce(p_idempotency_subject, '')), '');
  IF v_subject IS NULL THEN
    v_subject := CASE
      WHEN p_related_invoice_id IS NOT NULL THEN 'invoice:' || p_related_invoice_id::text
      WHEN p_related_payment_id IS NOT NULL THEN 'payment:' || p_related_payment_id
      WHEN p_related_booking_ids IS NOT NULL AND array_length(p_related_booking_ids, 1) > 0
        THEN 'bookings:' || (SELECT string_agg(b::text, ',' ORDER BY b) FROM unnest(p_related_booking_ids) AS b)
      ELSE NULL
    END;
  END IF;
  IF v_subject IS NULL THEN
    RAISE EXCEPTION 'enqueue_notification: % needs an idempotency subject (pass p_idempotency_subject, or a related invoice/payment/booking ref to derive one)', p_event_key;
  END IF;
  v_recipient_key := coalesce(v_person_id::text, v_guest_id::text, p_recipient_user_id::text);
  v_idem_key := p_event_key || ':' || v_subject || ':' || v_recipient_key;

  -- 5. tenant-visibility contract
  v_visibility := v_evt.visibility_scope;
  IF v_visibility IN ('tenant_visible', 'tenant_visible_limited') THEN
    IF p_tenant_academy_profile_id IS NULL AND p_tenant_trainer_id IS NULL THEN
      RAISE EXCEPTION 'enqueue_notification: % is %, but no tenant context was supplied', p_event_key, v_visibility;
    END IF;
    v_public_summary := coalesce(p_public_summary, jsonb_build_object('event_type', p_event_key));
  ELSE
    v_public_summary := p_public_summary;
  END IF;

  -- 6. resolve + enqueue per supported channel
  FOREACH v_channel IN ARRAY ARRAY['email', 'whatsapp', 'push'] LOOP
    v_supports := CASE v_channel
      WHEN 'email'    THEN v_evt.supports_email
      WHEN 'whatsapp' THEN v_evt.supports_whatsapp
      WHEN 'push'     THEN v_evt.supports_push
    END;
    CONTINUE WHEN NOT v_supports;

    -- 6a. preference frequency: prefs_v2 override (needs a login) else event default
    v_default_freq := CASE v_channel
      WHEN 'email'    THEN v_evt.default_email_frequency
      WHEN 'whatsapp' THEN v_evt.default_whatsapp_frequency
      WHEN 'push'     THEN v_evt.default_push_frequency
    END;
    v_freq := NULL;
    IF v_user_id IS NOT NULL THEN
      SELECT CASE v_channel
        WHEN 'email'    THEN email_frequency
        WHEN 'whatsapp' THEN whatsapp_frequency
        WHEN 'push'     THEN push_frequency
      END INTO v_freq
      FROM public.notification_preferences_v2
      WHERE user_id = v_user_id AND event_type = p_event_key;
    END IF;
    v_freq := coalesce(v_freq, v_default_freq);

    -- 6b. required delivery guarantees the EMAIL channel: it can't be off or digested.
    IF v_evt.required_delivery AND v_channel = 'email' THEN
      v_freq := 'instant';
    END IF;

    IF v_freq = 'off' THEN
      IF v_channel = 'email' THEN v_email_skip := 'preference_off'; END IF;
      CONTINUE;
    END IF;

    -- 6c. destination + consent
    v_deliverable := false; v_dest := NULL; v_dest_redacted := NULL; v_contact_id := NULL;

    IF v_channel = 'email' THEN
      SELECT * INTO v_contact FROM public.notification_contacts
      WHERE channel = 'email' AND revoked_at IS NULL AND consent_status <> 'opted_out'
        AND (consent_scope <> 'global' OR v_user_id IS NOT NULL)
        AND public.is_notification_consent_in_scope(
              consent_scope, consent_academy_profile_id, consent_trainer_id,
              p_tenant_academy_profile_id, p_tenant_trainer_id)
        AND ( (v_person_id IS NOT NULL AND person_id = v_person_id)
           OR (v_user_id   IS NOT NULL AND user_id = v_user_id)
           OR (v_guest_id  IS NOT NULL AND guest_player_id = v_guest_id) )
      ORDER BY is_primary DESC, verified_at DESC NULLS LAST
      LIMIT 1;
      IF FOUND THEN
        v_dest := v_contact.destination_normalized;
        v_dest_redacted := v_contact.destination_redacted;
        v_contact_id := v_contact.id;
      ELSIF v_user_id IS NOT NULL THEN
        SELECT email INTO v_dest FROM public.persons WHERE id = v_person_id;
        v_dest_redacted := public.notification_redact_destination(v_dest, 'email');
      END IF;

      IF v_dest IS NULL OR btrim(v_dest) = '' THEN
        v_email_skip := coalesce(v_email_skip, 'no_email_contact');
      ELSIF public.is_email_suppressed(v_dest) THEN
        v_email_skip := 'email_suppressed';
      ELSE
        v_deliverable := true;
      END IF;

    ELSE
      SELECT * INTO v_contact FROM public.notification_contacts
      WHERE channel = v_channel AND revoked_at IS NULL AND consent_status = 'opted_in'
        AND (consent_scope <> 'global' OR v_user_id IS NOT NULL)
        AND public.is_notification_consent_in_scope(
              consent_scope, consent_academy_profile_id, consent_trainer_id,
              p_tenant_academy_profile_id, p_tenant_trainer_id)
        AND ( (v_person_id IS NOT NULL AND person_id = v_person_id)
           OR (v_user_id   IS NOT NULL AND user_id = v_user_id)
           OR (v_guest_id  IS NOT NULL AND guest_player_id = v_guest_id) )
      ORDER BY is_primary DESC, verified_at DESC NULLS LAST
      LIMIT 1;
      IF FOUND THEN
        v_dest := v_contact.destination_normalized;
        v_dest_redacted := v_contact.destination_redacted;
        v_contact_id := v_contact.id;
        v_deliverable := true;
      END IF;
    END IF;

    CONTINUE WHEN NOT v_deliverable;

    -- 6d. DELIVERY MODE (10c-b). Reset every iteration — a stale digest snapshot leaking
    --     onto the next channel's row would mint a bogus group identity.
    v_is_digest := false; v_status := 'pending'; v_skip := NULL;
    v_delivery_mode := NULL; v_digest_freq := NULL; v_tz := NULL; v_locale := NULL;
    v_boundary := NULL; v_item := NULL; v_fingerprint := NULL; v_prefixed_key := NULL;
    v_tmpl_version := NULL;

    IF v_channel = 'email' AND v_evt.digest_cutover AND v_freq IN ('daily','weekly') THEN
      IF v_evt.digest_engine_enabled THEN
        -- A real digest member. Every canonical grouping input is frozen HERE; the item
        -- is minted by trusted SQL from structured payload fields (never edge-rendered).
        v_is_digest     := true;
        v_delivery_mode := 'digest';
        v_digest_freq   := v_freq;
        v_tz            := public.notif_digest_recipient_timezone(p_tenant_academy_profile_id, p_tenant_trainer_id);
        v_locale        := public.notif_digest_group_locale(v_person_id, v_user_id);
        v_boundary      := public.notif_digest_boundary_at(v_now, v_freq, v_tz);
        v_item          := public.notif_digest_item_for_event(p_event_key, v_locale, coalesce(p_payload, '{}'::jsonb));
        v_fingerprint   := public.notif_digest_destination_fingerprint(v_dest);
        v_tmpl_version  := v_evt.template_version;
        -- ADR §M1 prefixed recipient key: person is the stable identity, then account, then guest.
        v_prefixed_key  := CASE
          WHEN v_person_id IS NOT NULL THEN 'p:' || v_person_id::text
          WHEN v_user_id   IS NOT NULL THEN 'u:' || v_user_id::text
          ELSE 'g:' || v_guest_id::text
        END;
      ELSE
        -- Engine OFF. An explicit, auditable, INERT outcome: not a digest row (no
        -- delivery_mode → the materializer cannot see it), not pending (the instant
        -- worker cannot see it), not scheduled into the future (nothing to burst).
        v_status := 'skipped';
        v_skip   := 'digest_engine_disabled';
      END IF;
    END IF;

    -- 6e. scheduling. The legacy daily/weekly delayed-instant branch below is UNCHANGED
    --     and still governs every non-cutover event.
    v_scheduled := CASE
      WHEN v_is_digest          THEN v_boundary
      WHEN v_status = 'skipped' THEN v_now
      WHEN v_freq = 'daily'     THEN date_trunc('day',  v_now) + interval '1 day'  + interval '8 hours'
      WHEN v_freq = 'weekly'    THEN date_trunc('week', v_now) + interval '7 days' + interval '8 hours'
      ELSE coalesce(p_scheduled_for, v_now)
    END;

    -- collapse window: pending rows sharing this key are worker-collapsed into one send.
    v_collapse_key := NULL;
    IF v_evt.collapse_window_minutes > 0 THEN
      v_collapse_key := p_event_key || ':' || v_channel || ':' || v_recipient_key || ':'
        || floor(extract(epoch FROM v_now) / (v_evt.collapse_window_minutes * 60))::text;
    END IF;

    v_template := coalesce(p_template_key, CASE v_channel
      WHEN 'email'    THEN v_evt.template_email
      WHEN 'whatsapp' THEN v_evt.template_whatsapp
      ELSE NULL END);

    INSERT INTO public.notification_outbox (
      event_type, channel,
      recipient_user_id, recipient_person_id, recipient_guest_player_id,
      tenant_academy_profile_id, tenant_trainer_id, visibility_scope,
      related_booking_ids, related_invoice_id, related_payment_id,
      destination_normalized, destination_redacted, contact_id,
      template_key, payload, public_summary,
      idempotency_key, collapse_key, status, skip_reason, scheduled_for,
      delivery_mode, recipient_key, digest_frequency, group_locale, recipient_timezone,
      digest_boundary_at, template_version, destination_fingerprint, digest_item
    ) VALUES (
      p_event_key, v_channel,
      v_user_id, v_person_id, v_guest_id,
      p_tenant_academy_profile_id, p_tenant_trainer_id, v_visibility,
      p_related_booking_ids, p_related_invoice_id, p_related_payment_id,
      v_dest, v_dest_redacted, v_contact_id,
      v_template, coalesce(p_payload, '{}'::jsonb), v_public_summary,
      v_idem_key, v_collapse_key, v_status, v_skip, v_scheduled,
      v_delivery_mode, v_prefixed_key, v_digest_freq, v_locale, v_tz,
      v_boundary, v_tmpl_version, v_fingerprint, v_item
    )
    ON CONFLICT (channel, idempotency_key) DO NOTHING
    RETURNING id INTO v_row_id;

    IF FOUND THEN
      v_emitted := array_append(v_emitted, v_row_id);
    END IF;
    v_any_deliverable := true;
  END LOOP;

  -- 7. required delivery but nothing was deliverable → a VISIBLE skipped row
  IF NOT v_any_deliverable AND v_evt.required_delivery THEN
    INSERT INTO public.notification_outbox (
      event_type, channel,
      recipient_user_id, recipient_person_id, recipient_guest_player_id,
      tenant_academy_profile_id, tenant_trainer_id, visibility_scope,
      related_booking_ids, related_invoice_id, related_payment_id,
      payload, public_summary,
      idempotency_key, status, skip_reason, scheduled_for
    ) VALUES (
      p_event_key, 'email',
      v_user_id, v_person_id, v_guest_id,
      p_tenant_academy_profile_id, p_tenant_trainer_id, v_visibility,
      p_related_booking_ids, p_related_invoice_id, p_related_payment_id,
      coalesce(p_payload, '{}'::jsonb), v_public_summary,
      v_idem_key, 'skipped', coalesce(v_email_skip, 'no_deliverable_channel'), v_now
    )
    ON CONFLICT (channel, idempotency_key) DO NOTHING
    RETURNING id INTO v_row_id;
    IF FOUND THEN
      v_emitted := array_append(v_emitted, v_row_id);
    END IF;
  END IF;

  RETURN QUERY
    SELECT o.id, o.channel, o.status, o.skip_reason, o.visibility_scope,
           o.destination_normalized, o.destination_redacted, o.idempotency_key,
           o.collapse_key, o.recipient_person_id, o.public_summary, o.template_key, o.scheduled_for
    FROM public.notification_outbox o
    WHERE o.id = ANY(v_emitted)
    ORDER BY o.channel;
  RETURN;
END;
$$;
