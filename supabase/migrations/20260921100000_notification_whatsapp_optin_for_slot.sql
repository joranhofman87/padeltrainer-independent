-- Notification Foundation v2 — PR 9: opt-in from the SELF-SERVICE booking flows.
--
-- The booking moment is the right place to ask: the person is entering (or confirming) their
-- own number, and the slot supplies real tenant context. The rule the owner set is that the
-- tenant must be DERIVED SERVER-SIDE and never taken from the client.
--
-- Two callers need that, with different trust:
--   * GUEST checkout — the edge function already re-reads the slot for trainer/academy and runs
--     as service_role, so it can keep calling record_whatsapp_optin directly.
--   * LOGGED-IN BookLesson — has THREE booking paths and only one goes through an edge function
--     (the other two insert client-side), so a checkbox wired only to the server path would
--     silently do nothing on two of three routes. Hence record_whatsapp_optin_for_slot below:
--     the client passes a SLOT ID, never a tenant id, and the server derives the rest.
--
-- Doing that needed the write extracted, because the existing record_whatsapp_optin validates
-- caller-supplied tenant ids against person_has_tenant_relationship — correct there, wrong
-- here: on the pay-first path the booking does not exist yet, so the check would reject a
-- legitimate opt-in. Rather than weaken that function or copy its body (two places to fix the
-- next retire/idempotency bug), the INSERT+RETIRE moves into one internal function and each
-- public wrapper keeps its OWN authorization.

