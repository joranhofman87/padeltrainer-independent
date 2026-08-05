-- N2 S1 — MANAGEMENT CAPABILITIES: the signed, scoped "manage this email's preferences" grant.
--
-- THE TOKEN MODEL, and why it is split across two layers. A footer link must work for recipients
-- who cannot log in (guests, hand-typed campaign addresses) without exposing enumeration, replay
-- against a rotated address, cross-recipient action, or PII in the URL. The design:
--
--     token = v<N> '.' <capability_id> '.' base64url( HMAC-SHA256("notif-manage:v1:v<N>:<id>", key vN) )
--
-- (The version rides in the token so the edge can check the retirement floor and the signature
-- BEFORE looking the capability up; the frozen format lives in _shared/manage-token.ts.)
--
-- This table stores ONLY the capability row — never the HMAC, never the secret. The signing key
-- lives exclusively in edge-function env (NOTIF_MANAGE_TOKEN_KEY_V<n>), so a database read cannot
-- reconstruct a live link (the improvement over the claim_token precedent, which stores its
-- secret raw), while the edge layer re-derives the same token for the same capability — which is
-- what lets a retry rebuild a byte-identical email under the same provider idempotency key.
--
-- ============================================================================
-- TWO SIMPLIFICATIONS, EACH FORCED BY REVIEW, AND THE SECOND IS THE IMPORTANT ONE.
--
-- (1) ONE CAPABILITY PER SEND. An earlier model reused a capability across every send of the
-- same "logical grant"; three rounds found three faces of one defect (a consumed grant made the
-- NEXT email's link inert; rotation changed a retry's bytes under a stable idempotency key; a
-- per-grant version floor let a stale worker mint a retired key). A capability that outlives the
-- message it was printed in has a lifecycle of its own, and every rule then needs a second
-- answer to "which send is this?". So the identity IS the send:
--
--     UNIQUE (source_kind, source_id)     -- `kind` is an immutable CLAIM, not part of identity
--
-- Determinism comes from that index: a retry finds its row (every claim re-verified — a
-- same-source mint with different claims RAISES rather than re-pointing a printed link), a new
-- send gets a new row.
--
-- (2) A CAPABILITY IS A MARKETING UNSUBSCRIBE, AND NOTHING ELSE. Two further rounds kept finding
-- defects in a second kind, `account_event_optout`, which let a signed link switch off ONE
-- optional SERVICE event for ONE account: it needed an ownership graph (user ↔ contact ↔ person
-- ↔ guest), a consumption epoch (an older unused link could undo a later authenticated choice),
-- fallback-authority checks, and revocation cascades on every identity change. All of that
-- machinery existed to give a signed link the power to CONTRADICT a choice — and every defect
-- was a way that power leaked. It is GONE.
--
-- What remains authorizes exactly one MONOTONIC act: "stop marketing to this address in this
-- scope". That removes whole problem classes rather than instances — no ownership graph (an
-- unsubscribe is about the ADDRESS receiving the mail, which is also why a hand-typed campaign
-- recipient with no account works the same as a registered one), no consumption epochs (a
-- replayed or forwarded link merely re-asserts a fact), no authority-change cascades.
--
-- WHO GETS A TOKEN: every recipient of MARKETING mail — registered players on a campaign list,
-- onboarding-drip recipients who all have accounts, guests, and hand-typed addresses alike.
-- Address-scoped suppression and RFC 8058 are about the address, not about whether its owner
-- could have logged in. Optional SERVICE mail is the other case: its footer links to the
-- authenticated settings page, because the action there IS per-account preference, which is
-- precisely the thing a forwardable link must not be able to do.
--
-- ROTATION is database-owned state, not a mint-time revocation sweep
-- (notification_manage_key_state). Mint refuses below `min_mintable_version`; existing rows are
-- NEVER re-signed or revoked by a rotation, because rewriting an already-printed link's version
-- is exactly how a retry's body changes underneath a fixed provider idempotency key. A burned
-- key instead fails CLOSED at the edge: the verifier refuses a token whose stored version is
-- below the minimum, and the link (or the retry) terminal-fails honestly.
--
-- ONE KIND, `marketing_unsubscribe`, and one token per send serving BOTH surfaces: the footer
-- URL (which opens the manage page) and the RFC 8058 one-click POST header. An earlier draft had
-- a second `manage_context` kind for the page, which contradicted one-capability-per-send — the
-- unique index would refuse the second mint — while `apply` treated the two identically anyway.
--
-- A guest "stop optional SERVICE mail" lever is deliberately NOT built here: the only mechanism
-- that exists today (notification_contacts.consent_status) also silences REQUIRED mail, because
-- the resolver excludes an opted-out contact even for required_delivery events. A per-event,
-- contact-scoped guest preference model is future work — see docs/NOTIFICATION_FOLLOWUPS.md
-- §N2, which also records that S2 must render an optional-service footer per RECIPIENT (a
-- settings link for account holders; an explanatory line, never a dead link, for guests).
--
-- BINDING IS THE ADDRESS, captured at mint and immutable on the row. There is no ownership graph
-- to keep in step and nothing to revoke on an identity change: the grant says "this address may
-- stop marketing in this scope", the address cannot change under it, and the action it authorizes
-- is one nobody can be harmed by replaying.
--
-- A capability never carries the raw address into a URL, and its context RPC returns a REDACTED
-- destination for LIVE rows only — non-live rows disclose status alone.

