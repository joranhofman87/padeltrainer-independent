-- U2 — trusted identity continuity for anonymous returning Players (owner-approved 2026-08-10).
--
-- Full design + threat model: docs/U2_IDENTITY_CONTINUITY_DESIGN.md. This migration is the
-- server heart: the challenge that proves control of a contact address, the candidate disclosure
-- that only happens AFTER that proof, and the explicit person-keyed selection that binds a result
-- to one create attempt. It reuses the reviewed manage-capability PATTERN (a signed capability
-- whose secret lives only in edge env; this table stores the row + key_version + expiry, never the
-- HMAC) — the signing/verification core is the sibling module _shared/identity-verify-token.ts.
--
-- THE RULE. A first-time anonymous contact creates a NEW Player. PII may only SUGGEST candidates.
-- When candidates exist, control of the address is proven through a short-lived signed capability;
-- only then may the person explicitly pick an existing Player or "someone new". Login or a
-- completed selection identify the exact Player with no fresh challenge. Nothing auto-merges. A
-- shared family address supports multiple candidates — verification proves control of the address,
-- never which member is acting, so explicit selection stays mandatory. "One email = one Player" is
-- encoded nowhere.

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Signing-key state — mirrors notification_manage_key_state exactly (monotonic floor, one row)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE public.identity_verify_key_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  current_version int NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  min_mintable_version int NOT NULL DEFAULT 1 CHECK (min_mintable_version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_verify_key_state_coherent CHECK (current_version >= min_mintable_version)
);
INSERT INTO public.identity_verify_key_state (id) VALUES (true);

COMMENT ON TABLE public.identity_verify_key_state IS
  'Single-row signing-key state for identity-verification capability tokens. Raising min_mintable_version retires a burned key: no capability mints below it and the edge verifier refuses tokens below it. Existing rows are never re-signed. Mirrors notification_manage_key_state.';

ALTER TABLE public.identity_verify_key_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.identity_verify_key_state FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.identity_verify_key_state TO service_role;

CREATE OR REPLACE FUNCTION public.identity_verify_key_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'identity_verify_key_state is a single permanent row — it may be raised, never removed';
  END IF;
  IF NEW.min_mintable_version < OLD.min_mintable_version THEN
    RAISE EXCEPTION 'min_mintable_version is monotonic: % may not be lowered to %', OLD.min_mintable_version, NEW.min_mintable_version;
  END IF;
  IF NEW.current_version < OLD.current_version THEN
    RAISE EXCEPTION 'current_version is monotonic: % may not be lowered to %', OLD.current_version, NEW.current_version;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_identity_verify_key_state_guard
  BEFORE UPDATE OR DELETE ON public.identity_verify_key_state
  FOR EACH ROW EXECUTE FUNCTION public.identity_verify_key_state_guard();

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The challenge
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- One row per (workflow, owner, creation_request_id) collision. It binds every dimension a stolen
-- or replayed token must not be able to cross, and it carries the candidate-set fingerprint taken
-- at mint so a set that drifts before the choice fails closed.
CREATE TABLE public.identity_verification_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  workflow text NOT NULL
    CHECK (workflow IN ('slot', 'cart', 'cyclus', 'intake', 'rebook')),
  owner_type text NOT NULL CHECK (owner_type IN ('academy', 'trainer')),
  owner_id uuid NOT NULL,

  -- the create attempt this challenge (and its eventual selection) is bound to
  creation_request_id uuid NOT NULL,

  -- the address whose control is being proven. Normalized + fingerprinted (binding, not secrecy):
  -- an old challenge must not act after the delivered destination changed.
  contact_normalized text NOT NULL
    CHECK (contact_normalized = lower(btrim(contact_normalized))
           AND position('@' IN contact_normalized) > 1),
  contact_fingerprint text NOT NULL,

  -- the candidate SET at mint time. If it differs when the person chooses, the challenge is void.
  candidate_set_fingerprint text NOT NULL,
  candidate_set_size int NOT NULL CHECK (candidate_set_size >= 1),

  -- the MATERIAL BOOKING INTENT at mint time — a hash of the exact target (slot/cart/cyclus/
  -- registration) plus the submitted name/phone (Codex r2 f2). A consumed selection is bound to
  -- THIS intent, so a caller who keeps the creation_request_id cannot reuse a verified person's
  -- selection for a different target or payload. Client-supplied, but the entrypoints build it from
  -- their own validated values, and it only ever RESTRICTS what a consumed selection may be reused
  -- for — it never grants anything.
  payload_fingerprint text NOT NULL DEFAULT '',

  key_version int NOT NULL CHECK (key_version >= 1),
  expires_at timestamptz NOT NULL,

  -- lifecycle: verified_at = address proven (re-listable, idempotent); consumed_at = a terminal
  -- selection was made (single-use). selected_person_id NULL with consumed_at set = "someone new".
  verified_at timestamptz,
  consumed_at timestamptz,
  -- ON DELETE CASCADE, not SET NULL (Codex r3 f6): the canonical-collapse lifecycle DELETEs a
  -- merged-away person. SET NULL would leave a consumed challenge answering proceed_person with a
  -- NULL person while its unique index blocked re-verification — a permanent dead end. CASCADE
  -- instead removes the stale consumed row, so a booking resumed after a mid-flow merge simply
  -- re-resolves against the surviving person (which still owns the guest, hence re-challenges).
  selected_person_id uuid REFERENCES public.persons(id) ON DELETE CASCADE,
  chose_someone_new boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- At most ONE active (unconsumed) challenge per create attempt: this is the FAIL-CLOSED cap on
