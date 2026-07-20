-- Notification Foundation v2 — PR 9: make the booking opt-in actually deliverable.
--
-- The consent model contradicted itself. record_whatsapp_optin(_for_slot) records an opted-in
-- contact, but the resolver's FIRST gate is a per-event cadence that must be non-'off' before
-- it ever looks for that contact — and nothing could satisfy it:
--
--   * GUESTS: prefs_v2 is user_id-keyed, so a guest can never express a cadence at all and is
--     pinned to default_whatsapp_frequency = 'off' forever.
--   * LOGGED-IN PLAYERS: booking_confirmed_player is required_delivery, and the settings page
--     renders those as "Always on" with NO WhatsApp control — so there is no way to switch it
--     on there either.
--
-- A booking checkbox on top of that would have written consent that could never send: the most
-- expensive kind of bug, because every layer reports success. (PR 3's own comment predicted
-- this — "whatsapp/push are REGISTERED-ONLY until PR 9 adds a person/contact-scoped guest
-- opt-in path" — and this is that path.)
--
-- FIX: for the events a booking opt-in is actually ABOUT, an opted-in in-scope contact supplies
-- the cadence when the person has expressed none. The contact stays the authority on "may we
-- message this person for this tenant", and preferences become an explicit override.
--
-- What this does NOT do:
--   * it does not weaken the second gate — an in-scope opted-in contact is still required;
--   * it does not override an explicit preference, including 'off';
--   * it does not extend to every WhatsApp-capable event (see the seeding below).

-- ---------------------------------------------------------------------------
-- 1. WHICH events a booking opt-in covers. Declarative on the catalog rather than a list
--    hardcoded in the resolver, so adding an event cannot silently inherit coverage.
ALTER TABLE public.notification_event_types
  ADD COLUMN IF NOT EXISTS whatsapp_optin_via_booking boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.notification_event_types.whatsapp_optin_via_booking IS
  'Notification v2 (PR 9): TRUE when an explicit WhatsApp opt-in taken during booking counts as the opt-in for this event (the session lifecycle the person was opting in about). Deliberately false for payment chasing and rebook invitations.';

-- The session lifecycle of the booking the person just made — and nothing else.
-- invoice_reminder_player and rebook_invite_player stay FALSE on purpose: consent given while
-- booking one session is not consent to be chased for money or invited to book again. Those
-- remain reachable through the settings page, which registered users have (and guests do not).
UPDATE public.notification_event_types
SET whatsapp_optin_via_booking = true
WHERE key IN ('booking_confirmed_player', 'booking_cancelled_player', 'session_reminder_player');

-- ---------------------------------------------------------------------------
-- 2. Does this recipient have an opted-in WhatsApp contact usable IN THIS TENANT?
--
-- Mirrors the resolver's own contact predicate exactly — same scope intersection, same
-- global-only-for-account-holders guard, same recipient-key fan-out — so the cadence gate and
-- the delivery gate can never disagree about what counts as consent.
CREATE OR REPLACE FUNCTION public.whatsapp_optin_in_scope(
  p_person_id               uuid,
  p_user_id                 uuid,
  p_guest_player_id         uuid,
  p_tenant_academy_profile_id uuid,
  p_tenant_trainer_id       uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.notification_contacts c
    WHERE c.channel = 'whatsapp'
      AND c.revoked_at IS NULL
      AND c.consent_status = 'opted_in'
      AND (c.consent_scope <> 'global' OR p_user_id IS NOT NULL)
      AND public.is_notification_consent_in_scope(
            c.consent_scope, c.consent_academy_profile_id, c.consent_trainer_id,
            p_tenant_academy_profile_id, p_tenant_trainer_id)
      AND ( (p_person_id       IS NOT NULL AND c.person_id = p_person_id)
         OR (p_user_id         IS NOT NULL AND c.user_id = p_user_id)
         OR (p_guest_player_id IS NOT NULL AND c.guest_player_id = p_guest_player_id) )
  );
$$;
COMMENT ON FUNCTION public.whatsapp_optin_in_scope(uuid, uuid, uuid, uuid, uuid) IS
  'Notification v2 (PR 9): TRUE iff the recipient has an opted-in, non-revoked WhatsApp contact usable in this tenant context. Mirrors the resolver''s contact predicate so the cadence gate and the delivery gate cannot disagree. INTERNAL — service_role only; it answers a consent question about arbitrary ids.';
REVOKE ALL ON FUNCTION public.whatsapp_optin_in_scope(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_optin_in_scope(uuid, uuid, uuid, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. The resolver, with the WhatsApp cadence sourced from that opt-in when the person has
--    expressed none. Body is otherwise byte-for-byte the deployed 20260911100000 definition
--    (generated by patching it, not retyping); the signature is unchanged, so no drift.
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
-- RETURNS TABLE makes channel/status/... into OUT variables that would otherwise
-- shadow the same-named columns in the contact lookups. Every real variable here is
-- v_/p_-prefixed, so "prefer the column for any bare name" is always what we mean.
#variable_conflict use_column
DECLARE
  v_evt              public.notification_event_types%ROWTYPE;
  v_emitted          uuid[] := '{}';   -- ids of the rows THIS call created (returned at the end)
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
  v_email_skip       text;      -- why the required (email) channel could not deliver
  v_visibility       text;
  v_public_summary   jsonb;
  v_template         text;
  v_scheduled        timestamptz;
  v_collapse_key     text;
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

  -- 3. normalize to the one person across the dual-key transition (FAM-02: the
  --    person is the stable identity; user_id/guest_player_id are just entry points)
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

  -- 4. PER-RECIPIENT idempotency key: <event>:<subject>:<recipient>. The channel is
  --    the UNIQUE constraint, NOT part of the string, so email+whatsapp for the same
  --    recipient share the key but live as distinct rows, and a re-enqueue no-ops.
  --    The SUBJECT scopes the key to ONE event instance. An EMPTY subject is fatal: it
  --    makes every future send for this event+recipient collide into a silent no-op
  --    (e.g. the 2nd booking confirmation for a player would vanish). So a blank subject
  --    is DERIVED from the related refs, and if there is nothing to derive from we RAISE
  --    rather than mint a collision-prone key.
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

  -- 5. tenant-visibility contract (mirror the outbox CHECK up-front so the error is
  --    a clear caller message, not a constraint violation): tenant-visible events
  --    MUST carry tenant context + a sanitized public_summary.
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
    -- prefs_v2 is user_id-keyed, so only account holders can express a cadence. PUSH is
    -- therefore still registered-only; WHATSAPP is not, since PR 9 lets an explicit booking
    -- opt-in supply the cadence (below). Guest EMAIL is unaffected (default 'instant').
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
    -- WHATSAPP: AN EXPLICIT BOOKING OPT-IN *IS* THE OPT-IN.
    --
    -- Without this the consent model contradicts itself. prefs_v2 is user_id-keyed, so a GUEST
    -- can never express a cadence and stays pinned to the 'off' default forever — the booking
    -- checkbox would write a consent row that can never send. And for a logged-in player the
    -- required_delivery events (booking_confirmed_player) are rendered as "Always on" with no
    -- WhatsApp control at all, so there is no way to switch them on either.
    --
    -- So when the person has expressed NO preference for this event, an opted-in, IN-SCOPE
    -- WhatsApp contact supplies the cadence — but only for events flagged
    -- whatsapp_optin_via_booking, i.e. the session lifecycle the person was actually opting in
    -- about. Deliberately NOT invoice_reminder_player or rebook_invite_player: consent given
    -- while booking one session does not authorize payment chasing or "come book again".
    --
    -- An EXPLICIT preference still wins, INCLUDING 'off'. Ticking a box at booking must never
    -- override someone later turning WhatsApp off in settings.
    IF v_channel = 'whatsapp'
       AND v_freq IS NULL
       AND v_evt.whatsapp_optin_via_booking
       AND public.whatsapp_optin_in_scope(
             v_person_id, v_user_id, v_guest_id,
             p_tenant_academy_profile_id, p_tenant_trainer_id) THEN
      v_freq := 'instant';
    END IF;

    v_freq := coalesce(v_freq, v_default_freq);

    -- 6b. required delivery guarantees the EMAIL channel: it can't be off or digested.
    --     (whatsapp/push stay opt-in even for required events — email is the guarantee.)
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
      -- transactional: no opt-IN required, but the DESTINATION must still respect tenant
      -- scope. persons is GLOBAL (unifies guests across academies), so an email collected
      -- under Academy A must not carry Academy B's mail. The contact must be IN-SCOPE
      -- (tenant contacts only in their own tenant) — like whatsapp, minus the opt-in.
      -- A 'global' contact = the person's OWN account-level address, which requires an
      -- account: honored only for ACCOUNT HOLDERS (v_user_id). A guest-only person can
      -- never legitimately own a global contact (its address is always tenant-collected),
      -- so global-scoped guest rows are rejected — else a contact written/defaulted to
      -- 'global' would reopen the cross-tenant leak through 'global' instead of 'tenant'.
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
        -- global fallback ONLY for account holders: persons.email is then their own
        -- account (login) email, legitimately usable in any tenant context. A guest-only
        -- person has NO global email — its address is always tenant-collected, so it must
        -- come from an in-scope contact above, never from this global fallback.
        SELECT email INTO v_dest FROM public.persons WHERE id = v_person_id;
        v_dest_redacted := public.notification_redact_destination(v_dest, 'email');
      END IF;

      IF v_dest IS NULL OR btrim(v_dest) = '' THEN
        v_email_skip := coalesce(v_email_skip, 'no_email_contact');
      ELSIF public.is_email_suppressed(v_dest) THEN
        v_email_skip := 'email_suppressed';   -- hard bounce/complaint: re-sending just re-bounces
      ELSE
        v_deliverable := true;
      END IF;

    ELSE
      -- whatsapp / push: TWO independent gates must BOTH pass. (1) cadence — the per-
      -- event frequency above (default_whatsapp_frequency seeds to 'off', so whatsapp is
      -- opt-in per event via prefs_v2; if it's 'off' we already CONTINUEd). (2) channel/
      -- legal — an explicit, opted-in, IN-TENANT-SCOPE contact. No raw fallback: a
      -- person-keyed opt-in is only usable inside its own tenant provenance.
      -- Same global-only-for-account-holders guard as email (a guest's global contact
      -- must never be usable cross-tenant).
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

    -- 6d. scheduling: instant = now (or caller override); digest = next boundary.
    --     The worker (PR 4+) does the actual batching/quiet-hours via collapse_key.
    v_scheduled := CASE
      WHEN v_freq = 'daily'  THEN date_trunc('day',  v_now) + interval '1 day'  + interval '8 hours'
      WHEN v_freq = 'weekly' THEN date_trunc('week', v_now) + interval '7 days' + interval '8 hours'
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
      idempotency_key, collapse_key, status, scheduled_for
    ) VALUES (
      p_event_key, v_channel,
      v_user_id, v_person_id, v_guest_id,
      p_tenant_academy_profile_id, p_tenant_trainer_id, v_visibility,
      p_related_booking_ids, p_related_invoice_id, p_related_payment_id,
      v_dest, v_dest_redacted, v_contact_id,
      v_template, coalesce(p_payload, '{}'::jsonb), v_public_summary,
      v_idem_key, v_collapse_key, 'pending', v_scheduled
    )
    ON CONFLICT (channel, idempotency_key) DO NOTHING
    RETURNING id INTO v_row_id;

    IF FOUND THEN
      v_emitted := array_append(v_emitted, v_row_id);   -- only NEW rows; a conflict (re-enqueue) yields none
    END IF;
    -- reaching the insert means this recipient IS reachable on some channel (whether
    -- we just created the row or it already existed) → suppress the skipped-row path.
    v_any_deliverable := true;
  END LOOP;

  -- 7. required delivery but nothing was deliverable → a VISIBLE skipped row so ops
  --    and the timelines see the gap (idempotent: won't duplicate a prior outcome).
  --    This records the durable FACT only. Raising the ops Slack alert on skipped-required
  --    rows is the WORKER's job (PR 4) — it scans the outbox and can call edge-slack;
  --    a SECURITY DEFINER SQL function cannot (and shouldn't) make an outbound HTTP call.
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

  -- return the rows this call created (projected to the tenant-safe-ish caller surface;
  -- destination_normalized is included but the function is service-role-only)
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
COMMENT ON FUNCTION public.enqueue_notification(text, uuid, uuid, uuid, uuid, uuid, text, uuid[], uuid, text, text, jsonb, jsonb, timestamptz) IS
  'Notification v2 policy resolver: turns notification intent into idempotent, consent-checked notification_outbox rows (one per deliverable channel). Owns recipient normalization, preference resolution, required-delivery guarantee, tenant-scoped consent, per-recipient idempotency, and required-but-undeliverable skipped rows. service_role only; called by edge functions.';
REVOKE ALL ON FUNCTION public.enqueue_notification(text, uuid, uuid, uuid, uuid, uuid, text, uuid[], uuid, text, text, jsonb, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_notification(text, uuid, uuid, uuid, uuid, uuid, text, uuid[], uuid, text, text, jsonb, jsonb, timestamptz) TO service_role;