-- ---------------------------------------------------------------------------
-- Signing-key state: ONE row, owner-managed, read by mint and by the edge verifier.
CREATE TABLE public.notification_manage_key_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  current_version int NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  min_mintable_version int NOT NULL DEFAULT 1 CHECK (min_mintable_version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notif_manage_key_state_coherent CHECK (current_version >= min_mintable_version)
);
INSERT INTO public.notification_manage_key_state (id) VALUES (true);

COMMENT ON TABLE public.notification_manage_key_state IS
  'Single-row signing-key state for manage-link tokens. Raising min_mintable_version BEFORE rolling the workers is how a burned key is retired: no new capability may be minted below it, and the edge verifier refuses tokens whose stored key_version is below it. Existing rows are never re-signed — a retry under a burned key fails closed rather than silently changing an already-printed link.';

-- service_role is REVOKED explicitly: this project's ALTER DEFAULT PRIVILEGES grants it ALL on
-- new tables, so a bare "REVOKE FROM PUBLIC, anon, authenticated" would leave every edge function
-- holding the service key able to LOWER the retirement floor or DELETE the state row — i.e. to
-- un-retire a burned key. Read-only, and only through this grant.
ALTER TABLE public.notification_manage_key_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_manage_key_state FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.notification_manage_key_state TO service_role;

-- ...and the floor is MONOTONIC even for the owner: retirement is a one-way decision, and the row
-- may never be removed (a missing row is treated as unavailable by every reader below, but
-- deleting it should not be reachable in the first place).
CREATE OR REPLACE FUNCTION public.notif_manage_key_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'notification_manage_key_state is a single permanent row — it may be raised, never removed';
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

CREATE TRIGGER trg_notif_manage_key_state_guard
  BEFORE UPDATE OR DELETE ON public.notification_manage_key_state
  FOR EACH ROW
  EXECUTE FUNCTION public.notif_manage_key_state_guard();

-- ---------------------------------------------------------------------------
CREATE TABLE public.notification_manage_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind = 'marketing_unsubscribe'),

  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'academy', 'trainer')),
  scope_id uuid,
  CONSTRAINT notif_manage_cap_scope_coherent
    CHECK ((scope_kind = 'platform') = (scope_id IS NULL)),

  -- The address is ALWAYS captured: campaign recipients can have neither a login nor a contacts
  -- row, and every action must be re-checkable against the address it was minted for.
  address_normalized text NOT NULL
    CHECK (address_normalized = lower(btrim(address_normalized))
           AND position('@' IN address_normalized) > 1),
  -- Binding, not secrecy: an old capability must not act after the delivered destination
  -- changed. md5 is sufficient for equality binding and is built in.
  destination_fingerprint text NOT NULL,

  -- NO user/contact/event columns and NO foreign keys to identity tables. A capability is an
  -- address-scoped marketing grant; an FK here would also let deleting an authority row CASCADE
  -- away the capability, destroying the per-send identity a retry depends on.
  --
  -- THE IDENTITY: one capability per send.
  source_kind text NOT NULL
    CHECK (source_kind IN ('outbox', 'digest_group', 'campaign_recipient', 'onboarding_queue', 'legacy_send')),
  source_id uuid NOT NULL,

  key_version int NOT NULL CHECK (key_version >= 1),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- kind is NOT part of the identity: one message mints ONE capability, so a retry whose
  -- classification changed cannot quietly produce a second token for the same provider send.
  CONSTRAINT uniq_notif_manage_cap_per_send UNIQUE (source_kind, source_id)
);

