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
-- TWO INVARIANTS THAT KEEP BEING COLLAPSED INTO ONE (owner, 2026-08-09). Review has now twice read
-- "a Player may have no email" as "no flow may ask for one", so it is written down here, next to the
-- rule it is confused with:
--
--   1. THE PLAYER ENTITY — email is OPTIONAL. `guest_players.email` is nullable, the command takes
--      NULL, and every creation route accepts a Player without one. No attribute of a person may
--      select, merge, deduplicate or reuse an identity, ever, on any route.
--   2. A WORKFLOW THAT DELIVERS SOMETHING — email may be a REQUIRED INPUT. The public booking and
--      payment endpoints, the public self-service intake form, and the rebook-group add each need
--      somewhere to send a pay link or a confirmation, so they require an address as CONTACT
--      INFORMATION. (The rebook requirement is older than U2: 20260705110000, Slice C, owner
--      decision #4 — a new group member must be reachable.)
--
-- These are compatible, and the line between them is what the address is being used FOR. Requiring
-- contact details to complete a transaction says nothing about who somebody is. Using them to
-- decide which existing human this is, is the thing U2 removed. A future review finding "email is
-- required here" should check which of the two it has found before calling it a defect.
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
-- `person_id` DOES carry an FK, and deliberately: ON DELETE SET NULL there is a fact rather than a
-- loss. A NULL says "the Player this command produced no longer exists", and the command answers a
-- retry with PLAYER_CREATE_RESULT_GONE instead of quietly making a second one. Where a successor
-- person exists, the merge paths repoint the row before the delete.
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
  -- THE result. There is deliberately no legacy source column beside it: a receipt that also stored
  -- `guest_player_id` made a temporary compatibility reference part of the durable identity record,
  -- and every caller that read it inherited a dependency on a table this migration exists to
  -- retire. It also made replay fragile in a way `person_id` never is — the guest row is claimed,
  -- merged and deleted in ordinary use, while the person survives all three.
  person_id           uuid REFERENCES public.persons(id) ON DELETE SET NULL,
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
  'One row per Player-create command, keyed on the caller''s creation_request_id. Its answer is the canonical person_id and nothing else — no legacy source reference is stored, so the receipt cannot make a caller depend on guest_players. Survives the claim, merge, anonymization or deletion of the source row, and is repointed when the person it names is merged away. Owner-scope ids are FK-free so the evidence outlives its academy or trainer. Owner-only — reachable solely through player_create_command.';

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

-- Covers the IDENTITY payload, plus the FLOW the attempt was made in. First/last name, rating and
-- birth date are descriptive attributes of one create: correcting a typo in them on a retry must
-- not turn the retry into a conflict, because none of them can change WHICH Player the command
-- answers with.
--
-- `_source` is in here for a different reason. On the anonymous flows the request id is supplied by
-- the client, and a replay hands back the Player that id created — so the id should not be usable
-- outside the flow that minted it. Binding the source means an attempt made at the registration
-- form cannot be replayed at the booking checkout, and vice versa. It does not make the id a
-- secret, and it is not pretending to: replaying one still requires the whole identity payload to
-- match, which is the same knowledge the attribute lookup this replaced gave away for nothing.
CREATE OR REPLACE FUNCTION public.player_create_fingerprint(
  _full_name text, _email text, _phone text, _select_person_id uuid, _source text DEFAULT NULL,
  _twin_of_profile_id uuid DEFAULT NULL
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
    || public.u2_ns(_select_person_id::text)
    || public.u2_ns(public.u2_norm(_source))
    -- The twin assertion is MATERIAL: it is the claim that this Player is a particular account
    -- holder, and B1 acts on it. Left out, a retry of one request id under a DIFFERENT asserted
    -- profile would be answered with the first profile's Player instead of refused.
    || public.u2_ns(_twin_of_profile_id::text), 'sha256'), 'hex');
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
                  WHERE pl.person_id = _person_id
                    -- a SPLIT-FROZEN link is a disputed one: the guest may be a different human
                    -- than the linked person, so it is no relationship to that person at all
                    -- (Codex r2 f2 — mirrors the overview, which keys a frozen guest as its OWN
                    -- person; the frozen-self arm below is the other half of that mirror).
                    AND NOT public.is_guest_split_frozen(g.id)
                    AND (g.academy_profile_id = _owner_id
                         -- ...or a guest of one of the academy's ACTIVE trainers. This mirrors how
                         -- `get_players_overview` populates the picker the operator chose from, so
                         -- the two agree about who this academy's players are. A predicate that
                         -- disagreed with the picker would refuse people the UI had just offered.
                         OR EXISTS (SELECT 1 FROM public.academy_trainers at
                                     WHERE at.academy_profile_id = _owner_id
                                       AND at.trainer_profile_id = g.trainer_id
                                       AND at.status = 'active')))
      -- ...or the pick IS a split-frozen guest, keyed as its own person — exactly how the
      -- freeze-aware picker offers it.
      OR EXISTS (SELECT 1 FROM public.guest_players g
                  WHERE g.id = _person_id
                    AND public.is_guest_split_frozen(g.id)
                    AND (g.academy_profile_id = _owner_id
                         OR EXISTS (SELECT 1 FROM public.academy_trainers at
                                     WHERE at.academy_profile_id = _owner_id
                                       AND at.trainer_profile_id = g.trainer_id
                                       AND at.status = 'active')))
      -- ...or a registered player who has BOOKED with one of this academy's trainers. The overview
      -- admits them on exactly that basis (its `registered` arm: a confirmed or completed booking on
      -- an in-scope slot), and a predicate that refused someone the picker had just offered would
      -- fail the roster add with PERSON_NOT_YOURS on a player the operator can plainly see.
      OR EXISTS (SELECT 1 FROM public.bookings b
                   JOIN public.availability_slots s ON s.id = b.slot_id
                   JOIN public.academy_trainers at ON at.trainer_profile_id = s.trainer_id
                   JOIN public.person_links pl ON pl.profile_id = b.player_id
                  WHERE at.academy_profile_id = _owner_id AND at.status = 'active'
                    AND b.status IN ('confirmed', 'completed')
                    AND pl.person_id = _person_id)
    WHEN 'trainer' THEN
      EXISTS (SELECT 1 FROM public.person_links pl
                JOIN public.guest_players g ON g.id = pl.guest_player_id
               WHERE pl.person_id = _person_id
                 AND NOT public.is_guest_split_frozen(g.id)
                 AND g.trainer_id = _owner_id)
      OR EXISTS (SELECT 1 FROM public.guest_players g
                  WHERE g.id = _person_id
                    AND public.is_guest_split_frozen(g.id)
                    AND g.trainer_id = _owner_id)
      OR EXISTS (SELECT 1 FROM public.bookings b
                   JOIN public.availability_slots s ON s.id = b.slot_id
                   JOIN public.person_links pl ON pl.profile_id = b.player_id
                  WHERE s.trainer_id = _owner_id
                    AND b.status IN ('confirmed', 'completed')
                    AND pl.person_id = _person_id)
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
      -- or the caller runs an academy this trainer ACTIVELY works for: the academy back-office
      -- creates players against its trainers, and refusing that would make the trainer scope
      -- unreachable for the role that actually uses it. `status = 'active'` mirrors the INSERT
      -- policy this command replaced (20260224171306) — an invited or ended relationship is not
      -- authority over the trainer's practice (Codex r1 f1).
      OR EXISTS (SELECT 1 FROM public.academy_trainers at
                  WHERE at.trainer_profile_id = _owner_id
                    AND at.status = 'active'
                    AND (public.is_academy_manager(_user_id, at.academy_profile_id)
                         OR public.is_academy_owner(_user_id, at.academy_profile_id)))
    ELSE false
  END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The command, and the mechanism underneath it
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- WHY THESE ARE TWO FUNCTIONS. "Who may create a Player here" and "what creating one does" are
-- different questions with different answers per caller. A signed-in operator is authorized by the
-- scope they control. The public registration form is authorized by its own endpoint's gates. The
-- rebook-group flow is authorized by a capability token an anonymous member holds, which only that
-- flow can validate. Folding all three into one function means either one of them is refused, or
-- the check that admits it admits everybody.
--
-- So `player_create_execute` is the MECHANISM — idempotency, creation, the duplicate proposal, the
-- durable record — and it decides nothing about permission. EXECUTE on it is granted to NOBODY,
-- which is what makes that safe: it is reachable only from a SECURITY DEFINER function owned by the
-- same role, i.e. only from a function that has already answered the permission question. That is a
-- real boundary rather than a convention — an anon or authenticated caller cannot reach it at all.
DROP FUNCTION IF EXISTS public.academy_create_player(uuid, text, text, text, uuid);
DROP FUNCTION IF EXISTS public.academy_create_player(uuid, uuid, text, text, text, uuid, uuid);
DROP FUNCTION IF EXISTS public.academy_may_select_person(uuid, uuid);
-- Earlier shapes of this same unit, dropped by signature so a partially-applied environment cannot
-- end up with an OVERLOAD: PostgREST would then resolve a call by argument names, and two functions
-- that differ by one optional parameter are exactly the pair it can pick the wrong member of.
DROP FUNCTION IF EXISTS public.player_create_fingerprint(text, text, text, uuid);
DROP FUNCTION IF EXISTS public.player_create_fingerprint(text, text, text, uuid, text);
DROP FUNCTION IF EXISTS public.player_create_command(uuid, text, uuid, text, text, text, text, text, numeric, text, date, text, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.player_create_command(uuid, text, uuid, text, text, text, text, text, numeric, text, date, text, text, uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.player_create_execute(
  _creation_request_id  uuid,
  _owner_type           text,
  _owner_id             uuid,
  _origin               text,
  _actor_user_id        uuid,
  _full_name            text    DEFAULT NULL,
  _email                text    DEFAULT NULL,
  _phone                text    DEFAULT NULL,
  _first_name           text    DEFAULT NULL,
  _last_name            text    DEFAULT NULL,
  _skill_rating         numeric DEFAULT NULL,
  _rating_system        text    DEFAULT NULL,
  _birth_date           date    DEFAULT NULL,
  _notes                text    DEFAULT NULL,
  _source               text    DEFAULT NULL,
  -- Already authorized by the caller. This function does NOT re-check it.
  _select_person_id     uuid    DEFAULT NULL,
  _twin_of_profile_id   uuid    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_name text := public.u2_norm(_full_name);
  v_email text := public.u2_norm(_email);
  v_fp text;
  v_cmd public.player_create_commands%ROWTYPE;
  v_person uuid;
  v_guest uuid;
  v_dupe uuid;
BEGIN
  -- Serialize on the REQUEST, not on the address. Two concurrent submissions of one attempt must
  -- produce one Player; two different attempts are free to run at the same time.
  PERFORM pg_advisory_xact_lock(hashtext('player_create:' || _creation_request_id::text));

  v_fp := public.player_create_fingerprint(_full_name, _email, _phone, _select_person_id, _source, _twin_of_profile_id);

  SELECT * INTO v_cmd FROM public.player_create_commands
   WHERE creation_request_id = _creation_request_id FOR UPDATE;

  IF FOUND THEN
    -- Same attempt. It must be the SAME attempt in every material respect, or the caller has reused
    -- an id and is owed an error rather than somebody else's answer. IS DISTINCT FROM throughout:
    -- an anonymous self-signup has a NULL actor, and `<>` would answer NULL — never true — for it.
    IF v_cmd.owner_type <> _owner_type
       OR v_cmd.owner_id IS DISTINCT FROM _owner_id
       OR v_cmd.origin <> _origin
       OR v_cmd.actor_user_id IS DISTINCT FROM _actor_user_id
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
      'created', false,
      'replayed', true,
      'creation_request_id', _creation_request_id);
  END IF;

  -- ── a genuinely new attempt ──────────────────────────────────────────────────────────────────
  IF _select_person_id IS NOT NULL THEN
    -- Naming an existing Player answers with that Player. There is no legacy source to look up
    -- here any more: a caller that needs one derives it from the person through the adapter, which
    -- is the only place a guest id is allowed to exist.
    v_person := _select_person_id;
  ELSE
    -- Serialize the PROPOSAL, not the identity. Two operators submitting the same human under two
    -- different request ids must both get their own Player — that is the whole point of keying on
    -- the request — but they must not both look, both see nothing, and both file nothing. This lock
    -- makes the second one see the first one's row. Taken AFTER the request lock and released with
    -- the transaction, so the acquisition order is the same everywhere and cannot deadlock.
    PERFORM pg_advisory_xact_lock(hashtext(
      'player_identity:' || _owner_type || ':' || _owner_id::text
      || ':' || coalesce(v_name, '') || ':' || coalesce(v_email, '')));

    INSERT INTO public.guest_players (
      full_name, first_name, last_name, email, phone, skill_rating, rating_system, birth_date,
      notes, academy_profile_id, trainer_id, twin_of_profile_id, source
    ) VALUES (
      btrim(_full_name), nullif(btrim(_first_name), ''), nullif(btrim(_last_name), ''),
      v_email, nullif(btrim(_phone), ''), _skill_rating,
      coalesce(nullif(btrim(_rating_system), ''), 'knltb'), _birth_date,
      nullif(btrim(_notes), ''),
      CASE WHEN _owner_type = 'academy' THEN _owner_id END,
      CASE WHEN _owner_type = 'trainer' THEN _owner_id END,   -- exactly one, per the table's CHECK
      _twin_of_profile_id,
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
    (creation_request_id, owner_type, owner_id, origin, actor_user_id, payload_fingerprint, person_id)
  VALUES (_creation_request_id, _owner_type, _owner_id, _origin, _actor_user_id, v_fp, v_person);

  RETURN jsonb_build_object(
    'person_id', v_person,
    'created', _select_person_id IS NULL,
    'replayed', false,
    'creation_request_id', _creation_request_id);
END;
$$;

-- The entry point for callers who are authorized by a SCOPE they control: an operator through their
-- own session, or an edge function naming the operator it verified.
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
  _origin              text    DEFAULT 'operator',
  -- The explicit "this new Player IS that account holder" assertion (rule B1). Only ever on a
  -- CREATE: stamping a Player that already exists is how an attribute-matched row gets laundered
  -- into an authorized merge, which is exactly what U2 removed from the roster bridge.
  _twin_of_profile_id  uuid    DEFAULT NULL
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
      RAISE EXCEPTION 'PLAYER_CREATE_FORBIDDEN: only a public endpoint may create a self-signup Player'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- A registrant identifies themselves by signing in, and a signed-in registrant is an existing
    -- Player who travels by their own id — they never reach a CREATE at all. So there is no
    -- selection arm here, and no way to name one.
    IF _select_person_id IS NOT NULL THEN
      RAISE EXCEPTION 'PLAYER_CREATE_FORBIDDEN: a self-signup cannot select an existing Player'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- ...and for the same reason there is nobody to record as the actor, and nobody to assert a
    -- twin. Accepting either would put an unverified claim into the durable evidence.
    IF _actor_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'PLAYER_CREATE_BAD_ORIGIN: a self-signup has no operator to name'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF _twin_of_profile_id IS NOT NULL THEN
      RAISE EXCEPTION 'PLAYER_CREATE_FORBIDDEN: a self-signup cannot assert who somebody is'
        USING ERRCODE = 'insufficient_privilege';
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

  IF public.u2_norm(_full_name) IS NULL AND _select_person_id IS NULL THEN
    RAISE EXCEPTION 'PLAYER_CREATE_NAME_REQUIRED: a new Player needs a name'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF _select_person_id IS NOT NULL AND _twin_of_profile_id IS NOT NULL THEN
    RAISE EXCEPTION 'PLAYER_CREATE_BAD_SCOPE: a Player that already exists is not being created, so there is nothing to stamp'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The authorizations this function owes the mechanism. Both are about naming somebody who
  -- already exists, and both answer the same question: does this scope have a recorded
  -- relationship with that person, or is it merely in possession of their uuid?
  --
  -- A REPLAY is exempt from both, deliberately (Codex r1 f8). If a receipt already exists for this
  -- request id, the attempt was authorized when it ran; the mechanism will answer it ONLY when the
  -- full fingerprint (which binds _select_person_id and _twin_of_profile_id), owner, origin and
  -- actor all match, and refuse anything else as an idempotency conflict. Re-running the person
  -- check here instead would break the retry of a finished command whose selected person was since
  -- merged away — may_select answers false for a person that no longer exists, while the receipt
  -- has already been repointed to the survivor the caller is owed. The exemption can never
  -- authorize a NEW create: a receipt-less request falls through to the full checks.
  IF NOT EXISTS (SELECT 1 FROM public.player_create_commands c
                  WHERE c.creation_request_id = _creation_request_id) THEN
    IF _select_person_id IS NOT NULL
       AND NOT public.player_owner_may_select_person(_owner_type, _owner_id, _select_person_id) THEN
      -- knowing the uuid is not the same as being allowed to use it
      RAISE EXCEPTION 'PLAYER_CREATE_PERSON_NOT_YOURS: that Player is not one this scope can select'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- A twin stamp is not a label. `mint_person_for_guest` treats it as the explicit assertion that
    -- authorizes joining this new Player to that account holder's person (rule B1) — so an
    -- unauthorized stamp is a way to attach seats and invoices to somebody else's account by knowing
    -- their profile uuid. The account holder must be someone this scope already speaks for.
    IF _twin_of_profile_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.person_links pl
         WHERE pl.profile_id = _twin_of_profile_id
           AND public.player_owner_may_select_person(_owner_type, _owner_id, pl.person_id)
      ) THEN
        RAISE EXCEPTION 'PLAYER_CREATE_PERSON_NOT_YOURS: that account is not one this scope can speak for'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
  END IF;

  RETURN public.player_create_execute(
    _creation_request_id, _owner_type, _owner_id, _origin, v_uid,
    _full_name, _email, _phone, _first_name, _last_name, _skill_rating, _rating_system,
    _birth_date, _notes, _source, _select_person_id, _twin_of_profile_id);
END;
$$;



-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The legacy compatibility boundary
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- Bookings, invoices, intake requests and priority claims still physically carry `player_id` (a
-- profile) or `guest_player_id` (a guest row). Those columns are legacy and the person-unification
-- plan retires them; until it does, something has to turn a canonical `person_id` into whichever
-- of them a given table can actually store.
--
-- That translation lives HERE and nowhere else. A caller passes the person and the scope it is
-- authorized for; it never passes a legacy id, and it never receives one it did not have to have.
-- Nothing about this function decides identity: it reads `person_links`, which is the record of
-- which sources belong to which person, and returns what that record says.
--
-- PROFILE FIRST, deliberately. After a guest is claimed or merged into an account the person has
-- both kinds of source, and the registered-player path is the compatible one — it is what the
-- money-path dedup guard and the player-side readers key on. Falling back to the guest there would
-- write a row the account holder cannot see in their own app.
--
-- EXECUTE is granted to NOBODY. It is reachable only from a SECURITY DEFINER function owned by the
-- same role — i.e. only from a wrapper that has already answered "may this caller act in this
-- scope?". A client that could call it directly would be able to enumerate the legacy sources of
-- any person whose uuid it could guess.
CREATE OR REPLACE FUNCTION public.person_legacy_source(
  _person_id uuid, _owner_type text, _owner_id uuid
)
RETURNS TABLE (profile_id uuid, guest_player_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT
    (SELECT pl.profile_id FROM public.person_links pl
      WHERE pl.person_id = _person_id AND pl.profile_id IS NOT NULL
      LIMIT 1),
    -- the guest source must belong to the SAME person AND to the scope the caller is acting in;
    -- a guest of another academy is not a legacy source this caller may write. The academy arm
    -- includes guests owned by the academy's ACTIVE trainers — the same membership
    -- `player_owner_may_select_person` and the players overview use, so a person the picker
    -- offered and the predicate admitted cannot then derive to NOTHING and silently unlink the
    -- write (Codex r1 f6).
    --
    -- SPLIT-FROZEN links are excluded, and the frozen guest itself answers as its OWN person
    -- (Codex r2 f2): while a split review is pending the link may describe a different human, so
    -- deriving the disputed guest for the linked person would pair two possibly-different people
    -- in one row — the exact mispairing the freeze exists to prevent. The COALESCE arm mirrors the
    -- overview, which keys a frozen guest by its own id.
    COALESCE(
      (SELECT pl.guest_player_id
         FROM public.person_links pl
         JOIN public.guest_players g ON g.id = pl.guest_player_id
        WHERE pl.person_id = _person_id
          AND NOT public.is_guest_split_frozen(g.id)
          AND ((_owner_type = 'academy'
                AND (g.academy_profile_id = _owner_id
                     OR EXISTS (SELECT 1 FROM public.academy_trainers at
                                 WHERE at.academy_profile_id = _owner_id
                                   AND at.trainer_profile_id = g.trainer_id
                                   AND at.status = 'active')))
               OR (_owner_type = 'trainer' AND g.trainer_id = _owner_id))
        ORDER BY g.created_at
        LIMIT 1),
      (SELECT g.id
         FROM public.guest_players g
        WHERE g.id = _person_id
          AND public.is_guest_split_frozen(g.id)
          AND ((_owner_type = 'academy'
                AND (g.academy_profile_id = _owner_id
                     OR EXISTS (SELECT 1 FROM public.academy_trainers at
                                 WHERE at.academy_profile_id = _owner_id
                                   AND at.trainer_profile_id = g.trainer_id
                                   AND at.status = 'active')))
               OR (_owner_type = 'trainer' AND g.trainer_id = _owner_id))));
$$;

REVOKE ALL ON FUNCTION public.person_legacy_source(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.person_legacy_source(uuid, text, uuid) IS
  'Translates a canonical person_id into the legacy profile/guest columns an unmigrated table still requires, within one authorized scope. Profile first — after a claim or merge the registered-player path is the compatible one. Granted to nobody: reachable only from a wrapper that has already authorized the caller. Decides no identity; it reports what person_links records.';

-- The service-boundary wrapper, and DELIBERATELY nothing more (owner correction, 2026-08-09).
--
-- The first version of this granted EXECUTE to `authenticated` so browser callers could translate
-- the person they had just created into the legacy column they still had to write. That was wrong,
-- and the reason is worth keeping: an RPC that turns `person_id` back into `guest_player_id` for a
-- client does not REMOVE the identity leak, it RELOCATES it — every caller, log line and piece of
-- browser state downstream of the call still carries the legacy id. Clients now hand their
-- `person_id` to a task-specific command (invoice_create_for_person, intake_request_create_for_
-- person, ...) that authorizes, translates INTERNALLY and completes the write in one transaction.
--
-- What remains is the SERVICE boundary: an edge function holding the service key may derive a
-- legacy reference internally when it must call or write an unmigrated relation (`bookings`,
-- `intake_requests`), and the reference must die inside that function — never in its HTTP
-- response, its logs, or any client-visible state. Anything that is not the service role is
-- refused here IN ADDITION to holding no EXECUTE grant, so re-granting by accident does not
-- quietly reopen the door.
CREATE OR REPLACE FUNCTION public.player_legacy_ref(
  _person_id uuid, _owner_type text, _owner_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_profile uuid;
  v_guest uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'LEGACY_REF_SERVICE_ONLY: legacy references are derived server-side, inside task-specific commands'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT s.profile_id, s.guest_player_id INTO v_profile, v_guest
    FROM public.person_legacy_source(_person_id, _owner_type, _owner_id) s;

  RETURN jsonb_build_object('player_id', v_profile, 'guest_player_id', v_guest);
END;
$$;

REVOKE ALL ON FUNCTION public.player_legacy_ref(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.player_legacy_ref(uuid, text, uuid) TO service_role;

COMMENT ON FUNCTION public.player_legacy_ref(uuid, text, uuid) IS
  'Service-role-only wrapper over person_legacy_source, for edge functions that must write an unmigrated relation: the derived legacy reference exists only inside that function and never reaches a client. Ordinary authenticated callers are refused twice over — no EXECUTE grant, and an explicit in-function check — because a client-callable person→legacy translator would merely relocate the identity leak it exists to close. Browser flows use the task-specific person-keyed commands instead.';

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

  -- U2: the durable create-command record names this person, and only the person — there is no
  -- legacy source column on it to keep in step.
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
REVOKE ALL ON FUNCTION public.player_create_fingerprint(text, text, text, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
-- The mechanism is reachable ONLY from a SECURITY DEFINER function owned by this role. Granting it
-- to nobody is what lets it skip the permission question: there is no caller that has not answered
-- it. `service_role` is revoked too — the edge functions go through `player_create_command`.
REVOKE ALL ON FUNCTION public.player_create_execute(uuid, text, uuid, text, uuid, text, text, text, text, text, numeric, text, date, text, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.player_owner_may_select_person(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.player_owner_may_create(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.player_create_command(uuid, text, uuid, text, text, text, text, text, numeric, text, date, text, text, uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.player_create_command(uuid, text, uuid, text, text, text, text, text, numeric, text, date, text, text, uuid, uuid, text, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.player_create_command(uuid, text, uuid, text, text, text, text, text, numeric, text, date, text, text, uuid, uuid, text, uuid) IS
  'The scope-authorized entry point to Player creation. Idempotent on the caller''s creation_request_id — never on a name, address or phone number, which may only PROPOSE a duplicate for review. An existing Player is named by person_id and must already belong to the scope; possession of a uuid authorizes nothing. Scope is the academy or trainer the Player belongs to (U2, owner 2026-08-09).';

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
