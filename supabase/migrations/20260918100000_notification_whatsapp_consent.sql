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
-- 1b. Does this PERSON actually have a relationship with this tenant?
--
-- Needed because an authenticated caller supplies the tenant ids, and nothing else stops them
-- naming an academy they have never played at. That would write a consent row into another
-- tenant's data for someone who never interacted with them — which is both an integrity
-- problem and, since that academy would then be messaging a stranger who "consented", a
-- compliance one. Relationship = a booking on a slot belonging to that academy/trainer,
-- matched through person_links so it covers the profile AND guest sides of one person.
CREATE OR REPLACE FUNCTION public.person_has_tenant_relationship(
  p_person_id uuid,
  p_academy_profile_id uuid,
  p_trainer_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    JOIN public.person_links pl
      ON (pl.profile_id = b.player_id OR pl.guest_player_id = b.guest_player_id)
    WHERE pl.person_id = p_person_id
      AND (
        (p_academy_profile_id IS NOT NULL AND s.academy_profile_id = p_academy_profile_id)
        OR (p_trainer_id IS NOT NULL AND s.trainer_id = p_trainer_id)
      )
  );
$$;
COMMENT ON FUNCTION public.person_has_tenant_relationship(uuid, uuid, uuid) IS
  'Notification v2 (PR 9): TRUE iff the person has a booking with that academy/trainer. Used to stop an authenticated caller consenting on behalf of a tenant they have no relationship with.';
-- INTERNAL ONLY — deliberately NOT granted to `authenticated`. This is SECURITY DEFINER and
-- bypasses RLS to answer "does person X have bookings with tenant Y?", so exposing it to
-- clients would make it a RELATIONSHIP ORACLE for anyone able to obtain or guess UUIDs (the
-- same trap is_reviewable_booking fell into in PR 595). record_whatsapp_optin is itself
-- SECURITY DEFINER, so it calls this with the DEFINER's privileges — the opt-in path is
-- unaffected by revoking the caller's.
REVOKE ALL ON FUNCTION public.person_has_tenant_relationship(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.person_has_tenant_relationship(uuid, uuid, uuid) TO service_role;

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

  -- An authenticated caller supplies the tenant ids, so they are UNTRUSTED: verify the person
  -- actually plays at that tenant. service_role (auth.uid() IS NULL) is our own booking flow,
  -- which legitimately knows the tenant before a relationship exists. IS NOT TRUE, not NOT(),
  -- so a NULL fails closed.
  IF auth.uid() IS NOT NULL AND NOT public.is_admin(auth.uid()) THEN
    IF public.person_has_tenant_relationship(p_person_id, v_academy, v_trainer) IS NOT TRUE THEN
      RAISE EXCEPTION 'no relationship with that tenant' USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.notification_contacts (
    person_id, channel, destination_normalized, destination_redacted,
    consent_status, consent_scope, consent_academy_profile_id, consent_trainer_id,
    consent_source, consent_at, revoked_at, is_primary
  ) VALUES (
    p_person_id, 'whatsapp', v_phone, public.notification_redact_destination(v_phone, 'whatsapp'),
    'opted_in', 'tenant', v_academy, v_trainer,
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

  -- RETIRE the person's OTHER whatsapp numbers. Without this, a phone change leaves two
  -- opted-in contacts and the resolver's `ORDER BY is_primary DESC, verified_at DESC NULLS
  -- LAST` is non-deterministic between them — so it can keep messaging the OLD number, which
  -- after recycling may belong to a stranger. One active WhatsApp number per person.
  UPDATE public.notification_contacts
  SET is_primary = false, consent_status = 'opted_out',
      -- coalesce, not now(): the WHERE below already skips revoked rows, but keeping the
      -- FIRST withdrawal time here too means the invariant survives that guard being relaxed.
      revoked_at = coalesce(revoked_at, now()), updated_at = now()
  WHERE channel = 'whatsapp'
    AND person_id = p_person_id
    AND id <> v_id
    AND revoked_at IS NULL;

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

  -- revoked_at records WHEN the person asked us to stop, so it must be the FIRST withdrawal,
  -- not the latest write. Twilio re-delivers status callbacks, and a retried 21610 (or a second
  -- STOP) would otherwise walk that timestamp forward — the consent state stays correct either
  -- way, but the audit trail quietly stops answering the question it exists to answer.
  -- updated_at still moves: that is the row's write time, which is a different fact.
  UPDATE public.notification_contacts
  SET consent_status = 'opted_out',
      revoked_at = coalesce(revoked_at, now()),
      updated_at = now()
  WHERE channel = 'whatsapp' AND destination_normalized = v_phone;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
COMMENT ON FUNCTION public.record_whatsapp_optout(text) IS
  'Notification v2 (PR 9): revoke WhatsApp consent for a number across ALL tenants — a STOP reply addresses the sender, not one academy. Idempotent: revoked_at keeps the FIRST withdrawal time, so a re-delivered Twilio callback cannot move the audit timestamp. service_role only (called by the Twilio inbound/status webhook).';
REVOKE ALL ON FUNCTION public.record_whatsapp_optout(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_optout(text) TO service_role;