CREATE INDEX idx_notif_manage_cap_expiry
  ON public.notification_manage_capabilities (expires_at) WHERE revoked_at IS NULL;

COMMENT ON TABLE public.notification_manage_capabilities IS
  'One row per SEND, granting exactly one monotonic act: stop marketing to this address in this scope. The token an email carries is v<N>.<id>.<HMAC over "notif-manage:v1:v<N>:<id>", edge-held key vN> — this table never stores the HMAC or the key, so reading it cannot forge a live link. Claims are IMMUTABLE (no client DML; definer RPCs are the only writers; the guard trigger refuses updates outside revoked_at/last_used_at). Per-send identity is what makes a retry rebuild the same bytes.';

-- No direct DML for ANY client role — the definer RPCs are the only path. (The HMAC signs only
-- the id, so an UPDATE to a row's claims would silently retarget an already-signed link.)
ALTER TABLE public.notification_manage_capabilities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_manage_capabilities FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.notif_manage_cap_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
     OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
     OR NEW.address_normalized IS DISTINCT FROM OLD.address_normalized
     OR NEW.destination_fingerprint IS DISTINCT FROM OLD.destination_fingerprint
     OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.key_version IS DISTINCT FROM OLD.key_version
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'notification_manage_capabilities rows are immutable apart from revoked_at/last_used_at — mint a new capability instead';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notif_manage_cap_guard_immutable
  BEFORE UPDATE ON public.notification_manage_capabilities
  FOR EACH ROW
  EXECUTE FUNCTION public.notif_manage_cap_guard_immutable();

-- ---------------------------------------------------------------------------
-- MINT (service-role only via EXECUTE; called by the footer-attach layers at send time).
--
-- Idempotent on the identity (source_kind, source_id) WHEN ALL CLAIMS MATCH — a retry of the same
-- send returns the SAME row, so the edge layer derives the same token bytes and the rebuilt email
-- is byte-identical under the same provider idempotency key. Every claim is RE-VERIFIED on that
-- path: a second mint for the same send with different kind, scope or address is a source-id
-- collision, and it RAISES rather than handing back a link that no longer describes the mail it
-- is printed in.
CREATE OR REPLACE FUNCTION public.mint_notification_manage_capability(
  p_kind text,
  p_scope_kind text,
  p_scope_id uuid,
  p_address text,
  p_source_kind text,
  p_source_id uuid,
  p_ttl interval
) RETURNS TABLE (capability_id uuid, key_version int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_address text := lower(btrim(p_address));
  v_version int;
  v_row public.notification_manage_capabilities%ROWTYPE;
BEGIN
  -- EVERY input is validated BEFORE anything is looked up or written.
  IF v_address IS NULL OR position('@' IN v_address) <= 1 THEN
    RAISE EXCEPTION 'mint_notification_manage_capability: not an email address';
  END IF;
  IF p_kind IS DISTINCT FROM 'marketing_unsubscribe' THEN
    RAISE EXCEPTION 'mint_notification_manage_capability: unknown kind %', p_kind;
  END IF;
  IF p_scope_kind IS NULL OR p_scope_kind NOT IN ('platform', 'academy', 'trainer')
     OR ((p_scope_kind = 'platform') <> (p_scope_id IS NULL)) THEN
    RAISE EXCEPTION 'mint_notification_manage_capability: scope_kind % and scope_id disagree', p_scope_kind;
  END IF;
  IF p_source_kind IS NULL OR p_source_kind NOT IN
     ('outbox', 'digest_group', 'campaign_recipient', 'onboarding_queue', 'legacy_send') THEN
    RAISE EXCEPTION 'mint_notification_manage_capability: unknown source_kind %', p_source_kind;
  END IF;
  IF p_source_id IS NULL THEN
    RAISE EXCEPTION 'mint_notification_manage_capability: a capability belongs to ONE send — source_id is required';
  END IF;
  -- TTL bounds: a zero/negative TTL mints dead links; an unbounded one is a forever credential.
  -- A capability is a marketing unsubscribe, and an unsubscribe link must outlive mailbox
  -- archaeology (>= 13 months per deliverability guidance) without becoming perpetual.
  IF p_ttl IS NULL OR p_ttl < interval '395 days' OR p_ttl > interval '800 days' THEN
    RAISE EXCEPTION 'mint_notification_manage_capability: ttl out of bounds (marketing management links stay valid 13-26 months)';
  END IF;

  SELECT current_version INTO v_version FROM public.notification_manage_key_state WHERE id;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'mint_notification_manage_capability: signing-key state is missing';
  END IF;

  -- INSERT FIRST, then read back. A plain SELECT-then-INSERT loses the race for one of two
  -- simultaneous retries of the same send: the unique index would stop the duplicate row, but the
  -- loser would get a 23505 instead of the capability it is entitled to — and "a retry returns
  -- the same row" is the contract this whole model rests on. ON CONFLICT DO NOTHING makes both
  -- callers fall through to the same read.
  INSERT INTO public.notification_manage_capabilities
    (kind, scope_kind, scope_id, address_normalized, destination_fingerprint,
     source_kind, source_id, key_version, expires_at)
  VALUES
    (p_kind, p_scope_kind, p_scope_id, v_address, md5(v_address),
     p_source_kind, p_source_id, v_version, now() + p_ttl)
  ON CONFLICT (source_kind, source_id) DO NOTHING;

  SELECT * INTO v_row FROM public.notification_manage_capabilities c
   WHERE c.source_kind = p_source_kind AND c.source_id = p_source_id;
  IF NOT FOUND THEN
    -- Only reachable if the row vanished between the insert and this read (a concurrent purge).
    RAISE EXCEPTION 'mint_notification_manage_capability: the capability for % % disappeared mid-mint', p_source_kind, p_source_id;
  END IF;

  -- The row may pre-date this call (a retry). Identity is (source_kind, source_id) alone, so the
  -- remaining claims — kind, scope and address — are verified rather than assumed: it is this
  -- send's capability only if it still describes THIS mail. Otherwise the source id is being
  -- reused for a different message, and handing back a link printed for another recipient would
  -- be far worse than refusing.
  IF v_row.kind IS DISTINCT FROM p_kind
     OR v_row.scope_kind IS DISTINCT FROM p_scope_kind
     OR v_row.scope_id IS DISTINCT FROM p_scope_id
     OR v_row.address_normalized IS DISTINCT FROM v_address THEN
    RAISE EXCEPTION 'mint_notification_manage_capability: % % already has a capability with different claims — a source id must identify ONE send', p_source_kind, p_source_id;
  END IF;

  RETURN QUERY SELECT v_row.id, v_row.key_version;
END;
$$;

REVOKE ALL ON FUNCTION public.mint_notification_manage_capability(text, text, uuid, text, text, uuid, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mint_notification_manage_capability(text, text, uuid, text, text, uuid, interval) TO service_role;

-- ---------------------------------------------------------------------------
-- CONTEXT (service-role only — the edge function verifies the HMAC FIRST, then reads this).
-- PII-TRIMMED per the claim-token doctrine: the link is forwardable, so the page it opens must
-- show nothing a stranger could use — a redacted destination, the scope's display name, and what
-- the capability may do. Never the raw address, never ids — and a NON-LIVE capability discloses
-- its status and NOTHING else: an expired, revoked or retired-key link is a dead end, not a
-- directory entry.
CREATE OR REPLACE FUNCTION public.get_notification_manage_context(p_capability_id uuid)
RETURNS TABLE (
  status text,               -- live | expired | revoked | retired_key | missing
  kind text,
  scope_kind text,
  scope_display_name text,
  destination_redacted text,
  key_version int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v public.notification_manage_capabilities%ROWTYPE;
  v_min int;
  v_status text;
  v_name text;
BEGIN
  SELECT * INTO v FROM public.notification_manage_capabilities c WHERE c.id = p_capability_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'missing'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::int;
    RETURN;
  END IF;

  -- A MISSING key state is unavailable, never "version 1": treating absence as the lowest floor
  -- would reactivate every retired capability the moment the authoritative row was lost.
  SELECT min_mintable_version INTO v_min FROM public.notification_manage_key_state WHERE id;
  v_status := CASE
    WHEN v.revoked_at IS NOT NULL THEN 'revoked'
    WHEN v.expires_at <= now() THEN 'expired'
    -- A burned signing key retires every link it signed. Reported (and refused) here as well as
    -- at the edge, so the database is not merely trusting the verifier to have been redeployed.
    WHEN v_min IS NULL OR v.key_version < v_min THEN 'retired_key'
    ELSE 'live'
  END;
  IF v_status <> 'live' THEN
    RETURN QUERY SELECT v_status, NULL::text, NULL::text, NULL::text, NULL::text, NULL::int;
    RETURN;
  END IF;

  IF v.scope_kind = 'academy' THEN
    SELECT a.name INTO v_name FROM public.academy_profiles a WHERE a.id = v.scope_id;
  ELSIF v.scope_kind = 'trainer' THEN
    -- trainer_profiles has no name column of its own; business_name first, the account's
    -- profile name as the fallback.
    SELECT coalesce(t.business_name, p.full_name) INTO v_name
      FROM public.trainer_profiles t
      LEFT JOIN public.profiles p ON p.user_id = t.user_id
     WHERE t.id = v.scope_id;
  ELSE
    v_name := 'PadelTrainer.ai';
  END IF;

  RETURN QUERY SELECT
    v_status, v.kind, v.scope_kind, v_name,
    public.notification_redact_destination(v.address_normalized, 'email'),
    v.key_version;
END;
$$;

REVOKE ALL ON FUNCTION public.get_notification_manage_context(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_notification_manage_context(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- APPLY (service-role only; the edge function verifies the HMAC before calling).
--
-- ONE action, enforced here rather than trusted from the edge: marketing suppression for the
-- capability's own scope + address. Both surfaces (the manage page and the RFC 8058 one-click
-- POST) call this with the same token and the same action.
CREATE OR REPLACE FUNCTION public.apply_notification_manage_action(
  p_capability_id uuid,
  p_action text,
  p_source text   -- 'one_click' | 'manage_page'
) RETURNS text    -- applied | already_applied | rejected_<reason>
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v public.notification_manage_capabilities%ROWTYPE;
  v_new boolean;
  v_min int;
BEGIN
  -- ONE action, and it is MONOTONIC. That is the whole reason this surface is safe to expose to
  -- a forwardable link: suppressing marketing to an address can be replayed by anyone holding
  -- the link, at any time, without ever contradicting a choice the recipient made later. (An
  -- action that could be undone by a stale link — switching a service preference back off after
  -- someone re-enabled it — is exactly what this model no longer offers.)
  IF p_action <> 'marketing_unsubscribe' THEN
    RETURN 'rejected_unknown_action';
  END IF;
  IF p_source NOT IN ('one_click', 'manage_page') THEN
    RETURN 'rejected_unknown_source';
  END IF;

  SELECT * INTO v FROM public.notification_manage_capabilities c
   WHERE c.id = p_capability_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'rejected_missing'; END IF;
  IF v.revoked_at IS NOT NULL THEN RETURN 'rejected_revoked'; END IF;
  IF v.expires_at <= now() THEN RETURN 'rejected_expired'; END IF;
  -- Missing key state = unavailable, never a floor of 1 (see the context RPC).
  SELECT min_mintable_version INTO v_min FROM public.notification_manage_key_state WHERE id;
  IF v_min IS NULL OR v.key_version < v_min THEN RETURN 'rejected_retired_key'; END IF;

  v_new := public.record_marketing_suppression(
    v.address_normalized, v.scope_kind, v.scope_id, p_source, v.id, NULL);
  UPDATE public.notification_manage_capabilities
     SET last_used_at = now() WHERE id = v.id;
  RETURN CASE WHEN v_new THEN 'applied' ELSE 'already_applied' END;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_notification_manage_action(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_notification_manage_action(uuid, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- RETENTION, stated because this model's identity depends on row permanence.
--
-- A capability row IS the send's identity, so deleting one lets the same source mint a NEW id —
-- a different token for a message that may still be retried. Rows may therefore only be purged
-- once their source can no longer retry: the sweep (S5) deletes rows whose expires_at is more
-- than 30 days past, which is far beyond any worker retry/backoff window, and never deletes a
-- row that is merely revoked. Nothing here deletes; this comment is the contract the
-- sweep must satisfy, and `idx_notif_manage_cap_expiry` is what it will read. A REVOKED row is
-- never purged early either: it is still the record of that send's identity.
--
-- Unbounded growth is bounded in practice by scope: capabilities exist only for MARKETING sends
-- (campaigns, drip), not for the transactional/service pipeline.
