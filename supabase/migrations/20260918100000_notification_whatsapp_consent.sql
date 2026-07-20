-- Notification Foundation v2 — PR 9: WhatsApp phone normalization + consent storage.
--
-- WhatsApp is NOT email. The resolver (PR 3) already refuses to send whatsapp without an
-- OPTED-IN contact whose consent is IN TENANT SCOPE — this migration supplies the only
-- sanctioned way to create and revoke that consent, plus the E.164 normalization it depends on.
--
-- Why explicit opt-in and not a bulk enable: Meta's WhatsApp Business policy requires opt-in
-- that names the business and the channel, and consent cannot be inferred from "we already
-- have their number". Enforcement is mechanical — recipients blocking/reporting drives the
-- sender's quality rating down and can get the sender DISABLED. The ~350 phone numbers already
-- in `persons` were collected for bookings, so they are not a WhatsApp audience and this
-- migration deliberately does NOT backfill consent from them.

-- ---------------------------------------------------------------------------
-- 1. E.164 normalization. Phones are stored FREE-TEXT today ('06 12345678',
--    '+31 6 1234 5678', '0031612345678'), and Twilio requires strict E.164.
--
-- FAILS CLOSED: anything it cannot confidently normalize returns NULL, and every caller
-- treats NULL as "no deliverable destination" rather than guessing. A wrong guess here does
-- not error — it messages a stranger.
CREATE OR REPLACE FUNCTION public.normalize_phone_e164(
  p_phone text,
  p_default_country_code text DEFAULT '31'   -- NL; the platform's home market
) RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v text;
BEGIN
  IF p_phone IS NULL THEN RETURN NULL; END IF;

  -- strip everything a human might type as separators
  v := regexp_replace(p_phone, '[\s().\-/]', '', 'g');
  IF v = '' THEN RETURN NULL; END IF;

  -- international prefixes: 00XX -> +XX
  IF v LIKE '00%' THEN
    v := '+' || substring(v FROM 3);
  -- national trunk prefix: 0XXXXXXXXX -> +<cc>XXXXXXXXX
  ELSIF v LIKE '0%' THEN
    v := '+' || p_default_country_code || substring(v FROM 2);
  -- already international
  ELSIF v LIKE '+%' THEN
    v := v;
  ELSE
    -- No '+', no leading 0. We will NOT guess whether a bare number already carries a
    -- country code — that is exactly how a Dutch mobile becomes someone else's number.
    RETURN NULL;
  END IF;

  -- E.164: '+', a non-zero country digit, then 7..14 more digits (8..15 total)
  IF v ~ '^\+[1-9][0-9]{7,14}$' THEN
    RETURN v;
  END IF;
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION public.normalize_phone_e164(text, text) IS
  'Notification v2 (PR 9): free-text phone -> strict E.164, or NULL when it cannot be normalized confidently. Fails closed: a bad guess would message a stranger. Bare numbers with no + and no leading 0 are rejected rather than assumed.';

-- ---------------------------------------------------------------------------
-- 2. Record a WhatsApp OPT-IN as a tenant-scoped, opted-in contact.
--
-- AUTH-BOUND: an authenticated caller may only opt IN THEMSELVES. service_role (auth.uid()
-- IS NULL, since anon is revoked below so no unauthenticated caller can reach this) may act
-- for a person on behalf of a server-side flow such as the booking form.
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
  v_id      uuid;
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

  -- Tenant scope: academy when present, else trainer (the same rule PR 6a settled on for
  -- guest email — a person is the ACADEMY's contact; pinning a trainer would flip between
  -- trainers within one academy). A tenant-scoped consent MUST name its tenant.
  IF p_academy_profile_id IS NOT NULL THEN
    v_academy := p_academy_profile_id; v_trainer := NULL;
  ELSIF p_trainer_id IS NOT NULL THEN
    v_academy := NULL; v_trainer := p_trainer_id;
  ELSE
    RETURN NULL;                      -- no tenant => no coherent tenant-scoped consent
  END IF;

  INSERT INTO public.notification_contacts (
    person_id, channel, destination_normalized, destination_redacted,
    consent_status, consent_scope, consent_academy_profile_id, consent_trainer_id,
    consent_source, consent_at, revoked_at
  ) VALUES (
    p_person_id, 'whatsapp', v_phone, public.notification_redact_destination(v_phone, 'whatsapp'),
    'opted_in', 'tenant', v_academy, v_trainer,
    coalesce(p_source, 'settings'), now(), NULL
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
    updated_at                 = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION public.record_whatsapp_optin(uuid, text, uuid, uuid, text) IS
  'Notification v2 (PR 9): record an explicit WhatsApp opt-in as a tenant-scoped opted_in contact (academy when present, else trainer). Auth-bound: an authenticated caller may only opt in themselves. Returns NULL when the phone cannot be normalized to E.164 or no tenant is given.';
REVOKE ALL ON FUNCTION public.record_whatsapp_optin(uuid, text, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_optin(uuid, text, uuid, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Record a WhatsApp OPT-OUT.
--
-- PLATFORM-WIDE BY DESIGN: a user replying STOP is telling the SENDER (our one platform
-- number) to stop — they are not making a per-academy distinction, and they have no way to.
-- So every whatsapp contact on that number is revoked, across tenants. Honouring it narrowly
-- would keep messaging someone who explicitly said stop.
CREATE OR REPLACE FUNCTION public.record_whatsapp_optout(p_phone text)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_phone text := public.normalize_phone_e164(p_phone);
  v_count int;
BEGIN
  IF v_phone IS NULL THEN RETURN 0; END IF;

  UPDATE public.notification_contacts
  SET consent_status = 'opted_out', revoked_at = now(), updated_at = now()
  WHERE channel = 'whatsapp' AND destination_normalized = v_phone;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
COMMENT ON FUNCTION public.record_whatsapp_optout(text) IS
  'Notification v2 (PR 9): revoke WhatsApp consent for a number across ALL tenants — a STOP reply addresses the sender, not one academy. service_role only (called by the Twilio inbound/status webhook).';
REVOKE ALL ON FUNCTION public.record_whatsapp_optout(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_optout(text) TO service_role;
