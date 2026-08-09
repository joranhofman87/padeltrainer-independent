-- U2 — the rebook group's new member is CREATED, not looked up by address.
--
-- `create_rebook_group_guest` is reachable by `anon` holding a rebook-group claim token, and it
-- deduplicated on `lower(email)` alone: no name, LIMIT 1, first row wins within the owner scope.
-- That is the email-alone identity selection this whole unit exists to remove, still live and still
-- on the most anonymous surface in the product. A capability token says a group may add a member;
-- it does not say which existing human an address belongs to.
--
-- Reproduced from 20260705110000 mechanically. Changed: the signature gains `_creation_request_id`,
-- the declaration gains `v_result`, and the lookup-then-insert becomes one call to
-- `player_create_execute`. Everything else — the four contact guards, the token and scope
-- validation, the rate-limit block — is byte-identical, and
-- `src/test/rebookGroupGuestReproduction.test.ts` checks that mechanically.
--
-- THE FOUR CONTACT GUARDS STAY, and they are not in tension with U2. Slice C (20260705110000,
-- owner decision #4) requires a new group member to be fully reachable — first name, last name,
-- email and phone — because the captain is adding somebody who will be sent a confirmation. That is
-- the address as CONTACT INFORMATION, a required input of this workflow. It is a different thing
-- from the address as IDENTITY, which is what the lookup below used to do and what is now gone: the
-- Player is created on the caller's request uuid, and nothing about them is matched against anyone.
--
-- WHY `player_create_execute` AND NOT `player_create_command`: the caller is anonymous. Nothing
-- about their session authorizes anything; the TOKEN does, and only this function can validate it.
-- The command's job is the scope check, which is the wrong question here. So authorization stays
-- where the evidence for it is, and the mechanism — idempotency, the duplicate proposal, the
-- durable record — is shared rather than reimplemented.

DROP FUNCTION IF EXISTS public.create_rebook_group_guest(text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.create_rebook_group_guest(
  _token text,
  _first_name text,
  _last_name text DEFAULT NULL,
  _email text DEFAULT NULL,
  _phone text DEFAULT NULL,
  -- The captain's own id for THIS add-a-member attempt. Required: it is the only thing that makes
  -- the create idempotent now that the address no longer is (U2, owner 2026-08-09).
  _creation_request_id uuid DEFAULT NULL
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
  v_result jsonb;
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
  IF _creation_request_id IS NULL THEN RAISE EXCEPTION 'creation_request_id_required'; END IF;

  -- Rate limit: at most 10 mint attempts per token per 15-minute window. Bounds distinct-guest
  -- creation (and thus welcome emails) from a single capability. UPSERT resets the window once it
  -- has elapsed (<= so the window closes exactly at the cap edge); the UNIQUE(identifier, endpoint)
  -- row is reused. SECURITY DEFINER bypasses rate_limits' RLS.
  -- Only a genuinely NEW attempt is counted. The limit exists to bound distinct-guest creation from
  -- one capability (and thus the welcome emails it drives); a replay creates nobody. Counting
  -- replays made the retry this function now promises impossible for a group at the cap: a
  -- ten-member group whose apply failed came back as attempt eleven and was refused before the
  -- mechanism could replay a single member.
  -- Under the SAME lock the mechanism takes, so two simultaneous submissions of one attempt cannot
  -- both see no command row: one creates it, the other waits and then finds it. Without the lock the
  -- loser is counted against a limit it should never have touched, and near the cap is refused a
  -- replay it was promised.
  PERFORM pg_advisory_xact_lock(hashtext('player_create:' || _creation_request_id::text));
  IF NOT EXISTS (SELECT 1 FROM public.player_create_commands
                  WHERE creation_request_id = _creation_request_id) THEN
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
  END IF;

  v_full := btrim(concat_ws(' ', v_first, v_last));

  -- The Player is CREATED, through the one mechanism. What stood here instead was a lookup on
  -- `lower(email)` alone — no name, LIMIT 1 — that returned whatever guest happened to share the
  -- address within the owner scope, and it was reachable by `anon` holding a group token. A token
  -- authorizes the ACTION (this group may add a member); it says nothing about WHICH existing human
  -- the typed address belongs to, and households share addresses. Two members of one family added
  -- to a group both landed on the same Player, and a captain who typed a neighbour's address
  -- attached the booking to the neighbour.
  --
  -- Authorization is this function's, not the mechanism's: the token and the rate limit above are
  -- what admit the caller, which is why `player_create_execute` is granted to nobody and reached
  -- only from here and from `player_create_command`.
  v_result := public.player_create_execute(
    _creation_request_id  => _creation_request_id,
    _owner_type           => CASE WHEN s.academy_profile_id IS NOT NULL THEN 'academy' ELSE 'trainer' END,
    _owner_id             => coalesce(s.academy_profile_id, s.trainer_id),
    _origin               => 'self_signup',
    _actor_user_id        => NULL,
    _full_name            => v_full,
    _email                => v_email,
    _phone                => v_phone,
    _first_name           => v_first,
    _last_name            => v_last,
    _source               => 'rebook_group');

  v_id := (v_result->>'guest_player_id')::uuid;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'guest_player_create_failed';
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_rebook_group_guest(text, text, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_rebook_group_guest(text, text, text, text, text, uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.create_rebook_group_guest(text, text, text, text, text, uuid) IS
  'Adds a new member to a rebook group, authorized by the group claim token and rate-limited per token. Since U2 the member is CREATED through player_create_execute on the caller''s creation_request_id — never resolved from the typed address, which decides nothing about who anybody is.';