-- verification-email abuse (the rate_limits helper fails open, so the structural cap lives here).
CREATE UNIQUE INDEX uniq_identity_challenge_active_per_request
  ON public.identity_verification_challenges (creation_request_id)
  WHERE consumed_at IS NULL;

-- A create attempt resolves to at most one terminal selection.
CREATE UNIQUE INDEX uniq_identity_challenge_consumed_per_request
  ON public.identity_verification_challenges (creation_request_id)
  WHERE consumed_at IS NOT NULL;

CREATE INDEX idx_identity_challenge_expiry
  ON public.identity_verification_challenges (expires_at) WHERE consumed_at IS NULL;

COMMENT ON TABLE public.identity_verification_challenges IS
  'One row per anonymous returning-Player verification. Binds workflow, owner, creation_request_id, normalized contact and the candidate-set fingerprint; the token an email carries is v<N>.<id>.<HMAC over the edge-held key> — this table never stores the HMAC or the key. verified_at = address proven (idempotent re-list); consumed_at = single-use terminal selection. Definer RPCs are the only writers; no client DML.';

ALTER TABLE public.identity_verification_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.identity_verification_challenges FROM PUBLIC, anon, authenticated, service_role;

-- Immutable apart from the lifecycle columns — the HMAC covers only the id + key generation, so an
-- UPDATE to workflow/owner/contact/candidate-set would silently retarget an already-signed link.
CREATE OR REPLACE FUNCTION public.identity_challenge_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workflow IS DISTINCT FROM OLD.workflow
     OR NEW.owner_type IS DISTINCT FROM OLD.owner_type
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.creation_request_id IS DISTINCT FROM OLD.creation_request_id
     OR NEW.contact_normalized IS DISTINCT FROM OLD.contact_normalized
     OR NEW.contact_fingerprint IS DISTINCT FROM OLD.contact_fingerprint
     OR NEW.candidate_set_fingerprint IS DISTINCT FROM OLD.candidate_set_fingerprint
     OR NEW.candidate_set_size IS DISTINCT FROM OLD.candidate_set_size
     OR NEW.payload_fingerprint IS DISTINCT FROM OLD.payload_fingerprint
     OR NEW.key_version IS DISTINCT FROM OLD.key_version
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'identity_verification_challenges rows are immutable apart from verified_at/consumed_at/selected_person_id/chose_someone_new';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_identity_challenge_guard_immutable
  BEFORE UPDATE ON public.identity_verification_challenges
  FOR EACH ROW EXECUTE FUNCTION public.identity_challenge_guard_immutable();

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The candidate set — definer-internal, granted to NOBODY
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- Candidates are the "returning anonymous booker" population precisely: canonical persons with an
-- IN-SCOPE GUEST source whose address equals the challenged one (the matching guest itself must be
-- in the owner's scope — see the query). An account (profile link) does NOT exclude a person; a
-- returning player who later claimed an account is still reconnected rather than duplicated.
-- Split-frozen guests are excluded. Ordered + fingerprinted so drift between mint and choice shows.
CREATE OR REPLACE FUNCTION public.identity_candidate_persons(
  _owner_type text, _owner_id uuid, _email_norm text
)
RETURNS TABLE (person_id uuid, display_name text, phone_hint text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  -- DISTINCT ON (person_id): EXACTLY one row per canonical person (Codex r3 f5). A person with two
  -- in-scope matching guests (different phones) must not appear twice — that would duplicate the
  -- person in the set, double-count the fingerprint and collide React keys. The oldest guest wins
  -- the hint deterministically.
  SELECT DISTINCT ON (pl.person_id)
         pl.person_id,
         coalesce(nullif(btrim(pr.full_name), ''), 'Player'),
         -- a privacy-minimal disambiguator for same-name household members (Codex r2 f7): the last
         -- two digits of the phone, masked. Disclosed only post-verification (control of the shared
         -- address is already proven), and never the full number.
         CASE WHEN length(regexp_replace(coalesce(g.phone, ''), '\D', '', 'g')) >= 2
              THEN '••' || right(regexp_replace(g.phone, '\D', '', 'g'), 2)
              ELSE NULL END
    FROM public.person_links pl
    JOIN public.persons pr ON pr.id = pl.person_id
    JOIN public.guest_players g ON g.id = pl.guest_player_id
    WHERE _email_norm <> ''
      -- the EMAIL-MATCHING guest row must ITSELF be in the requested owner's scope (Codex r1 f3):
      -- relying on player_owner_may_select_person alone let a person qualify whose matching guest
      -- belonged to another owner while a DIFFERENT in-scope relationship passed the predicate. This
      -- ties the candidate to an in-scope guest whose address equals the challenged one, which also
      -- makes that guest the one person_legacy_source derives for this owner.
      AND lower(btrim(g.email)) = _email_norm
      AND NOT public.is_guest_split_frozen(g.id)
      AND ((_owner_type = 'academy'
            AND (g.academy_profile_id = _owner_id
                 OR EXISTS (SELECT 1 FROM public.academy_trainers at
                             WHERE at.academy_profile_id = _owner_id
                               AND at.trainer_profile_id = g.trainer_id
                               AND at.status = 'active')))
           OR (_owner_type = 'trainer' AND g.trainer_id = _owner_id))
      -- defense in depth + consistency with the rest of U2; implied by the in-scope guest above
      AND public.player_owner_may_select_person(_owner_type, _owner_id, pl.person_id)
      -- NOTE: an account (profile link) no longer excludes a person (Codex r1 f6). Eligibility is
      -- "has an exact in-scope guest source at this address", so a returning player who later
      -- claimed an account is still reconnected rather than duplicated; the entrypoints book them
      -- via legacyBookingRef's guest key (person_id is stamped, so it stays visible to them).
    -- DISTINCT ON tiebreak: oldest in-scope guest, then g.id so a shared created_at (common in one
    -- INSERT) still picks the SAME hint deterministically across executions (Codex r4).
    ORDER BY pl.person_id, g.created_at, g.id;
$$;

REVOKE ALL ON FUNCTION public.identity_candidate_persons(text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.identity_candidate_persons(text, uuid, text) IS
  'Definer-internal candidate set for identity verification: canonical persons whose in-scope guest source (the matching guest itself in the owner scope) has the challenged address. Granted to nobody. An account does not exclude a person — the entrypoints book a chosen returning player via legacyBookingRef''s guest key, with person_id stamped so it stays visible to them.';

-- A stable fingerprint of the candidate SET, so drift between begin and select fails closed.
CREATE OR REPLACE FUNCTION public.identity_candidate_fingerprint(
  _owner_type text, _owner_id uuid, _email_norm text
)
RETURNS TABLE (fp text, n int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT coalesce(md5(string_agg(c.person_id::text, ',' ORDER BY c.person_id)), ''),
         count(*)::int
    FROM public.identity_candidate_persons(_owner_type, _owner_id, _email_norm) c;
$$;

REVOKE ALL ON FUNCTION public.identity_candidate_fingerprint(text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Enqueue the (inert) verification message — definer-internal, no candidate identity to the edge
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- Enqueues ONE generic message for a challenge, idempotent on the challenge id. Key properties:
--   * The recipient is the DETERMINISTIC lowest-person_id candidate — so the destination the
--     outbox resolves IS the matched on-file address. We NEVER email an arbitrary typed address:
--     a message is only ever enqueued when a candidate already exists at that address, which is the
--     structural anti-abuse guarantee (this cannot be used to spam addresses not already on file).
--   * The payload carries the challenge_id and workflow only — NEVER the HMAC token. The token is
--     derived from (challenge_id, key) at the owner-gated SEND, exactly as the manage-link worker
--     derives its token; the database never stores an HMAC.
--   * Real delivery is INERT here (no active worker) and is the owner's activation gate. TWO
--     delivery concerns are recorded for that gate in docs/U2_IDENTITY_CONTINUITY_DESIGN.md and are
--     NOT solved by this inert enqueue (Codex r1 f3): (1) the challenge proves control of THE
--     CHALLENGED ADDRESS (`contact_normalized`), but enqueue_notification resolves the recipient
--     PERSON's own notification-contact, which for a claimed candidate can be a different address —
--     so the activation sender MUST target `contact_normalized`, not the person's resolved contact;
--     (2) a consent-opted-out contact would suppress a required challenge. Both are delivery-layer
--     redesign for activation; begin-time correctness (the halt, the candidate set, the selection)
--     does not depend on them, and this slice only enqueues inertly.
CREATE OR REPLACE FUNCTION public.identity_challenge_enqueue(_challenge_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ch public.identity_verification_challenges%ROWTYPE;
  v_recipient uuid;
  v_recent int;
  -- Per-address hourly cap on verification emails. The per-creation_request_id uniqueness is NOT an
  -- abuse cap (a caller rotates request ids for unlimited challenges — Codex r1 f5), so the real,
  -- fail-CLOSED cap is here: at most this many messages to one on-file address in one owner per
  -- hour. Skipping the enqueue leaves the resolver's response unchanged (still verify_required), so
  -- capping the email does not add an enumeration signal.
  v_hourly_email_cap constant int := 5;
BEGIN
  SELECT * INTO v_ch FROM public.identity_verification_challenges WHERE id = _challenge_id;
  IF NOT FOUND OR v_ch.consumed_at IS NOT NULL OR v_ch.expires_at <= now() THEN
    RETURN;  -- nothing to notify about
  END IF;

  -- Serialize the count+enqueue per (contact, owner): without the lock, concurrent transactions do
  -- not see each other's uncommitted challenge rows, so many could each count below the cap and all
  -- enqueue (Codex r2 f3). The xact lock holds to commit, making the cap fail-closed under a burst.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('identity_email_cap:' || v_ch.owner_type || ':' || v_ch.owner_id::text
                     || ':' || v_ch.contact_normalized, 0));

  -- Count DELIVERED messages (outbox rows), not challenge rows: a challenge whose enqueue was
  -- capped must not itself count toward the cap, or one burst would wedge the address forever. Keyed
  -- to the SAME (owner, address) the lock serializes (Codex r3 f3) — an owner-less count would let
  -- unrelated tenants suppress each other while their distinct locks fail to serialize the counter.
  SELECT count(*) INTO v_recent
    FROM public.notification_outbox o
   WHERE o.event_type = 'identity_verification_requested'
     AND o.destination_normalized = v_ch.contact_normalized
     AND ((v_ch.owner_type = 'academy' AND o.tenant_academy_profile_id = v_ch.owner_id)
          OR (v_ch.owner_type = 'trainer' AND o.tenant_trainer_id = v_ch.owner_id))
     AND o.created_at > now() - interval '1 hour';
  IF v_recent >= v_hourly_email_cap THEN
    RETURN;  -- address hit its hourly cap: cap the EMAIL, not the (uniform) response
  END IF;

  SELECT c.person_id INTO v_recipient
    FROM public.identity_candidate_persons(v_ch.owner_type, v_ch.owner_id, v_ch.contact_normalized) c
   ORDER BY c.person_id
   LIMIT 1;
  IF v_recipient IS NULL THEN
    RETURN;  -- the set emptied out between mint and here; nothing to send, select will fail closed
  END IF;

  PERFORM public.enqueue_notification(
    p_event_key                 => 'identity_verification_requested',
    p_recipient_person_id        => v_recipient,
    p_tenant_academy_profile_id  => CASE WHEN v_ch.owner_type = 'academy' THEN v_ch.owner_id END,
    p_tenant_trainer_id          => CASE WHEN v_ch.owner_type = 'trainer' THEN v_ch.owner_id END,
    p_idempotency_subject        => 'identity_verify:' || v_ch.id::text,
    -- challenge_id + workflow ONLY. No token (derived at the gated send), no candidate names.
    p_payload                    => jsonb_build_object('challenge_id', v_ch.id, 'workflow', v_ch.workflow),
    -- the event happened NOW (the person just submitted): dating it with the mint time is correct,
    -- and passing it explicitly honours the producer contract (no reliance on the enqueue default).
    p_occurred_at                => now());
END;
$$;

REVOKE ALL ON FUNCTION public.identity_challenge_enqueue(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The resolver — the ONE function every anonymous entrypoint calls before any side effect
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- Returns exactly one of:
--   proceed_new     — no candidate collision: create a fresh Player through the UUID command.
--   proceed_person  — trusted evidence names an exact person: use it.
--   verify_required — candidates exist and no trust yet: a challenge is minted (idempotent per
--                     creation_request_id); the edge builds the token and enqueues ONE message.
--
-- NOTHING about candidate identity, names, counts or existence is returned on the verify_required
-- path — the response is identical whether one candidate matched or several.
CREATE OR REPLACE FUNCTION public.identity_resolve_or_challenge(
  _creation_request_id uuid,
  _owner_type text,
  _owner_id uuid,
  _workflow text,
  _email text,
  _authed_person_id uuid DEFAULT NULL,
  _ttl_minutes int DEFAULT 30,
  _payload_key text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_email_norm text := lower(btrim(coalesce(_email, '')));
  -- the material-intent fingerprint: a consumed selection is reusable only for the SAME target +
  -- payload (Codex r2 f2). md5 is binding, not secrecy.
  v_payload_fp text := md5(coalesce(_payload_key, ''));
  v_existing public.identity_verification_challenges%ROWTYPE;
  v_fp text;
  v_n int;
  v_key_version int;
  v_state_min int;
  v_ch public.identity_verification_challenges%ROWTYPE;
BEGIN
  IF _creation_request_id IS NULL THEN
    RAISE EXCEPTION 'IDENTITY_REQUEST_ID_REQUIRED' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF _owner_type NOT IN ('academy', 'trainer') THEN
    RAISE EXCEPTION 'IDENTITY_BAD_OWNER_SCOPE' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF _workflow NOT IN ('slot', 'cart', 'cyclus', 'intake', 'rebook') THEN
    RAISE EXCEPTION 'IDENTITY_BAD_WORKFLOW' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- (2) A completed selection bound to THIS attempt is trusted evidence — replay returns the same
  --     terminal result, so a resumed booking is idempotent. Checked before PII so a chosen
  --     "someone new" is honoured rather than re-challenged.
  SELECT * INTO v_existing
    FROM public.identity_verification_challenges
   WHERE creation_request_id = _creation_request_id AND consumed_at IS NOT NULL
   LIMIT 1;
  IF FOUND THEN
    -- The terminal selection must belong to the SAME workflow, owner AND contact address that was
    -- verified. Without the contact check (Codex r1 f2) a caller who kept the creation_request_id
    -- could resume with a DIFFERENT address and still book as the verified person — the selection
    -- was authorized for the address whose control was proven, not for whatever is resubmitted. A
    -- legitimate corrected address yields a different creation_request_id (the client keys the id on
    -- the address), so a mismatch here is never a normal flow: fail closed.
    IF v_existing.workflow <> _workflow
       OR v_existing.owner_type <> _owner_type OR v_existing.owner_id <> _owner_id
       OR v_existing.contact_normalized IS DISTINCT FROM v_email_norm
       -- ...AND the same material booking intent: a verified selection may not be reused for a
       -- different target/payload under a kept creation_request_id (Codex r2 f2).
       OR v_existing.payload_fingerprint IS DISTINCT FROM v_payload_fp THEN
      RAISE EXCEPTION 'IDENTITY_SELECTION_SCOPE_MISMATCH' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_existing.chose_someone_new THEN
      RETURN jsonb_build_object('status', 'proceed_new');
    END IF;
    RETURN jsonb_build_object('status', 'proceed_person', 'person_id', v_existing.selected_person_id);
  END IF;

  -- (1) An authenticated caller whose person the owner may act on: no challenge needed.
  IF _authed_person_id IS NOT NULL
     AND public.player_owner_may_select_person(_owner_type, _owner_id, _authed_person_id) THEN
    RETURN jsonb_build_object('status', 'proceed_person', 'person_id', _authed_person_id);
  END IF;

  -- (3) PII match. A missing address cannot collide with a stored one — a contactless booker is a
  --     first-timer by construction (and the public flows require an address for delivery anyway).
  IF v_email_norm = '' OR position('@' IN v_email_norm) < 2 THEN
    RETURN jsonb_build_object('status', 'proceed_new');
  END IF;

  SELECT fp, n INTO v_fp, v_n
    FROM public.identity_candidate_fingerprint(_owner_type, _owner_id, v_email_norm);

  IF coalesce(v_n, 0) = 0 THEN
    RETURN jsonb_build_object('status', 'proceed_new');
  END IF;

  -- Candidates exist. Return the ACTIVE challenge for this attempt if one is live AND its bound
  -- candidate set has not drifted; a drifted active challenge is superseded here rather than left to
  -- rot until expiry (Codex r1 f10) — otherwise the attempt is stuck for 30 minutes.
  SELECT * INTO v_existing
    FROM public.identity_verification_challenges
   WHERE creation_request_id = _creation_request_id
     AND consumed_at IS NULL AND expires_at > now()
   LIMIT 1;
  IF FOUND THEN
    -- Reuse only if the WHOLE tuple is unchanged — workflow, owner and contact as well as the
    -- candidate set and material intent (Codex r4: the payload does not carry owner scope, so a
    -- same-creation_request_id reused across owners with a coincidentally equal candidate set could
    -- otherwise re-enqueue the wrong owner's challenge). Any drift retires the stale one and re-mints
    -- (Codex r1 f10 / r2 f2).
    IF v_existing.workflow = _workflow
       AND v_existing.owner_type = _owner_type AND v_existing.owner_id = _owner_id
       AND v_existing.contact_normalized = v_email_norm
       AND v_existing.candidate_set_fingerprint = v_fp
       AND v_existing.payload_fingerprint = v_payload_fp THEN
      -- Re-enqueue is safe: enqueue_notification is idempotent on (event, subject, recipient), so a
      -- resubmitted attempt produces no second message — "at most one" holds structurally.
      PERFORM public.identity_challenge_enqueue(v_existing.id);
      RETURN jsonb_build_object(
        'status', 'verify_required',
        'challenge_id', v_existing.id,
        'key_version', v_existing.key_version,
        'expires_at', v_existing.expires_at);
    END IF;
    DELETE FROM public.identity_verification_challenges WHERE id = v_existing.id;
  END IF;

  -- Mint. key_version = current generation; refuse if the floor has retired it (fail closed).
  SELECT current_version, min_mintable_version INTO v_key_version, v_state_min
    FROM public.identity_verify_key_state WHERE id = true;
  IF v_key_version IS NULL OR v_key_version < v_state_min THEN
    RAISE EXCEPTION 'IDENTITY_KEY_STATE_UNAVAILABLE' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- Clear any EXPIRED unconsumed challenge for this attempt so the partial unique index admits the
  -- new one (an expired challenge is dead; a fresh collision deserves a fresh proof).
  DELETE FROM public.identity_verification_challenges
   WHERE creation_request_id = _creation_request_id AND consumed_at IS NULL AND expires_at <= now();

  -- Two concurrent FIRST submissions of one attempt can both reach here and race the partial
  -- unique index; the loser catches the violation and returns the winner's live challenge, so both
  -- get the same idempotent verify_required rather than a 500 (Codex r2 f9).
  BEGIN
    INSERT INTO public.identity_verification_challenges (
      workflow, owner_type, owner_id, creation_request_id,
      contact_normalized, contact_fingerprint,
      candidate_set_fingerprint, candidate_set_size, payload_fingerprint,
      key_version, expires_at
    ) VALUES (
      _workflow, _owner_type, _owner_id, _creation_request_id,
      v_email_norm, md5(v_email_norm),
      v_fp, v_n, v_payload_fp,
      v_key_version, now() + make_interval(mins => greatest(1, _ttl_minutes))
    )
    RETURNING * INTO v_ch;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_ch FROM public.identity_verification_challenges
     WHERE creation_request_id = _creation_request_id AND consumed_at IS NULL AND expires_at > now()
     LIMIT 1;
    IF NOT FOUND THEN RAISE; END IF;
    -- The winner must be THIS request's challenge, not merely one sharing the creation_request_id
    -- (Codex r3 f7): two concurrent submissions that differ in workflow/owner/contact/candidate set/
    -- payload must fail closed here rather than silently adopt the other's challenge and become
    -- permanently scope-mismatched at resume.
    IF v_ch.workflow <> _workflow OR v_ch.owner_type <> _owner_type OR v_ch.owner_id <> _owner_id
       OR v_ch.contact_normalized IS DISTINCT FROM v_email_norm
       OR v_ch.candidate_set_fingerprint IS DISTINCT FROM v_fp
       OR v_ch.payload_fingerprint IS DISTINCT FROM v_payload_fp THEN
      RAISE EXCEPTION 'IDENTITY_CONCURRENT_ATTEMPT_MISMATCH' USING ERRCODE = 'serialization_failure';
    END IF;
  END;

  PERFORM public.identity_challenge_enqueue(v_ch.id);

  RETURN jsonb_build_object(
    'status', 'verify_required',
    'challenge_id', v_ch.id,
    'key_version', v_ch.key_version,
    'expires_at', v_ch.expires_at);
END;
$$;

REVOKE ALL ON FUNCTION public.identity_resolve_or_challenge(uuid, text, uuid, text, text, uuid, int, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.identity_resolve_or_challenge(uuid, text, uuid, text, text, uuid, int, text)
  TO service_role;

COMMENT ON FUNCTION public.identity_resolve_or_challenge(uuid, text, uuid, text, text, uuid, int, text) IS
  'The one resolver every anonymous entrypoint calls before any side effect. Returns proceed_new / proceed_person / verify_required. verify_required leaks no candidate identity, name, count or existence — identical for one match or many. Service-role only (the guest edge functions).';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- After the emailed token is verified by the edge: disclose the minimal candidate set
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- The edge validates the HMAC token (identity-verify-token.ts) BEFORE calling this — so reaching
-- here IS the proof of address control. Marks verified_at (idempotent) and returns the minimal
-- owner-scoped candidate labels needed to distinguish household members, PLUS the always-present
-- "someone new" option (implicit — the client always offers it). Drift fails closed: if the set
-- changed since mint, the challenge is void and a fresh verification is required.
CREATE OR REPLACE FUNCTION public.identity_verification_list(_challenge_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ch public.identity_verification_challenges%ROWTYPE;
  v_fp text;
  v_n int;
  v_candidates jsonb;
BEGIN
  SELECT * INTO v_ch FROM public.identity_verification_challenges
   WHERE id = _challenge_id FOR UPDATE;
  -- Uniform generic outcome: never distinguish "no such challenge" from "expired"/"consumed".
  IF NOT FOUND OR v_ch.consumed_at IS NOT NULL OR v_ch.expires_at <= now() THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  -- Drift check: the candidate set must be identical to the one bound at mint.
  SELECT fp, n INTO v_fp, v_n
    FROM public.identity_candidate_fingerprint(v_ch.owner_type, v_ch.owner_id, v_ch.contact_normalized);
  IF v_fp IS DISTINCT FROM v_ch.candidate_set_fingerprint THEN
    RETURN jsonb_build_object('status', 'stale');   -- caller must re-verify
  END IF;

  IF v_ch.verified_at IS NULL THEN
    UPDATE public.identity_verification_challenges SET verified_at = now() WHERE id = _challenge_id;
  END IF;

  -- "Support multiple candidates WITHOUT guessing" (owner rule): if two candidates would render
  -- identically — same display name AND same phone hint (two same-named household members sharing a
  -- phone, or two with no phone) — the choice would be a blind positional guess that could attribute
  -- the booking to the wrong Player. Fail CLOSED rather than offer it (Codex r4): the caller shows a
  -- "we can't safely tell these apart — continue as someone new or contact the academy" message.
  -- The common shared-family case (distinct names or distinct phones) is unaffected.
  IF EXISTS (
    SELECT 1 FROM public.identity_candidate_persons(v_ch.owner_type, v_ch.owner_id, v_ch.contact_normalized) c
    GROUP BY c.display_name, coalesce(c.phone_hint, '')
    HAVING count(*) > 1
  ) THEN
    RETURN jsonb_build_object('status', 'ambiguous');
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
             'person_id', c.person_id, 'name', c.display_name, 'phone_hint', c.phone_hint)
                   ORDER BY c.display_name, c.person_id)
    INTO v_candidates
    FROM public.identity_candidate_persons(v_ch.owner_type, v_ch.owner_id, v_ch.contact_normalized) c;

  RETURN jsonb_build_object('status', 'ok', 'candidates', coalesce(v_candidates, '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.identity_verification_list(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.identity_verification_list(uuid) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The explicit choice — single-use, drift-checked, person-keyed
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- Selects ONE authorized candidate by canonical person_id, or "someone new". Requires a verified,
-- unconsumed, unexpired challenge whose candidate set has not drifted. Single-use: the terminal
-- state is written once; a replay of the SAME choice returns the same result, a DIFFERENT choice
-- after consumption is refused. Carries only canonical identity onward.
CREATE OR REPLACE FUNCTION public.identity_verification_select(
  _challenge_id uuid, _person_id uuid, _choose_someone_new boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ch public.identity_verification_challenges%ROWTYPE;
  v_fp text;
  v_n int;
BEGIN
  SELECT * INTO v_ch FROM public.identity_verification_challenges
   WHERE id = _challenge_id FOR UPDATE;
  IF NOT FOUND OR v_ch.expires_at <= now() THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  -- Idempotent replay of a completed selection: same answer, no second mutation.
  IF v_ch.consumed_at IS NOT NULL THEN
    IF v_ch.chose_someone_new AND _choose_someone_new THEN
      RETURN jsonb_build_object('status', 'ok', 'someone_new', true);
    END IF;
    IF NOT v_ch.chose_someone_new AND NOT _choose_someone_new
       AND v_ch.selected_person_id = _person_id THEN
      RETURN jsonb_build_object('status', 'ok', 'person_id', v_ch.selected_person_id);
    END IF;
    -- a different choice after the terminal one is a conflict, never a silent re-selection
    RETURN jsonb_build_object('status', 'already_selected');
  END IF;

  -- Address control must be proven first.
  IF v_ch.verified_at IS NULL THEN
    RETURN jsonb_build_object('status', 'not_verified');
  END IF;

  -- Drift fails closed.
  SELECT fp, n INTO v_fp, v_n
    FROM public.identity_candidate_fingerprint(v_ch.owner_type, v_ch.owner_id, v_ch.contact_normalized);
  IF v_fp IS DISTINCT FROM v_ch.candidate_set_fingerprint THEN
    RETURN jsonb_build_object('status', 'stale');
  END IF;

  IF _choose_someone_new THEN
    UPDATE public.identity_verification_challenges
       SET consumed_at = now(), chose_someone_new = true
     WHERE id = _challenge_id;
    RETURN jsonb_build_object('status', 'ok', 'someone_new', true);
  END IF;

  -- Re-enforce the ambiguity fail-closed HERE, not only in the list (Codex r5): the UI hides the
  -- blind-guess pair, but a valid-token caller could POST a known candidate uuid directly to select.
  -- If the set is ambiguous (two candidates sharing display name + phone hint), refuse a named
  -- selection WITHOUT consuming — only "someone new" is safe. Candidate-uuid secrecy is not an
  -- authorization control.
  IF EXISTS (
    SELECT 1 FROM public.identity_candidate_persons(v_ch.owner_type, v_ch.owner_id, v_ch.contact_normalized) c
    GROUP BY c.display_name, coalesce(c.phone_hint, '')
    HAVING count(*) > 1
  ) THEN
    RETURN jsonb_build_object('status', 'ambiguous');
  END IF;

  -- A named candidate must be IN the current set (which player_owner_may_select_person underpins),
  -- so a token cannot select a person outside its owner scope or outside what was disclosed.
  IF _person_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.identity_candidate_persons(
                      v_ch.owner_type, v_ch.owner_id, v_ch.contact_normalized) c
                    WHERE c.person_id = _person_id) THEN
    RETURN jsonb_build_object('status', 'not_a_candidate');
  END IF;

  UPDATE public.identity_verification_challenges
     SET consumed_at = now(), selected_person_id = _person_id
   WHERE id = _challenge_id;
  RETURN jsonb_build_object('status', 'ok', 'person_id', _person_id);
END;
$$;

REVOKE ALL ON FUNCTION public.identity_verification_select(uuid, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.identity_verification_select(uuid, uuid, boolean) TO service_role;

-- The edge verifier needs ONE fact to bind the signed token generation to the stored row — the
-- challenge's key_version — and must learn nothing else. The challenge table is granted to nobody
-- (it carries the contact address), and BYPASSRLS does not bypass a table ACL, so a direct SELECT
-- by the service role would fail (Codex r1 f1). This definer RPC returns the key_version alone.
CREATE OR REPLACE FUNCTION public.identity_challenge_key_version(_challenge_id uuid)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT key_version FROM public.identity_verification_challenges WHERE id = _challenge_id;
$$;

REVOKE ALL ON FUNCTION public.identity_challenge_key_version(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.identity_challenge_key_version(uuid) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Public-intake idempotency on the create attempt (Codex r1 f9)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- Now that a resumed submission resolves to a STABLE person (the consumed challenge replays
-- proceed_person indefinitely), the public intake insert must be idempotent on the same attempt or a
-- replay after the 60-second heuristic window would write a second intake_requests row (and mint a
-- second invoice from it). The caller's creation_request_id is the natural key; a partial unique
-- index makes the duplicate structurally impossible, and submit-guest-intake treats the conflict as
-- "already submitted". Nullable + partial so every pre-existing row and every non-public writer that
-- does not set it is unaffected.
ALTER TABLE public.intake_requests
  ADD COLUMN IF NOT EXISTS creation_request_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_intake_requests_creation_request
  ON public.intake_requests (registration_id, creation_request_id)
  WHERE creation_request_id IS NOT NULL;

COMMENT ON COLUMN public.intake_requests.creation_request_id IS
  'The public self-service submission attempt this row was created for (U2). Partial-unique with registration_id so a resumed/replayed submission cannot write a duplicate intake. NULL for every other writer.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The inert notification event — enqueue only; real delivery is the owner gate
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Registered so enqueue_notification can accept the verification message. No active channel/worker
-- is wired here: this matches the frozen-inactive notification posture. The token rides in the
-- service-role-only payload, never in public_summary.
INSERT INTO public.notification_event_types
  (key, category, audience, priority, required_delivery,
   supports_email, supports_whatsapp, supports_push, supports_digest,
   default_email_frequency, default_whatsapp_frequency, default_push_frequency,
   collapse_window_minutes, quiet_hours_respect, visibility_scope,
   template_email, digest_engine_enabled, email_footer_policy)
VALUES
  ('identity_verification_requested', 'security', 'guest', 'transactional', true,
   true, false, false, false,
   'instant', 'off', 'off',
   0, false, 'private_user_only',
   -- required_delivery ⇒ footer policy MUST be 'none' (notif_event_footer_policy_coherent): a
   -- security challenge is transactional, never marketing, and carries no unsubscribe footer.
   'identity_verification_requested', false, 'none')
ON CONFLICT (key) DO NOTHING;
