-- N2 S1 — MANAGEMENT CAPABILITIES: the signed, scoped "manage this email's preferences" grant.
--
-- THE TOKEN MODEL, and why it is split across two layers. A footer link must work for recipients
-- who cannot log in (guests, hand-typed campaign addresses) without exposing enumeration, replay
-- against a rotated address, cross-recipient action, or PII in the URL. The design:
--
--     token = <capability_id> '.' base64url( HMAC-SHA256(capability_id, edge secret key vN) )
--
-- This table stores ONLY the capability row — never the HMAC, never the secret. The signing key
-- lives exclusively in edge-function env (NOTIF_MANAGE_TOKEN_KEY_V<n>), so a database read cannot
-- reconstruct a live link (the improvement over the claim_token precedent, which stores its
-- secret raw), while the edge layer re-derives the same token for the same capability — which is
-- what lets a retry rebuild a byte-identical email under the same provider idempotency key.
--
-- ============================================================================
-- ONE CAPABILITY PER SEND. This is the model, and it replaces an earlier one that tried to reuse
-- a capability across every send of the same "logical grant". Three review rounds found three
-- separate defects in that idea — a consumed grant made the NEXT email's link inert; rotation
-- changed the bytes of a retry under a stable idempotency key; the per-grant version floor let a
-- stale worker mint a retired key for any grant it had not seen. All three came from the same
-- root: a capability that outlives the message it was printed in has a lifecycle of its own, and
-- every rule about consumption, rotation and binding then needs a second answer for "which send
-- is this?". So the identity IS the send:
--
--     UNIQUE (kind, source_kind, source_id)
--
-- Determinism now comes from the unique index rather than from a lock plus a lookup: a retry of
-- the same send finds its row (and every claim is re-verified equal — a same-source mint with
-- different claims RAISES rather than silently re-pointing a printed link), and a new send gets
-- a new row. Consumption is correct by construction: spending one send's link cannot make the
-- next send's link inert.
--
-- ROTATION is database-owned state, not a mint-time revocation sweep
-- (notification_manage_key_state). Mint refuses below `min_mintable_version`; existing rows are
-- NEVER re-signed or revoked by a rotation, because rewriting an already-printed link's version
-- is exactly how a retry's body changes underneath a fixed provider idempotency key. A burned
-- key instead fails CLOSED at the edge: the verifier refuses a token whose stored version is
-- below the minimum, and the link (or the retry) terminal-fails honestly.
--
-- CAPABILITY KINDS — each row grants exactly one narrow power:
--   * marketing_unsubscribe : suppress marketing to THIS address within THIS sending scope.
--   * account_event_optout  : set email 'off' for ONE optional event for ONE account holder.
--                             CONSUMPTIVE: a forwarded or replayed link cannot re-apply after
--                             the person re-enabled the event in settings — and because rows are
--                             per send, the next email still carries a working link.
--   * manage_context        : open the guest manage page for THIS address/contact. In N2 the only
--                             action it may apply is marketing_unsubscribe — a guest "stop
--                             optional service mail" is deliberately NOT built, because the only
--                             lever that exists today (notification_contacts.consent_status)
--                             also silences REQUIRED mail: the resolver excludes an opted-out
--                             contact even for required_delivery events. A per-event
--                             contact-scoped preference model is future work, recorded in
--                             docs/NOTIFICATION_FOLLOWUPS.md.
--
-- BINDING IS TO THE DELIVERED DESTINATION, whatever resolved it. The resolver prefers an eligible
-- notification_contacts row and falls back to the account's persons.email, so an account-holder's
-- mail can arrive at either: a capability therefore carries contact_id when the send was
-- contact-bound and none when it used the account fallback, and apply re-checks the fingerprint
-- against THAT authority. Both authorities revoke on change (triggers below), and revocation is
-- permanent — an address moved away and back does not reactivate an unused link.
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

ALTER TABLE public.notification_manage_key_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_manage_key_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.notification_manage_key_state TO service_role;

-- ---------------------------------------------------------------------------
CREATE TABLE public.notification_manage_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('marketing_unsubscribe', 'account_event_optout', 'manage_context')),

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

  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.notification_contacts(id) ON DELETE CASCADE,
  event_type text REFERENCES public.notification_event_types(key),

  CONSTRAINT notif_manage_cap_kind_coherent CHECK (
    -- account_event_optout: the PREFERENCE authority is the user; the DESTINATION authority is
    -- the contact when the send was contact-bound, else the account's persons.email.
    (kind = 'account_event_optout' AND user_id IS NOT NULL AND event_type IS NOT NULL)
    OR (kind = 'marketing_unsubscribe' AND event_type IS NULL)
    OR (kind = 'manage_context' AND event_type IS NULL)
  ),

  -- THE IDENTITY: one capability per (kind, send).
  source_kind text NOT NULL
    CHECK (source_kind IN ('outbox', 'digest_group', 'campaign_recipient', 'onboarding_queue', 'legacy_send')),
  source_id uuid NOT NULL,

  key_version int NOT NULL CHECK (key_version >= 1),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uniq_notif_manage_cap_per_send UNIQUE (kind, source_kind, source_id)
);

