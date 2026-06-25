-- Group-captain rebooking, Phase 4 prerequisite: rate-limit create_rebook_group_guest.
--
-- This token-gated RPC mints a guest_players row for a new group member. Phase 4's welcome email
-- goes to that guest's (captain-supplied) address, so an unbounded mint is an email-bomb / DB-bloat
-- vector: a holder of one valid group token could mint many guests to many addresses. The existing
-- email-dedup + the confirmation_sent_at idempotency already cap any SINGLE address to one welcome
-- email, but nothing caps the NUMBER of distinct mints. Add a per-token window cap using the shared
-- rate_limits table (identifier = md5(token), so the raw secret — the capability — is never copied
-- into rate_limits). The companion send-rebook-group-confirmation edge fn applies its own per-token
-- throttle in code (it's service-role over the same table).
--
-- CREATE OR REPLACE reproduces 20260626100000's body verbatim and only inserts the rate-limit block
-- after the token/scope validation (so an invalid token never touches rate_limits). The signature is
-- unchanged, so src/integrations/supabase/types.ts needs no regeneration.
CREATE OR REPLACE FUNCTION public.create_rebook_group_guest(
  _token text,
  _first_name text,
  _last_name text DEFAULT NULL,
  _email text DEFAULT NULL,
  _phone text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.slot_priority_claims;
  s public.availability_slots;
  v_email text := NULLIF(lower(trim(_email)), '');
  v_first text := NULLIF(trim(_first_name), '');
  v_last  text := NULLIF(trim(_last_name), '');
  v_full  text;
  v_id uuid;
  v_rl_count integer;
BEGIN
  IF v_first IS NULL THEN RAISE EXCEPTION 'first_name_required'; END IF;
  SELECT * INTO c FROM public.slot_priority_claims WHERE claim_token = _token LIMIT 1;
  IF c.id IS NULL OR c.rebook_group_id IS NULL THEN RAISE EXCEPTION 'invalid_token'; END IF;
  SELECT * INTO s FROM public.availability_slots WHERE id = c.slot_id;
  IF s.academy_profile_id IS NULL AND s.trainer_id IS NULL THEN RAISE EXCEPTION 'slot_unscoped'; END IF;

  -- Rate limit: at most 10 mint attempts per token per 15-minute window. Bounds distinct-guest
  -- creation (and thus welcome emails) from a single capability. UPSERT resets the window once it
  -- has elapsed (<= so the window closes exactly at the cap edge); the UNIQUE(identifier, endpoint)
  -- row is reused. SECURITY DEFINER bypasses rate_limits' RLS.
  INSERT INTO public.rate_limits AS rl (identifier, endpoint, request_count, window_start)
  VALUES ('rbg:' || md5(_token), 'create_rebook_group_guest', 1, now())
  ON CONFLICT (identifier, endpoint) DO UPDATE
    SET request_count = CASE WHEN rl.window_start <= now() - interval '15 minutes' THEN 1
                             ELSE rl.request_count + 1 END,
        window_start  = CASE WHEN rl.window_start <= now() - interval '15 minutes' THEN now()
                             ELSE rl.window_start END
  RETURNING rl.request_count INTO v_rl_count;
  IF v_rl_count > 10 THEN
    RAISE EXCEPTION 'rate_limit_exceeded';
  END IF;

  v_full := btrim(concat_ws(' ', v_first, v_last));

  -- Dedup by email within the same owner scope (mirrors resolveOrCreateGuestPlayer's core).
  IF v_email IS NOT NULL THEN
    SELECT id INTO v_id FROM public.guest_players
    WHERE lower(email) = v_email
      AND ((s.academy_profile_id IS NOT NULL AND academy_profile_id = s.academy_profile_id)
        OR (s.academy_profile_id IS NULL AND trainer_id = s.trainer_id))
    LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  INSERT INTO public.guest_players (academy_profile_id, trainer_id, first_name, last_name, full_name, email, phone, source)
  VALUES (s.academy_profile_id, CASE WHEN s.academy_profile_id IS NULL THEN s.trainer_id ELSE NULL END,
          v_first, v_last, v_full, v_email, NULLIF(trim(_phone), ''), 'rebook_group')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_rebook_group_guest(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_rebook_group_guest(text, text, text, text, text) TO anon, authenticated;
