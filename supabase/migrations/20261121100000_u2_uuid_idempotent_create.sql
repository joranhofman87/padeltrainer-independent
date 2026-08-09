-- U2 — Player creation keyed on a request UUID, not on a person's attributes.
--
-- THE DECISION (owner, 2026-08-09). `person_id` is the canonical Player identity. A separate stable
-- UUID identifies each CREATE COMMAND. Email, phone and names are mutable attributes and possible
-- matching signals; they are neither identity nor idempotency keys. They may PROPOSE a candidate;
-- they may never select, merge or reuse one. Knowing a UUID never grants authorization.
--
-- WHAT THIS REPLACES. Every writer that used to answer "who is this?" by looking a name and an
-- address up in a table. There was one such rule per writer — the edge function had its own, the
-- invoice form had its own, the public intake form had a third — so the system could and did
-- disagree with itself about one human. There is now ONE create command, and every writer goes
-- through it. It is scope-aware rather than academy-only for exactly that reason: a rule that exists
-- for academies and not for trainers is a rule with a hole in it.
--
-- WHY A DURABLE TABLE AND NOT THE GUEST ROW. A guest row disappears — claimed into an account,
-- merged by an operator, anonymized, deleted with its academy. Using its existence as the
-- idempotency record means a retry after any of those silently creates a second Player. The record
-- is its own row, and it is repointed rather than removed when the person it names is merged away.
--
-- WHAT PII MATCHING MAY STILL DO. Propose. A create that looks like an existing Player in the same
-- scope files a PENDING `possible_duplicate_player` review row and still creates the Player it was
-- asked for. Matching proposes; only a human decides. That is the rule slice 1 established, applied
-- to creation.

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The durable command record
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- RETENTION. The owner-scope columns carry NO foreign key, exactly like `academy_deletion_audit`
-- and `account_deletion_audit`: this row is the evidence that a create happened, and evidence that
-- cascades away with its subject is not evidence. Deleting an academy must not silently make every
-- finished create command retryable again. The row holds ids, a scope, an actor and a one-way
-- digest — no name, address or phone number — so it survives a deletion without carrying PII
-- through it.
--
-- `person_id` and `guest_player_id` DO carry FKs, and deliberately: ON DELETE SET NULL there is a
-- fact rather than a loss. A NULL `person_id` says "the Player this command produced no longer
-- exists", and the command answers a retry with PLAYER_CREATE_RESULT_GONE instead of quietly making
-- a second one. Where a successor person exists, the merge paths repoint the row before the delete.
CREATE TABLE IF NOT EXISTS public.player_create_commands (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- GLOBALLY unique, not unique per scope: reusing one request id against a different owner is a
  -- caller bug, and it has to be detectable as one rather than quietly making a second Player.
  creation_request_id uuid NOT NULL UNIQUE,
  -- `guest_players` carries a CHECK requiring a trainer or an academy, so there is no such thing as
  -- an ownerless Player in this schema and this column has no third value to offer.
  owner_type          text NOT NULL CHECK (owner_type IN ('academy', 'trainer')),
  owner_id            uuid NOT NULL,
  -- WHO the create came from. 'operator' is a signed-in human acting on a scope they control;
  -- 'self_signup' is the public registration form, where the registrant is the only party present
  -- and there is no operator to name.
  origin              text NOT NULL CHECK (origin IN ('operator', 'self_signup')),
  actor_user_id       uuid,
  -- sha256 over the normalized identity payload. Not an identity key — it exists so that reusing a
  -- request id with DIFFERENT material facts is refused rather than silently answered with the old
  -- result.
  payload_fingerprint text NOT NULL,
  person_id           uuid REFERENCES public.persons(id) ON DELETE SET NULL,
  -- Compatibility only: the source row today's readers still key on. It may go NULL under the same
  -- lifecycle events; `person_id` is the answer that matters.
  guest_player_id     uuid REFERENCES public.guest_players(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- An operator create must name its operator. Only the public form may have none.
  CONSTRAINT chk_player_create_commands_actor
    CHECK (origin = 'self_signup' OR actor_user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_player_create_commands_person
  ON public.player_create_commands (person_id);
CREATE INDEX IF NOT EXISTS idx_player_create_commands_owner
  ON public.player_create_commands (owner_type, owner_id, created_at);

-- Default-deny: RLS on with NO policies, and the named roles revoked as well — this project's
-- ALTER DEFAULT PRIVILEGES grants new objects to anon/authenticated, so revoking PUBLIC alone
-- leaves them reachable. Only the command function, which is SECURITY DEFINER, touches this.
ALTER TABLE public.player_create_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.player_create_commands FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.player_create_commands IS
  'One row per Player-create command, keyed on the caller''s creation_request_id. The durable idempotency record: it survives the claim, merge, anonymization or deletion of the guest source, and is repointed when the person it names is merged away. Owner-scope ids are FK-free so the evidence outlives its academy or trainer, exactly like academy_deletion_audit. Owner-only — reachable solely through player_create_command.';

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

-- Covers the IDENTITY payload only. First/last name, rating, birth date and source are descriptive
-- attributes of one create: correcting a typo in them on a retry must not turn the retry into a
-- conflict, because none of them can change WHICH Player the command answers with.
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
-- Is this Player already this scope's to speak for?
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- For `_select_person_id`. Knowing a person's UUID is not permission to attach it to your academy or
-- your trainer practice — UUIDs travel. The scope must already have a relationship with that Player:
-- a membership, or a guest of its own that links to them. An ownerless create has no scope and
-- therefore no relationships, so it can select nobody.
CREATE OR REPLACE FUNCTION public.player_owner_may_select_person(
  _owner_type text, _owner_id uuid, _person_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE _owner_type
    WHEN 'academy' THEN
      EXISTS (SELECT 1 FROM public.academy_player_memberships m
               WHERE m.academy_profile_id = _owner_id AND m.person_id = _person_id)
      OR EXISTS (SELECT 1 FROM public.person_links pl
                   JOIN public.guest_players g ON g.id = pl.guest_player_id
                  WHERE pl.person_id = _person_id AND g.academy_profile_id = _owner_id)
    WHEN 'trainer' THEN
      EXISTS (SELECT 1 FROM public.person_links pl
                JOIN public.guest_players g ON g.id = pl.guest_player_id
               WHERE pl.person_id = _person_id AND g.trainer_id = _owner_id)
    ELSE false     -- an unknown scope owns nothing and may select nobody
  END;
$$;

-- Who may create a Player in a scope. Written once here so the edge functions and the command
-- cannot answer it differently; the edge gate asks the same questions before spending a round trip,
-- and this is the authority.
CREATE OR REPLACE FUNCTION public.player_owner_may_create(
  _owner_type text, _owner_id uuid, _user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN _user_id IS NULL THEN false
    WHEN _owner_type = 'academy' THEN
      public.is_academy_manager(_user_id, _owner_id) OR public.is_academy_owner(_user_id, _owner_id)
    WHEN _owner_type = 'trainer' THEN
      EXISTS (SELECT 1 FROM public.trainer_profiles tp
               WHERE tp.id = _owner_id AND tp.user_id = _user_id)
      -- or the caller runs an academy this trainer works for: the academy back-office creates
      -- players against its trainers, and refusing that would make the trainer scope unreachable
      -- for the role that actually uses it.
      OR EXISTS (SELECT 1 FROM public.academy_trainers at
                  WHERE at.trainer_profile_id = _owner_id
                    AND (public.is_academy_manager(_user_id, at.academy_profile_id)
                         OR public.is_academy_owner(_user_id, at.academy_profile_id)))
    ELSE false
  END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The command
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.academy_create_player(uuid, text, text, text, uuid);
DROP FUNCTION IF EXISTS public.academy_create_player(uuid, uuid, text, text, text, uuid, uuid);
DROP FUNCTION IF EXISTS public.academy_may_select_person(uuid, uuid);

CREATE OR REPLACE FUNCTION public.player_create_command(
  _creation_request_id uuid,
  _owner_type          text,
  _owner_id            uuid    DEFAULT NULL,
  _full_name           text    DEFAULT NULL,
  _email               text    DEFAULT NULL,
  _phone               text    DEFAULT NULL,
  _first_name          text    DEFAULT NULL,
  _last_name           text    DEFAULT NULL,
  _skill_rating        numeric DEFAULT NULL,
  _rating_system       text    DEFAULT NULL,
  _birth_date          date    DEFAULT NULL,
  _notes               text    DEFAULT NULL,
  _source              text    DEFAULT NULL,
  -- "this is an existing Player", by canonical id. Authorized, never assumed from possession.
  _select_person_id    uuid    DEFAULT NULL,
  -- Service-role callers (the edge functions) name the acting user; a signed-in caller cannot.
  _actor_user_id       uuid    DEFAULT NULL,
  _origin              text    DEFAULT 'operator'
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
  IF _creation_request_id IS NULL THEN
    RAISE EXCEPTION 'PLAYER_CREATE_REQUEST_ID_REQUIRED: a create command must say which attempt it is'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Every Player belongs to an academy or a trainer. That is not this command's rule — it is the
  -- `guest_players_owner_check` constraint the table has carried since 2026-02, and a create with no
  -- scope has always ended in an opaque check violation several statements later. It is refused
  -- here, legibly, before anything is written.
  IF _owner_type IS NULL OR _owner_type NOT IN ('academy', 'trainer') THEN
    RAISE EXCEPTION 'PLAYER_CREATE_BAD_SCOPE: a Player belongs to an academy or a trainer'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF _owner_id IS NULL THEN
    RAISE EXCEPTION 'PLAYER_CREATE_BAD_SCOPE: the % scope needs an owner id', _owner_type
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF _origin IS NULL OR _origin NOT IN ('operator', 'self_signup') THEN
    RAISE EXCEPTION 'PLAYER_CREATE_BAD_ORIGIN: origin must be operator or self_signup'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF _origin = 'self_signup' THEN
    -- The public registration form reaches this through its own service-key edge function, which is
    -- where the form-is-open check, the CORS allow-list and the rate limits live. A signed-in client
    -- may not declare itself a self-signup: that would be a create with no operator and no gate.
    IF NOT v_is_service THEN
      RAISE EXCEPTION 'PLAYER_CREATE_FORBIDDEN: only the public registration endpoint may create a self-signup Player'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- A registrant identifies themselves by signing in, and a signed-in registrant is an existing
    -- Player who travels by their own id — they never reach a CREATE at all. So there is no
    -- selection arm here, and no way to name one.
    IF _select_person_id IS NOT NULL THEN
      RAISE EXCEPTION 'PLAYER_CREATE_FORBIDDEN: a self-signup cannot select an existing Player'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- ...and for the same reason there is nobody to record as the actor. Accepting one would put an
    -- unverified user id into the durable evidence, which is worse than recording none.
    IF _actor_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'PLAYER_CREATE_BAD_ORIGIN: a self-signup has no operator to name'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_uid := NULL;   -- the public form has no signed-in operator
  ELSE
    v_uid := CASE WHEN v_is_service THEN coalesce(_actor_user_id, auth.uid()) ELSE auth.uid() END;
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'PLAYER_CREATE_NOT_AUTHENTICATED' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT public.player_owner_may_create(_owner_type, _owner_id, v_uid) THEN
      RAISE EXCEPTION 'PLAYER_CREATE_FORBIDDEN: you do not control that academy or trainer'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF v_name IS NULL AND _select_person_id IS NULL THEN
    RAISE EXCEPTION 'PLAYER_CREATE_NAME_REQUIRED: a new Player needs a name'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Serialize on the REQUEST, not on the address. Two concurrent submissions of one attempt must
  -- produce one Player; two different attempts are free to run at the same time.
  PERFORM pg_advisory_xact_lock(hashtext('player_create:' || _creation_request_id::text));

  v_fp := public.player_create_fingerprint(_full_name, _email, _phone, _select_person_id);

  SELECT * INTO v_cmd FROM public.player_create_commands
   WHERE creation_request_id = _creation_request_id FOR UPDATE;

  IF FOUND THEN
    -- Same attempt. It must be the SAME attempt in every material respect, or the caller has reused
    -- an id and is owed an error rather than somebody else's answer. IS DISTINCT FROM throughout:
    -- an anonymous self-signup has a NULL actor and an ownerless create has a NULL owner, and `<>`
    -- would answer NULL — never true — for both.
    IF v_cmd.owner_type <> _owner_type
       OR v_cmd.owner_id IS DISTINCT FROM _owner_id
       OR v_cmd.origin <> _origin
       OR v_cmd.actor_user_id IS DISTINCT FROM v_uid
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
    IF NOT public.player_owner_may_select_person(_owner_type, _owner_id, _select_person_id) THEN
      -- knowing the uuid is not the same as being allowed to use it
      RAISE EXCEPTION 'PLAYER_CREATE_PERSON_NOT_YOURS: that Player is not one this scope can select'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_person := _select_person_id;
    SELECT pl.guest_player_id INTO v_guest
      FROM public.person_links pl
      JOIN public.guest_players g ON g.id = pl.guest_player_id
     WHERE pl.person_id = v_person
       AND ((_owner_type = 'academy' AND g.academy_profile_id = _owner_id)
            OR (_owner_type = 'trainer' AND g.trainer_id = _owner_id))
     ORDER BY g.created_at
     LIMIT 1;
  ELSE
    -- Serialize the PROPOSAL, not the identity. Two operators submitting the same human under two
    -- different request ids must both get their own Player — that is the whole point of keying on
    -- the request — but they must not both look, both see nothing, and both file nothing. This lock
    -- makes the second one see the first one's row. Taken AFTER the request lock and released with
    -- the transaction, so the acquisition order is the same everywhere and cannot deadlock.
    PERFORM pg_advisory_xact_lock(hashtext(
      'player_identity:' || _owner_type || ':' || coalesce(_owner_id::text, '-')
      || ':' || coalesce(v_name, '') || ':' || coalesce(v_email, '')));

    INSERT INTO public.guest_players (
      full_name, first_name, last_name, email, phone, skill_rating, rating_system, birth_date,
      notes, academy_profile_id, trainer_id, source
    ) VALUES (
      btrim(_full_name), nullif(btrim(_first_name), ''), nullif(btrim(_last_name), ''),
      v_email, nullif(btrim(_phone), ''), _skill_rating,
      coalesce(nullif(btrim(_rating_system), ''), 'knltb'), _birth_date,
      nullif(btrim(_notes), ''),
      CASE WHEN _owner_type = 'academy' THEN _owner_id END,
      CASE WHEN _owner_type = 'trainer' THEN _owner_id END,   -- exactly one, per the table's CHECK
      coalesce(nullif(btrim(_source), ''), 'player_create_command')
    )
    RETURNING id INTO v_guest;

    SELECT person_id INTO v_person FROM public.person_links WHERE guest_player_id = v_guest;
    IF v_person IS NULL THEN
      RAISE EXCEPTION 'PLAYER_CREATE_NO_PERSON: the new Player was not given a canonical identity'
        USING ERRCODE = 'raise_exception';
    END IF;

    -- PII may PROPOSE. A different create attempt that looks like this one is a candidate for a
    -- human to judge, not a reason to hand back somebody else's Player. The name must agree; the
    -- addresses must not DISAGREE — a Player entered once without an address and once with one is
    -- the commonest real duplicate there is, and requiring an email match would miss exactly it.
    SELECT g.id INTO v_dupe
      FROM public.guest_players g
     WHERE g.id <> v_guest
       AND ((_owner_type = 'academy' AND g.academy_profile_id = _owner_id)
            OR (_owner_type = 'trainer' AND g.trainer_id = _owner_id))
       AND public.u2_norm(g.full_name) = v_name
       AND (v_email IS NULL OR public.u2_norm(g.email) IS NULL OR public.u2_norm(g.email) = v_email)
     ORDER BY g.created_at
     LIMIT 1;

    IF v_dupe IS NOT NULL THEN
      INSERT INTO public.person_merge_review (kind, status, email, guest_player_id, person_id, details)
      VALUES ('possible_duplicate_player', 'pending', v_email, v_guest, v_person,
              jsonb_build_object('via', 'player_create_command',
                                 'looks_like_guest_player_id', v_dupe,
                                 'note', 'proposed only — matching attributes do not decide identity'));
    END IF;
  END IF;

  INSERT INTO public.player_create_commands
    (creation_request_id, owner_type, owner_id, origin, actor_user_id,
     payload_fingerprint, person_id, guest_player_id)
  VALUES (_creation_request_id, _owner_type, _owner_id, _origin, v_uid, v_fp, v_person, v_guest);

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
-- The collapse repoints every column that names the dying person and then deletes it. Without a line
-- for the command record the FK would null the command's answer during a perfectly ordinary claim,
-- and the next retry would refuse with RESULT_GONE for a Player that is alive and well under a
-- different id.
--
-- The repoint sits with the other repoints, AFTER the two arms that decline to collapse. It used to
-- run first, as the very first statement: a refused collapse then left the command pointing at a
-- target it was never merged into, while the person it actually made carried on living. The record
-- must move only when the thing it records actually moved.
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

  -- U2: the durable create-command record names this person. Its guest column needs no repoint —
  -- the collapse relinks the guest ROW rather than deleting it, so `guest_player_id` stays valid.
  UPDATE public.player_create_commands
     SET person_id = _target_person
   WHERE person_id = _guest_person;

  -- Memberships are keyed by PERSON, not by the guest row, so they are not covered by any of the
  -- updates above — and their FK is RESTRICT, so without this the DELETE below fails and the whole
  -- collapse aborts once the table is populated.
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
REVOKE ALL ON FUNCTION public.player_owner_may_select_person(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.player_owner_may_create(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.player_create_command(uuid, text, uuid, text, text, text, text, text, numeric, text, date, text, text, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.player_create_command(uuid, text, uuid, text, text, text, text, text, numeric, text, date, text, text, uuid, uuid, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.player_create_command(uuid, text, uuid, text, text, text, text, text, numeric, text, date, text, text, uuid, uuid, text) IS
  'The one Player-create command. Idempotent on the caller''s creation_request_id — never on a name, address or phone number, which may only PROPOSE a duplicate for review. An existing Player is named by person_id and must already belong to the scope; possession of a uuid authorizes nothing. Scope is the academy or trainer the Player belongs to (U2, owner 2026-08-09).';

COMMENT ON FUNCTION public.player_owner_may_select_person(text, uuid, uuid) IS
  'Whether a scope may name an existing person_id in a create command: it must already have a membership or a guest of its own linked to that person. UUIDs travel; permission does not.';

COMMENT ON FUNCTION public.player_owner_may_create(text, uuid, uuid) IS
  'Whether a user may create a Player in a scope. The single authority — the edge gates ask the same questions to fail fast, but this decides.';

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