CREATE INDEX idx_notif_manage_cap_contact
  ON public.notification_manage_capabilities (contact_id) WHERE contact_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX idx_notif_manage_cap_user
  ON public.notification_manage_capabilities (user_id) WHERE user_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX idx_notif_manage_cap_expiry
  ON public.notification_manage_capabilities (expires_at) WHERE revoked_at IS NULL;

COMMENT ON TABLE public.notification_manage_capabilities IS
  'One row per (kind, send). The token an email carries is <id>.<HMAC(id, edge-held key)> — this table never stores the HMAC or the key, so reading it cannot forge a live link. Claims are IMMUTABLE (no client DML; definer RPCs are the only writers; the guard trigger refuses updates outside revoked_at/last_used_at). Per-send identity is what makes retries deterministic and consumption safe.';

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
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
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
-- Idempotent on (kind, source_kind, source_id) — a retry of the same send returns the SAME row,
-- so the edge layer derives the same token bytes and the rebuilt email is byte-identical under
-- the same provider idempotency key. Every claim is RE-VERIFIED on that path: a second mint for
-- the same send with different claims is a source-id collision, and it RAISES rather than
-- handing back a link that no longer describes the mail it is printed in.
CREATE OR REPLACE FUNCTION public.mint_notification_manage_capability(
  p_kind text,
  p_scope_kind text,
  p_scope_id uuid,
  p_address text,
  p_user_id uuid,
  p_contact_id uuid,
  p_event_type text,
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
  v_required boolean;
  v_policy text;
  v_version int;
  v_row public.notification_manage_capabilities%ROWTYPE;
BEGIN
  -- EVERY input is validated BEFORE anything is looked up or written.
  IF v_address IS NULL OR position('@' IN v_address) <= 1 THEN
    RAISE EXCEPTION 'mint_notification_manage_capability: not an email address';
  END IF;
  IF p_kind NOT IN ('marketing_unsubscribe', 'account_event_optout', 'manage_context') THEN
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
  -- TTL bounds per kind: a zero/negative TTL mints dead links; an unbounded one is a forever
  -- credential. Marketing unsubscribe must outlive mailbox archaeology (>= 13 months per
  -- deliverability guidance); the interactive kinds are shorter-lived.
  IF p_ttl IS NULL OR p_ttl < interval '1 day' OR p_ttl > interval '800 days' THEN
    RAISE EXCEPTION 'mint_notification_manage_capability: ttl out of bounds';
  END IF;
  IF p_kind = 'marketing_unsubscribe' AND p_ttl < interval '395 days' THEN
    RAISE EXCEPTION 'mint_notification_manage_capability: marketing unsubscribe links must stay valid >= 13 months';
  END IF;
  IF p_kind = 'account_event_optout' THEN
    IF p_user_id IS NULL OR p_event_type IS NULL THEN
      RAISE EXCEPTION 'mint_notification_manage_capability: account_event_optout needs a user and an event';
    END IF;
    -- A REQUIRED event must never gain a mutating opt-out capability, and the CATALOG's declared
    -- footer policy is the routing authority: only a manage_prefs event may carry an event
    -- opt-out (a marketing event's mail carries marketing_unsubscribe capabilities instead).
    SELECT required_delivery, email_footer_policy INTO v_required, v_policy
      FROM public.notification_event_types WHERE key = p_event_type;
    IF v_required IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'mint_notification_manage_capability: % is required-delivery (or unknown) — no opt-out capability may exist for it', p_event_type;
    END IF;
    IF v_policy IS DISTINCT FROM 'manage_prefs' THEN
      RAISE EXCEPTION 'mint_notification_manage_capability: % declares footer policy % — an event opt-out capability requires manage_prefs', p_event_type, v_policy;
    END IF;
  END IF;
  IF p_kind IN ('marketing_unsubscribe', 'manage_context') AND p_event_type IS NOT NULL THEN
    RAISE EXCEPTION 'mint_notification_manage_capability: % carries no event_type', p_kind;
  END IF;

  SELECT current_version INTO v_version FROM public.notification_manage_key_state WHERE id;
  IF v_version IS NULL THEN
    RAISE EXCEPTION 'mint_notification_manage_capability: signing-key state is missing';
  END IF;

  -- The send may already have a capability (a retry). Return it, but only after proving it still
  -- describes THIS mail.
  SELECT * INTO v_row FROM public.notification_manage_capabilities c
   WHERE c.kind = p_kind AND c.source_kind = p_source_kind AND c.source_id = p_source_id;
  IF FOUND THEN
    IF v_row.scope_kind IS DISTINCT FROM p_scope_kind
       OR v_row.scope_id IS DISTINCT FROM p_scope_id
       OR v_row.address_normalized IS DISTINCT FROM v_address
       OR v_row.user_id IS DISTINCT FROM p_user_id
       OR v_row.contact_id IS DISTINCT FROM p_contact_id
       OR v_row.event_type IS DISTINCT FROM p_event_type THEN
      RAISE EXCEPTION 'mint_notification_manage_capability: % % already has a % capability with different claims — a source id must identify ONE send', p_source_kind, p_source_id, p_kind;
    END IF;
    RETURN QUERY SELECT v_row.id, v_row.key_version;
    RETURN;
  END IF;

  RETURN QUERY
  INSERT INTO public.notification_manage_capabilities
    (kind, scope_kind, scope_id, address_normalized, destination_fingerprint,
     user_id, contact_id, event_type, source_kind, source_id, key_version, expires_at)
  VALUES
    (p_kind, p_scope_kind, p_scope_id, v_address, md5(v_address),
     p_user_id, p_contact_id, p_event_type, p_source_kind, p_source_id,
     v_version, now() + p_ttl)
  RETURNING id, notification_manage_capabilities.key_version;
END;
$$;

REVOKE ALL ON FUNCTION public.mint_notification_manage_capability(text, text, uuid, text, uuid, uuid, text, text, uuid, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mint_notification_manage_capability(text, text, uuid, text, uuid, uuid, text, text, uuid, interval) TO service_role;

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
  event_type text,
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
    RETURN QUERY SELECT 'missing'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::int;
    RETURN;
  END IF;

  SELECT min_mintable_version INTO v_min FROM public.notification_manage_key_state WHERE id;
  v_status := CASE
    WHEN v.revoked_at IS NOT NULL THEN 'revoked'
    WHEN v.expires_at <= now() THEN 'expired'
    -- A burned signing key retires every link it signed. Reported (and refused) here as well as
    -- at the edge, so the database is not merely trusting the verifier to have been redeployed.
    WHEN v.key_version < coalesce(v_min, 1) THEN 'retired_key'
    ELSE 'live'
  END;
  IF v_status <> 'live' THEN
    RETURN QUERY SELECT v_status, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::int;
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
    v.event_type, v.key_version;
END;
$$;

REVOKE ALL ON FUNCTION public.get_notification_manage_context(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_notification_manage_context(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- APPLY (service-role only; the edge function verifies the HMAC before calling).
--
-- Kind → action is a CLOSED mapping, enforced here rather than trusted from the edge:
--   marketing_unsubscribe → marketing suppression for the capability's scope + address;
--   manage_context        → marketing suppression ONLY (N2: guests get no service-mail lever);
--   account_event_optout  → prefs_v2 email 'off' for exactly (user, event) — CONSUMPTIVE on
--                           first use, so a forwarded/replayed link cannot undo a later
--                           authenticated re-enable. (Per-send rows mean the NEXT email still
--                           carries a working link.)
-- Marketing actions stay idempotent and replayable (a re-clicked unsubscribe re-asserts a
-- monotonic fact); the account opt-out is the one action whose replay could FIGHT the user.
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
  v_rows int;
  v_required boolean;
  v_policy text;
  v_min int;
  v_bound text;
  v_wa text;
BEGIN
  IF p_action NOT IN ('marketing_unsubscribe', 'event_optout') THEN
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
  SELECT min_mintable_version INTO v_min FROM public.notification_manage_key_state WHERE id;
  IF v.key_version < coalesce(v_min, 1) THEN RETURN 'rejected_retired_key'; END IF;

  -- DESTINATION BINDING, against the authority that actually delivered this mail. A
  -- contact-bound capability re-checks the contact's CURRENT address (the trigger below also
  -- revokes transactionally on change — belt and suspender); a capability with no contact was
  -- delivered via the account's canonical persons.email, so that is what it re-checks. A missing
  -- authority reads as changed: unknown fails closed.
  IF v.contact_id IS NOT NULL THEN
    SELECT md5(lower(btrim(nc.destination_normalized))) INTO v_bound
      FROM public.notification_contacts nc WHERE nc.id = v.contact_id;
  ELSIF v.user_id IS NOT NULL THEN
    SELECT md5(lower(btrim(pe.email))) INTO v_bound
      FROM public.persons pe WHERE pe.user_id = v.user_id;
  ELSE
    -- No live authority to re-check (a hand-typed campaign address): the address captured at
    -- mint IS the binding, and it is immutable on the row.
    v_bound := v.destination_fingerprint;
  END IF;
  IF v_bound IS DISTINCT FROM v.destination_fingerprint THEN
    RETURN 'rejected_destination_changed';
  END IF;

  IF p_action = 'marketing_unsubscribe' THEN
    IF v.kind NOT IN ('marketing_unsubscribe', 'manage_context') THEN
      RETURN 'rejected_kind_mismatch';
    END IF;
    v_new := public.record_marketing_suppression(
      v.address_normalized, v.scope_kind, v.scope_id, p_source, v.id, NULL);
    UPDATE public.notification_manage_capabilities
       SET last_used_at = now() WHERE id = v.id;
    RETURN CASE WHEN v_new THEN 'applied' ELSE 'already_applied' END;
  END IF;

  -- event_optout
  IF v.kind <> 'account_event_optout' THEN
    RETURN 'rejected_kind_mismatch';
  END IF;
  -- CONSUMPTIVE: the first successful use is the whole grant. Without this, a link replayed (or
  -- forwarded) after the person re-enabled the event in authenticated settings would switch it
  -- off again — the token fighting the user.
  IF v.last_used_at IS NOT NULL THEN
    RETURN 'already_applied';
  END IF;
  -- Required-delivery AND the declared footer policy are re-checked at APPLY time: a catalog
  -- reclassification between mint and click must win over the older grant.
  SELECT required_delivery, email_footer_policy INTO v_required, v_policy
    FROM public.notification_event_types WHERE key = v.event_type;
  IF v_required IS DISTINCT FROM false THEN
    RETURN 'rejected_required_event';
  END IF;
  IF v_policy IS DISTINCT FROM 'manage_prefs' THEN
    RETURN 'rejected_event_policy';
  END IF;
  -- BOTH channel columns are always written on insert (the PR-8 trap): a fresh row must take the
  -- EVENT's whatsapp default, not the column default, or an email opt-out could silently move
  -- someone's WhatsApp cadence. On conflict only email moves.
  SELECT default_whatsapp_frequency INTO v_wa
    FROM public.notification_event_types WHERE key = v.event_type;
  INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency, whatsapp_frequency, updated_at)
  VALUES (v.user_id, v.event_type, 'off', coalesce(v_wa, 'off'), now())
  ON CONFLICT (user_id, event_type)
  DO UPDATE SET email_frequency = 'off', updated_at = now()
        WHERE public.notification_preferences_v2.email_frequency IS DISTINCT FROM 'off';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  UPDATE public.notification_manage_capabilities
     SET last_used_at = now() WHERE id = v.id;
  RETURN CASE WHEN v_rows > 0 THEN 'applied' ELSE 'already_applied' END;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_notification_manage_action(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_notification_manage_action(uuid, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- A destination that CHANGES revokes every live capability bound to it, in the same transaction
-- as the change — an emailed link must not keep authority over a destination it was never minted
-- for. Revocation is PERMANENT: moving an address away and back does not reactivate an unused
-- link, because revoked_at is never cleared.
CREATE OR REPLACE FUNCTION public.notif_manage_cap_revoke_on_contact_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.destination_normalized IS DISTINCT FROM OLD.destination_normalized THEN
    UPDATE public.notification_manage_capabilities
       SET revoked_at = now()
     WHERE contact_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notif_manage_cap_revoke_on_contact_change ON public.notification_contacts;
CREATE TRIGGER trg_notif_manage_cap_revoke_on_contact_change
  AFTER UPDATE OF destination_normalized ON public.notification_contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.notif_manage_cap_revoke_on_contact_change();

-- ...and the same for the account-fallback authority: a person's canonical email changing
-- retires the account-bound links printed against the old inbox.
CREATE OR REPLACE FUNCTION public.notif_manage_cap_revoke_on_person_email_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email AND NEW.user_id IS NOT NULL THEN
    UPDATE public.notification_manage_capabilities
       SET revoked_at = now()
     WHERE user_id = NEW.user_id AND contact_id IS NULL AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notif_manage_cap_revoke_on_person_email_change ON public.persons;
CREATE TRIGGER trg_notif_manage_cap_revoke_on_person_email_change
  AFTER UPDATE OF email ON public.persons
  FOR EACH ROW
  EXECUTE FUNCTION public.notif_manage_cap_revoke_on_person_email_change();
