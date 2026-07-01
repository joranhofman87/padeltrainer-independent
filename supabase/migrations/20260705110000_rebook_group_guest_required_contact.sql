-- Slice C (owner decision #4 / Codex P1): a NEW group member added during a rebook must be fully
-- reachable — first name, last name, EMAIL and PHONE are all required. Previously only first name
-- was required, so a captain could add a player with no email (the confirmation email then skipped
-- them) or no phone. The client form (AddGroupMemberFields) now requires all four; enforce the same
-- at the mutation boundary so the RPC can never mint a half-identified guest.
--
-- Re-defines create_rebook_group_guest BYTE-IDENTICAL to 20260626120000 except: (1) a v_phone
-- declaration, (2) last_name/email/phone required guards added next to the existing first_name guard,
-- (3) the INSERT uses v_phone. The rate-limit block, token/scope validation, email dedup and the
-- signature are unchanged (so types.ts needs no regeneration).
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
  v_phone text := NULLIF(trim(_phone), '');
  v_full  text;
  v_id uuid;
  v_rl_count integer;
BEGIN
  -- A new group member must be fully reachable: all four contact fields are required.
  IF v_first IS NULL THEN RAISE EXCEPTION 'first_name_required'; END IF;
  IF v_last  IS NULL THEN RAISE EXCEPTION 'last_name_required'; END IF;
  IF v_email IS NULL THEN RAISE EXCEPTION 'email_required'; END IF;
  IF v_phone IS NULL THEN RAISE EXCEPTION 'phone_required'; END IF;
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
          v_first, v_last, v_full, v_email, v_phone, 'rebook_group')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_rebook_group_guest(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_rebook_group_guest(text, text, text, text, text) TO anon, authenticated;