-- ---------------------------------------------------------------------------
-- 1. The write itself. NO authorization here by design — every caller is a SECURITY DEFINER
--    wrapper that has already established who may write what. Internal only.
CREATE OR REPLACE FUNCTION public.write_whatsapp_optin(
  p_person_id          uuid,
  p_phone_e164         text,     -- ALREADY normalized; callers own that
  p_academy_profile_id uuid,
  p_trainer_id         uuid,
  p_source             text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_person_id IS NULL OR p_phone_e164 IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_academy_profile_id IS NULL AND p_trainer_id IS NULL THEN
    RETURN NULL;                        -- a tenant-scoped consent MUST name its tenant
  END IF;

  INSERT INTO public.notification_contacts (
    person_id, channel, destination_normalized, destination_redacted,
    consent_status, consent_scope, consent_academy_profile_id, consent_trainer_id,
    consent_source, consent_at, revoked_at, is_primary
  ) VALUES (
    p_person_id, 'whatsapp', p_phone_e164,
    public.notification_redact_destination(p_phone_e164, 'whatsapp'),
    'opted_in', 'tenant', p_academy_profile_id, p_trainer_id,
    coalesce(p_source, 'settings'), now(), NULL, true
  )
  ON CONFLICT (channel, destination_normalized, person_id) WHERE person_id IS NOT NULL
  DO UPDATE SET
    consent_status             = 'opted_in',
    consent_scope              = 'tenant',
    consent_academy_profile_id = excluded.consent_academy_profile_id,
    consent_trainer_id         = excluded.consent_trainer_id,
    consent_source             = excluded.consent_source,
    consent_at                 = now(),
    revoked_at                 = NULL,          -- re-opting in clears a previous revocation
    is_primary                 = true,
    updated_at                 = now()
  RETURNING id INTO v_id;

  -- RETIRE the person's OTHER whatsapp numbers. Without this a phone change leaves two
  -- opted-in contacts and the resolver's ordering between them is non-deterministic, so it can
  -- keep messaging the OLD number — which after recycling may belong to a stranger.
  UPDATE public.notification_contacts
  SET is_primary = false, consent_status = 'opted_out',
      revoked_at = coalesce(revoked_at, now()), updated_at = now()
  WHERE channel = 'whatsapp'
    AND person_id = p_person_id
    AND id <> v_id
    AND revoked_at IS NULL;

  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION public.write_whatsapp_optin(uuid, text, uuid, uuid, text) IS
  'Notification v2 (PR 9): INTERNAL — the WhatsApp consent write (upsert + retire the person''s other numbers), with NO authorization of its own. Every caller is a SECURITY DEFINER wrapper that has already decided who may write what. service_role only.';
REVOKE ALL ON FUNCTION public.write_whatsapp_optin(uuid, text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_whatsapp_optin(uuid, text, uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. record_whatsapp_optin now delegates the write. Its OWN rules are unchanged:
--    self-only for authenticated callers, and caller-supplied tenant ids are verified against
--    person_has_tenant_relationship (they are untrusted precisely because the caller chose them).
CREATE OR REPLACE FUNCTION public.record_whatsapp_optin(
  p_person_id          uuid,
  p_phone              text,
  p_academy_profile_id uuid DEFAULT NULL,
  p_trainer_id         uuid DEFAULT NULL,
  p_source             text DEFAULT 'settings'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_phone   text := public.normalize_phone_e164(p_phone);
  v_academy uuid;
  v_trainer uuid;
BEGIN
  IF p_person_id IS NULL OR v_phone IS NULL THEN
    RETURN NULL;                      -- unusable phone => no consent row, never a guess
  END IF;

  -- Only yourself, unless you are service_role (auth.uid() IS NULL) or admin.
  IF auth.uid() IS NOT NULL
     AND p_person_id IS DISTINCT FROM public.get_my_person_id()
     AND NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized to opt in on behalf of another person'
      USING ERRCODE = '42501';
  END IF;

  -- Tenant scope: academy when present, else trainer.
  IF p_academy_profile_id IS NOT NULL THEN
    v_academy := p_academy_profile_id; v_trainer := NULL;
  ELSIF p_trainer_id IS NOT NULL THEN
    v_academy := NULL; v_trainer := p_trainer_id;
  ELSE
    RETURN NULL;
  END IF;

  -- Caller-supplied tenant ids are UNTRUSTED: verify the person actually plays there.
  -- IS NOT TRUE, not NOT(), so a NULL fails closed.
  IF auth.uid() IS NOT NULL AND NOT public.is_admin(auth.uid()) THEN
    IF public.person_has_tenant_relationship(p_person_id, v_academy, v_trainer) IS NOT TRUE THEN
      RAISE EXCEPTION 'no relationship with that tenant' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN public.write_whatsapp_optin(p_person_id, v_phone, v_academy, v_trainer, p_source);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Opt in from a booking flow, with the tenant DERIVED FROM THE SLOT.
--
-- The client sends a slot id and a phone — never a tenant id, which is the whole point. The
-- caller may only opt THEMSELVES in, so the person comes from auth.uid() and is never a
-- parameter; there is deliberately no "on behalf of" form, because staff entering a player's
-- number is not that player consenting.
--
-- No person_has_tenant_relationship check here, and that is not a gap: the tenant was not
-- claimed by the caller, it was read from the slot. Requiring an existing booking would break
-- the pay-first path, where the booking is created only after payment.
CREATE OR REPLACE FUNCTION public.record_whatsapp_optin_for_slot(
  p_slot_id uuid,
  p_phone   text,
  p_source  text DEFAULT 'booking_form'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_person  uuid := public.get_my_person_id();
  v_phone   text := public.normalize_phone_e164(p_phone);
  v_academy uuid;
  v_trainer uuid;
BEGIN
  IF auth.uid() IS NULL OR v_person IS NULL THEN
    RAISE EXCEPTION 'not authorized to record WhatsApp consent' USING ERRCODE = '42501';
  END IF;
  IF p_slot_id IS NULL OR v_phone IS NULL THEN
    RETURN NULL;                      -- unusable phone => no consent row, never a guess
  END IF;

  SELECT s.academy_profile_id, s.trainer_id
    INTO v_academy, v_trainer
  FROM public.availability_slots s
  WHERE s.id = p_slot_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- academy when present, else trainer — the same rule PR 6a settled on for guest email.
  IF v_academy IS NOT NULL THEN
    v_trainer := NULL;
  ELSIF v_trainer IS NULL THEN
    RETURN NULL;                      -- a slot with neither cannot scope a consent
  END IF;

  RETURN public.write_whatsapp_optin(v_person, v_phone, v_academy, v_trainer, p_source);
END;
$$;
COMMENT ON FUNCTION public.record_whatsapp_optin_for_slot(uuid, text, text) IS
  'Notification v2 (PR 9): a logged-in person opts THEMSELVES in to WhatsApp while booking. The tenant is derived from the SLOT server-side — the client never supplies an academy/trainer id. No "on behalf of" form exists: staff entering a player''s number is not that player consenting.';
REVOKE ALL ON FUNCTION public.record_whatsapp_optin_for_slot(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_optin_for_slot(uuid, text, text) TO authenticated, service_role;
