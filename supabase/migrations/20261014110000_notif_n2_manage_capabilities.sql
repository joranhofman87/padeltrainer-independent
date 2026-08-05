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
-- secret raw), while the edge layer can DETERMINISTICALLY re-derive the same token for the same
-- capability — which is what lets the digest pipeline freeze a request byte-identically across
-- retries and deploys (the Resend idempotency contract). key_version names which secret signs a
-- capability so keys can rotate without a flag day.
--
-- BECAUSE THE HMAC AUTHENTICATES ONLY THE ID, the row's claims are the authorization — so the
-- claims are IMMUTABLE, enforced three ways: no direct DML for any client role (the SECURITY
-- DEFINER RPCs below are the only writers), a BEFORE UPDATE trigger that refuses any change
-- outside revoked_at/last_used_at, and FKs that revoke authority by cascade when the underlying
-- user/contact row disappears.
--
-- CAPABILITY KINDS — each row grants exactly one narrow power:
--   * marketing_unsubscribe : suppress marketing to THIS address within THIS sending scope.
--   * account_event_optout  : set email 'off' for ONE optional event for ONE account holder.
--                             CONSUMPTIVE on first use: a forwarded or replayed link cannot
--                             re-apply after the person re-enabled the event in settings.
--   * manage_context        : open the guest manage page for THIS address/contact. In N2 the only
--                             action it may apply is marketing_unsubscribe — a guest "stop
--                             optional service mail" is deliberately NOT built, because the only
--                             lever that exists today (notification_contacts.consent_status)
--                             also silences REQUIRED mail: the resolver excludes an opted-out
--                             contact even for required_delivery events. A per-event
--                             contact-scoped preference model is future work, recorded in
--                             docs/NOTIFICATION_FOLLOWUPS.md.
--
-- A capability never carries the raw address into a URL, and its context RPC returns a REDACTED
-- destination for LIVE rows only — non-live rows disclose status alone.

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
  -- Binding, not secrecy: an old capability must not act after the underlying destination
  -- changed. md5 is sufficient for equality binding and is built in.
  destination_fingerprint text NOT NULL,

  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.notification_contacts(id) ON DELETE CASCADE,
  event_type text REFERENCES public.notification_event_types(key),

  -- account_event_optout is a USER grant (never contact-bound: account mail can deliver via the
  -- persons.email fallback with no contact row at all, so the binding that matters is to the
  -- account's canonical address, re-checked at apply time).
  CONSTRAINT notif_manage_cap_kind_coherent CHECK (
    (kind = 'account_event_optout' AND user_id IS NOT NULL AND event_type IS NOT NULL AND contact_id IS NULL)
    OR (kind = 'marketing_unsubscribe' AND event_type IS NULL)
    OR (kind = 'manage_context' AND event_type IS NULL)
  ),

  source_kind text NOT NULL
    CHECK (source_kind IN ('outbox', 'digest_group', 'campaign_recipient', 'onboarding_queue', 'legacy_send')),
  source_id uuid,

  key_version int NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notif_manage_cap_reuse
  ON public.notification_manage_capabilities
     (kind, scope_kind, scope_id, address_normalized, user_id, contact_id, event_type)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_notif_manage_cap_contact
  ON public.notification_manage_capabilities (contact_id) WHERE contact_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX idx_notif_manage_cap_expiry
  ON public.notification_manage_capabilities (expires_at) WHERE revoked_at IS NULL;

COMMENT ON TABLE public.notification_manage_capabilities IS
  'One row per signed manage-link grant. The token an email carries is <id>.<HMAC(id, edge-held key)> — this table never stores the HMAC or the key, so reading it cannot forge a live link. Claims are IMMUTABLE (no client DML; definer RPCs are the only writers; the guard trigger refuses updates outside revoked_at/last_used_at).';

-- No direct DML for ANY client role — the definer RPCs are the only path. (The HMAC signs only
-- the id, so an UPDATE to a row''s claims would silently retarget an already-signed link.)
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
-- DETERMINISTIC REUSE is the load-bearing property: the same logical grant returns the SAME live
-- capability id, so the edge layer derives the SAME token bytes — a digest retry or a worker
-- re-render cannot produce a different link under the same provider idempotency key. Concurrency
-- is serialized by an advisory xact lock over the canonical grant key (two workers minting the
-- same grant race a plain SELECT-then-INSERT into two different ids = two different token bytes).
--
-- source_kind/source_id are PROVENANCE OF THE FIRST MINT, deliberately outside the reuse
-- identity: later sends of the same logical grant share the capability (that is the point), and
-- claims on a signed row never change. p_ttl fixes expiry at first mint only — "extending" a
-- signed row would mutate its claims. A HIGHER key_version ROTATES: live older-version grants for
-- the same logical key are revoked and a fresh capability is minted under the new key.
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
  p_ttl interval,
  p_key_version int DEFAULT 1
) RETURNS TABLE (capability_id uuid, key_version int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_address text := lower(btrim(p_address));
  v_required boolean;
  v_row public.notification_manage_capabilities%ROWTYPE;
BEGIN
  -- EVERY input is validated BEFORE the reuse lookup — an invalid request must never succeed
  -- just because a matching row already exists.
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
  IF p_key_version IS NULL OR p_key_version < 1 THEN
    RAISE EXCEPTION 'mint_notification_manage_capability: key_version must be >= 1';
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
    IF p_user_id IS NULL OR p_event_type IS NULL OR p_contact_id IS NOT NULL THEN
      RAISE EXCEPTION 'mint_notification_manage_capability: account_event_optout is a user+event grant (no contact)';
    END IF;
    -- A REQUIRED event must never gain a mutating opt-out capability: the settings page renders
    -- it "Always on" and the resolver forces it — a token that could switch it off would be a
    -- second, unreviewed enforcement path. Refused at mint AND re-checked at apply.
    SELECT required_delivery INTO v_required
      FROM public.notification_event_types WHERE key = p_event_type;
    IF v_required IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'mint_notification_manage_capability: % is required-delivery (or unknown) — no opt-out capability may exist for it', p_event_type;
    END IF;
  END IF;
  IF p_kind IN ('marketing_unsubscribe', 'manage_context') AND p_event_type IS NOT NULL THEN
    RAISE EXCEPTION 'mint_notification_manage_capability: % carries no event_type', p_kind;
  END IF;

  -- Serialize concurrent mints of the SAME logical grant. hashtextextended over the canonical
  -- key; advisory xact locks release at commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'notif_manage_cap:' || p_kind || ':' || p_scope_kind || ':' || coalesce(p_scope_id::text, '-')
      || ':' || v_address || ':' || coalesce(p_user_id::text, '-')
      || ':' || coalesce(p_contact_id::text, '-') || ':' || coalesce(p_event_type, '-'), 0));

  -- Key rotation: a request under a NEWER version retires every live older-version grant for
  -- this logical key, so the old links die when the old key does.
  UPDATE public.notification_manage_capabilities c
     SET revoked_at = now()
   WHERE c.kind = p_kind
     AND c.scope_kind = p_scope_kind
     AND c.scope_id IS NOT DISTINCT FROM p_scope_id
     AND c.address_normalized = v_address
     AND c.user_id IS NOT DISTINCT FROM p_user_id
     AND c.contact_id IS NOT DISTINCT FROM p_contact_id
     AND c.event_type IS NOT DISTINCT FROM p_event_type
     AND c.revoked_at IS NULL
     AND c.key_version < p_key_version;

  SELECT * INTO v_row
    FROM public.notification_manage_capabilities c
   WHERE c.kind = p_kind
     AND c.scope_kind = p_scope_kind
     AND c.scope_id IS NOT DISTINCT FROM p_scope_id
     AND c.address_normalized = v_address
     AND c.user_id IS NOT DISTINCT FROM p_user_id
     AND c.contact_id IS NOT DISTINCT FROM p_contact_id
     AND c.event_type IS NOT DISTINCT FROM p_event_type
     AND c.key_version = p_key_version
     AND c.revoked_at IS NULL
     AND c.expires_at > now()
   ORDER BY c.created_at DESC
   LIMIT 1;
  IF FOUND THEN
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
     p_key_version, now() + p_ttl)
  RETURNING id, notification_manage_capabilities.key_version;
