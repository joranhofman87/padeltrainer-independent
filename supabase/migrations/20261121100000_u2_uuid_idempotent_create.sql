-- U2 — Player creation keyed on a request UUID, not on a person's attributes.
--
-- THE DECISION (owner, 2026-08-09). `person_id` is the canonical Player identity. A separate stable
-- UUID identifies each CREATE COMMAND. Email, phone and names are mutable attributes and possible
-- matching signals; they are neither identity nor idempotency keys. Knowing a UUID never grants
-- authorization.
--
-- WHAT THIS REPLACES. The previous `academy_create_player` deduplicated on email AND name. That is
-- better than email alone, but it is still identity inferred from attributes: two people who share a
-- household address and a name collapse into one, and a person who corrects their own name stops
-- being idempotent with themselves. The caller now says which create attempt this is, once, and says
-- it again on every retry.
--
-- WHY A DURABLE TABLE AND NOT THE GUEST ROW. A guest row disappears — claimed into an account,
-- merged by an operator, anonymized, deleted with its academy. Using its existence as the
-- idempotency record means a retry after any of those silently creates a second Player. The record
-- is its own row, and it is repointed rather than removed when the person it names is merged away.
--
-- WHAT PII MATCHING MAY STILL DO. Propose. A create whose name and address match an existing Player
-- files a PENDING `possible_duplicate_player` review row and still creates the Player it was asked
-- for. Matching proposes; only a human decides. That is the same rule slice 1 established, applied
-- to creation.

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The durable command record
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.player_create_commands (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- GLOBALLY unique, not unique per academy: reusing one request id against a different academy is
  -- a caller bug, and it has to be detectable as one rather than quietly making a second Player.
  creation_request_id uuid NOT NULL UNIQUE,
  academy_profile_id  uuid NOT NULL REFERENCES public.academy_profiles(id) ON DELETE CASCADE,
  actor_user_id       uuid NOT NULL,
  -- sha256 over the normalized payload. Not an identity key — it exists so that reusing a request
  -- id with DIFFERENT material facts is refused rather than silently answered with the old result.
  payload_fingerprint text NOT NULL,
  -- The canonical answer. ON DELETE SET NULL rather than CASCADE: the command record must outlive
  -- the Player it made, or a retry after a deletion would quietly make another one. A NULL here is
  -- a fact ("the Player this produced is gone"), and the command refuses rather than re-creating.
  person_id           uuid REFERENCES public.persons(id) ON DELETE SET NULL,
  -- Compatibility only: the source row today's readers still key on. It may go NULL under the same
  -- lifecycle events; `person_id` is the answer that matters.
  guest_player_id     uuid REFERENCES public.guest_players(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_player_create_commands_person
  ON public.player_create_commands (person_id);
CREATE INDEX IF NOT EXISTS idx_player_create_commands_academy
  ON public.player_create_commands (academy_profile_id, created_at);

-- Default-deny: RLS on with NO policies, and the named roles revoked as well — this project's
-- ALTER DEFAULT PRIVILEGES grants new objects to anon/authenticated, so revoking PUBLIC alone
-- leaves them reachable. Only the command function, which is SECURITY DEFINER, touches this.
ALTER TABLE public.player_create_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.player_create_commands FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.player_create_commands IS
  'One row per Player-create command, keyed on the caller''s creation_request_id. The durable idempotency record: it survives the claim, merge, anonymization or deletion of the guest source, and is repointed when the person it names is merged away. Owner-only — reachable solely through academy_create_player.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Canonical payload encoding
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- Length-prefixed, so that ("ab","c") and ("a","bc") cannot produce one string. NULL and the empty
-- string encode differently — "no email given" and "email cleared" are different facts.
CREATE OR REPLACE FUNCTION public.u2_ns(_v text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT CASE WHEN _v IS NULL THEN '~,' ELSE length(_v)::text || ':' || _v || ',' END $$;

CREATE OR REPLACE FUNCTION public.u2_norm(_v text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT nullif(lower(btrim(regexp_replace(coalesce(_v, ''), '\s+', ' ', 'g'))), '') $$;

CREATE OR REPLACE FUNCTION public.player_create_fingerprint(
  _full_name text, _email text, _phone text, _select_person_id uuid
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT encode(extensions.digest(
    public.u2_ns(public.u2_norm(_full_name))
    || public.u2_ns(public.u2_norm(_email))
    || public.u2_ns(public.u2_norm(_phone))
    || public.u2_ns(_select_person_id::text), 'sha256'), 'hex');
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Is this Player already this academy's to speak for?
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- For `_select_person_id`. Knowing a person's UUID is not permission to attach it to your academy —
-- UUIDs travel. The academy must already have a relationship with that Player: a membership, or a
-- guest of its own that links to them.
CREATE OR REPLACE FUNCTION public.academy_may_select_person(_academy_profile_id uuid, _person_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.academy_player_memberships m
                  WHERE m.academy_profile_id = _academy_profile_id AND m.person_id = _person_id)
      OR EXISTS (SELECT 1 FROM public.person_links pl
                  JOIN public.guest_players g ON g.id = pl.guest_player_id
                 WHERE pl.person_id = _person_id AND g.academy_profile_id = _academy_profile_id);
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The command
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.academy_create_player(uuid, text, text, text, uuid);

CREATE OR REPLACE FUNCTION public.academy_create_player(
  _academy_profile_id  uuid,
  _creation_request_id uuid,
  _full_name           text,
  _email               text DEFAULT NULL,
  _phone               text DEFAULT NULL,
  -- "this is an existing Player", by canonical id. Authorized, never assumed from possession.
  _select_person_id    uuid DEFAULT NULL,
  -- Service-role callers (the edge function) name the acting user; a signed-in caller cannot.
  _actor_user_id       uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  -- the REQUEST's role, from the JWT. PostgREST connects as `authenticator` and switches role from
  -- the token, so `session_user` is `authenticator` for a service-key call too and would never match.
  v_is_service boolean := (auth.role() = 'service_role');
  v_uid uuid;
  v_name text := public.u2_norm(_full_name);
  v_email text := public.u2_norm(_email);
  v_fp text;
  v_cmd public.player_create_commands%ROWTYPE;
  v_person uuid;
  v_guest uuid;
  v_dupe uuid;
BEGIN
  v_uid := CASE WHEN v_is_service THEN coalesce(_actor_user_id, auth.uid()) ELSE auth.uid() END;

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'PLAYER_CREATE_NOT_AUTHENTICATED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF _creation_request_id IS NULL THEN
    RAISE EXCEPTION 'PLAYER_CREATE_REQUEST_ID_REQUIRED: a create command must say which attempt it is'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_name IS NULL AND _select_person_id IS NULL THEN
    RAISE EXCEPTION 'PLAYER_CREATE_NAME_REQUIRED: a new Player needs a name'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT (public.is_academy_manager(v_uid, _academy_profile_id)
          OR public.is_academy_owner(v_uid, _academy_profile_id)) THEN
    RAISE EXCEPTION 'PLAYER_CREATE_FORBIDDEN: you do not manage that academy'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Serialize on the REQUEST, not on the address. Two concurrent submissions of one attempt must
  -- produce one Player; two different attempts are free to run at the same time.
  PERFORM pg_advisory_xact_lock(hashtext('player_create:' || _creation_request_id::text));

  v_fp := public.player_create_fingerprint(_full_name, _email, _phone, _select_person_id);

  SELECT * INTO v_cmd FROM public.player_create_commands
   WHERE creation_request_id = _creation_request_id FOR UPDATE;

  IF FOUND THEN
    -- Same attempt. It must be the SAME attempt in every material respect, or the caller has reused
    -- an id and is owed an error rather than somebody else's answer.
    IF v_cmd.academy_profile_id <> _academy_profile_id
       OR v_cmd.actor_user_id <> v_uid
       OR v_cmd.payload_fingerprint <> v_fp THEN
      RAISE EXCEPTION 'PLAYER_CREATE_IDEMPOTENCY_CONFLICT: request % was already used for a different create',
        _creation_request_id USING ERRCODE = 'unique_violation';
    END IF;

    IF v_cmd.person_id IS NULL THEN
      RAISE EXCEPTION 'PLAYER_CREATE_RESULT_GONE: the Player request % created no longer exists',
        _creation_request_id USING ERRCODE = 'raise_exception';
    END IF;

    RETURN jsonb_build_object(
      'person_id', v_cmd.person_id,
      'guest_player_id', v_cmd.guest_player_id,
      'created', false,
      'replayed', true,
      'creation_request_id', _creation_request_id);
  END IF;

  -- ── a genuinely new attempt ──────────────────────────────────────────────────────────────────
  IF _select_person_id IS NOT NULL THEN
    IF NOT public.academy_may_select_person(_academy_profile_id, _select_person_id) THEN
      -- knowing the uuid is not the same as being allowed to use it
      RAISE EXCEPTION 'PLAYER_CREATE_PERSON_NOT_YOURS: that Player is not one this academy can select'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_person := _select_person_id;
    SELECT pl.guest_player_id INTO v_guest
      FROM public.person_links pl
      JOIN public.guest_players g ON g.id = pl.guest_player_id
     WHERE pl.person_id = v_person AND g.academy_profile_id = _academy_profile_id
     LIMIT 1;
  ELSE
    INSERT INTO public.guest_players (full_name, email, phone, academy_profile_id, source)
    VALUES (btrim(_full_name), v_email, public.u2_norm(_phone), _academy_profile_id, 'academy_created')
    RETURNING id INTO v_guest;

    SELECT person_id INTO v_person FROM public.person_links WHERE guest_player_id = v_guest;
    IF v_person IS NULL THEN
      RAISE EXCEPTION 'PLAYER_CREATE_NO_PERSON: the new Player was not given a canonical identity'
        USING ERRCODE = 'raise_exception';
    END IF;

    -- PII may PROPOSE. A different create attempt that looks like this one is a candidate for a
    -- human to judge, not a reason to hand back somebody else's Player.
    IF v_email IS NOT NULL THEN
      SELECT g.id INTO v_dupe
        FROM public.guest_players g
       WHERE g.academy_profile_id = _academy_profile_id
         AND g.id <> v_guest
         AND public.u2_norm(g.email) = v_email
         AND public.u2_norm(g.full_name) = v_name
       LIMIT 1;

      IF v_dupe IS NOT NULL THEN
        INSERT INTO public.person_merge_review (kind, status, email, guest_player_id, person_id, details)
        VALUES ('possible_duplicate_player', 'pending', v_email, v_guest, v_person,
                jsonb_build_object('via', 'academy_create_player',
                                   'looks_like_guest_player_id', v_dupe,
                                   'note', 'proposed only — matching attributes do not decide identity'));
      END IF;
    END IF;
  END IF;

  INSERT INTO public.player_create_commands
    (creation_request_id, academy_profile_id, actor_user_id, payload_fingerprint, person_id, guest_player_id)
  VALUES (_creation_request_id, _academy_profile_id, v_uid, v_fp, v_person, v_guest);

  RETURN jsonb_build_object(
    'person_id', v_person,
    'guest_player_id', v_guest,
    'created', _select_person_id IS NULL,
    'replayed', false,
    'creation_request_id', _creation_request_id);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Lifecycle: the record follows the person it names
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- The collapse repoints every column that names the dying person and then deletes it. Without this
-- line the FK would null the command's answer during a perfectly ordinary claim, and the next retry
-- would refuse with RESULT_GONE for a Player that is alive and well under a different id.
CREATE OR REPLACE FUNCTION public.collapse_guest_person_into_reporting(
  _guest_id uuid, _guest_person uuid, _target_person uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_memberships jsonb;
BEGIN
  -- U2: the durable create-command record names this person. Repointed FIRST, because the body
  -- below ends by DELETING the source person and the record's ON DELETE SET NULL would fire before
  -- anything else could — losing a finished command's answer during an ordinary claim, and making
  -- the next retry refuse for a Player that is alive under a different id.
  UPDATE public.player_create_commands
     SET person_id = _target_person
   WHERE person_id = _guest_person;

  IF _guest_person = _target_person THEN
    RETURN jsonb_build_object('ok', true, 'moved', 0, 'coalesced', 0);
  END IF;
  IF EXISTS (SELECT 1 FROM public.person_links
             WHERE person_id = _guest_person AND guest_player_id IS DISTINCT FROM _guest_id)
     OR EXISTS (SELECT 1 FROM public.persons WHERE id = _guest_person AND user_id IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'moved', 0, 'coalesced', 0);
  END IF;
  UPDATE public.person_links SET person_id = _target_person WHERE guest_player_id = _guest_id;
  PERFORM public.rederive_person(_target_person);  -- the merged guest now fills the target's gaps
  UPDATE public.bookings SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;
  UPDATE public.bookings SET paid_by_person_id = _target_person
    WHERE paid_by_guest_player_id = _guest_id AND paid_by_person_id = _guest_person;
  UPDATE public.invoices SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;
  UPDATE public.intake_requests SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;
  UPDATE public.slot_priority_claims SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;
  UPDATE public.slot_priority_claims SET booked_by_person_id = _target_person
    WHERE booked_by_guest_player_id = _guest_id AND booked_by_person_id = _guest_person;
  UPDATE public.session_player_notes SET subject_person_id = _target_person
    WHERE subject_guest_player_id = _guest_id AND subject_person_id = _guest_person;
  UPDATE public.academy_player_locations SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;
  UPDATE public.academy_player_metadata SET person_id = _target_person
    WHERE guest_player_id = _guest_id AND person_id = _guest_person;

  -- THE ADDITION. Memberships are keyed by PERSON, not by the guest row, so they are not covered by
  -- any of the updates above — and their FK is RESTRICT, so without this the DELETE below fails and
  -- the whole collapse aborts once the table is populated.
  v_memberships := public.repoint_person_memberships(_guest_person, _target_person);

  DELETE FROM public.persons WHERE id = _guest_person;
  RETURN jsonb_build_object(
    'ok', true,
    'moved',     coalesce((v_memberships->>'moved')::int, 0),
    'coalesced', coalesce((v_memberships->>'coalesced')::int, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.u2_ns(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.u2_norm(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.player_create_fingerprint(text, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_may_select_person(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.academy_create_player(uuid, uuid, text, text, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.academy_create_player(uuid, uuid, text, text, text, uuid, uuid)
  TO authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Round-5 finding 2: the money-stamping linker was anonymously callable
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- `link_guest_data_to_profile` is SECURITY DEFINER and writes `player_id` onto bookings and
-- invoices. Slice 1 replaced its body without re-issuing its grants, and this project's
-- ALTER DEFAULT PRIVILEGES hands new functions to anon and authenticated — so a `REVOKE ... FROM
-- PUBLIC` alone would have left an unauthenticated caller able to invoke it with any profile uuid.
-- It cannot establish a link (slice 1 removed that arm), so the blast radius is limited to honouring
-- links somebody already made, but it is still an unauthenticated write to financial rows.
--
-- Its call graph is entirely internal: the `link_guest_invoices_on_signup` and
-- `trg_link_guest_data_on_guest_player_change` triggers, and `person_claim_confirm`. All three run
-- as their own definer, so none of them needs a grant to anyone.
REVOKE ALL ON FUNCTION public.link_guest_data_to_profile(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.link_guest_data_to_profile(uuid) IS
  'Stamps player_id on the bookings/invoices of guests ALREADY linked to this profile. Internal: every caller is a trigger or a SECURITY DEFINER command running as its own owner, so EXECUTE is granted to nobody.';