END;
$$;

REVOKE ALL ON FUNCTION public.mint_notification_manage_capability(text, text, uuid, text, uuid, uuid, text, text, uuid, interval, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mint_notification_manage_capability(text, text, uuid, text, uuid, uuid, text, text, uuid, interval, int) TO service_role;

-- ---------------------------------------------------------------------------
-- CONTEXT (service-role only — the edge function verifies the HMAC FIRST, then reads this).
-- PII-TRIMMED per the claim-token doctrine: the link is forwardable, so the page it opens must
-- show nothing a stranger could use — a redacted destination, the scope's display name, and what
-- the capability may do. Never the raw address, never ids — and a NON-LIVE capability discloses
-- its status and NOTHING else: an expired or revoked link is a dead end, not a directory entry.
CREATE OR REPLACE FUNCTION public.get_notification_manage_context(p_capability_id uuid)
RETURNS TABLE (
  status text,               -- live | expired | revoked | missing
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
  v_status text;
  v_name text;
BEGIN
  SELECT * INTO v FROM public.notification_manage_capabilities c WHERE c.id = p_capability_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'missing'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::int;
    RETURN;
  END IF;

  v_status := CASE
    WHEN v.revoked_at IS NOT NULL THEN 'revoked'
    WHEN v.expires_at <= now() THEN 'expired'
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
    v_status,
    v.kind,
    v.scope_kind,
    v_name,
    public.notification_redact_destination(v.address_normalized, 'email'),
    v.event_type,
    v.key_version;
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
--                           authenticated re-enable.
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

  -- Destination binding. Contact-bound grants: the trigger below revokes on address change
  -- transactionally; the fingerprint re-check is the belt to that suspender. User-bound grants
  -- (account_event_optout) have no contact — their mail delivers via the account's canonical
  -- persons.email — so the binding is re-derived from THAT, and a capability minted for an old
  -- inbox stops acting the moment the account's address moves on. A missing persons row reads
  -- as changed: unknown must fail closed.
  IF v.contact_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.notification_contacts nc
        WHERE nc.id = v.contact_id
          AND md5(lower(btrim(coalesce(nc.destination_normalized, '')))) <> v.destination_fingerprint
     ) THEN
    RETURN 'rejected_destination_changed';
  END IF;
  IF v.kind = 'account_event_optout' THEN
    IF (SELECT md5(lower(btrim(pe.email))) FROM public.persons pe WHERE pe.user_id = v.user_id)
       IS DISTINCT FROM v.destination_fingerprint THEN
      RETURN 'rejected_destination_changed';
    END IF;
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
  -- Required-delivery is re-checked at APPLY time: a catalog reclassification between mint and
  -- click must win over the older grant.
  SELECT required_delivery INTO v_required
    FROM public.notification_event_types WHERE key = v.event_type;
  IF v_required IS DISTINCT FROM false THEN
    RETURN 'rejected_required_event';
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
-- A contact whose ADDRESS changes revokes every live capability bound to it, in the same
-- transaction as the change — an emailed link must not keep authority over a destination it was
-- never minted for.
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
