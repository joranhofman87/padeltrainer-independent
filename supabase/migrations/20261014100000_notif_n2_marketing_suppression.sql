-- N2 S1 — MARKETING SUPPRESSION: the durable "stop mailing this address marketing" record.
--
-- WHY THIS TABLE EXISTS. send-campaign-emails ships academy/trainer-authored body_html verbatim
-- with NO unsubscribe link, NO List-Unsubscribe header, and NO suppression check of any kind —
-- recipients are client-built lists (players + hand-typed addresses) with no consent filter. The
-- onboarding drip and welcome mail are the same. That is the sharpest N2 gap: marketing mail with
-- no opt-out at all. This table is the opt-out those senders will consult AT SEND TIME.
--
-- WHAT IT IS NOT. Service notifications NEVER read this table — the marketing/service distinction
-- N2 requires is structural: service preferences live in notification_preferences_v2 (account
-- holders) and the contacts/consent model; marketing suppression is ADDRESS-KEYED within a sending
-- scope, because campaign recipients may have neither a login nor a notification_contacts row
-- (hand-typed addresses), and an unsubscribe is about the ADDRESS receiving the mail.
--
-- SCOPE MODEL. scope_kind 'platform' (PadelTrainer's own marketing: onboarding drip, product
-- mail), 'academy' or 'trainer' (that tenant's campaigns). A TENANT row silences only that
-- tenant — a person may want one academy's news and not another's. A PLATFORM row covers
-- EVERYTHING, tenant campaigns included: "stop all marketing from this product" must mean all of
-- it, and the reader below implements exactly that. Rows are MONOTONIC and idempotent:
-- re-asserting an existing suppression is a no-op, and nothing here un-suppresses (a deliberate
-- omission — an un-suppress is a consent decision that belongs to an explicit, audited surface,
-- not to a token endpoint that anyone holding a forwarded link can replay).
--
-- Uniqueness uses TWO partial indexes rather than one nullable composite: plain UNIQUE treats
-- NULLs as distinct, so (address, 'platform', NULL) could be inserted without bound.

CREATE TABLE public.email_marketing_suppression (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- normalized IN THE DATABASE: the check makes a non-normalized write an error rather than a
  -- silently-missable duplicate. (lower+trim is the same normalization ensure_guest_email_contact
  -- and the campaign sender will apply before reads.)
  address_normalized text NOT NULL
    CHECK (address_normalized = lower(btrim(address_normalized))
           AND position('@' IN address_normalized) > 1),
  scope_kind text NOT NULL CHECK (scope_kind IN ('platform', 'academy', 'trainer')),
  scope_id uuid,
  CONSTRAINT email_marketing_suppression_scope_coherent
    CHECK ((scope_kind = 'platform') = (scope_id IS NULL)),
  source text NOT NULL CHECK (source IN ('one_click', 'manage_page', 'manual')),
  -- PROVENANCE, and it is CONSTRAINED rather than merely conventional. Every row must be able to
  -- answer "who did this, and on what authority" — that is the whole point of an audit column —
  -- and three columns free to disagree cannot. A `one_click` row with no capability names no
  -- authority; a `manual` row with no actor names no human; a `manual` row carrying a capability
  -- id claims an authority it did not use, which is worse than saying nothing. So the coherent
  -- combinations are the only representable ones:
  --
  --   one_click | manage_page  →  capability_id NOT NULL, created_by NULL
  --                               (the token IS the authority; no human was involved)
  --   manual                   →  capability_id NULL,     created_by NOT NULL
  --                               (an operator acted; there was no token)
  --
  -- Soft references on purpose: a purged capability or a deleted account must not erase or
  -- invalidate the suppression it produced, so these are ids rather than foreign keys.
  capability_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT email_marketing_suppression_provenance_coherent CHECK (
    (source IN ('one_click', 'manage_page') AND capability_id IS NOT NULL AND created_by IS NULL)
    OR (source = 'manual' AND capability_id IS NULL AND created_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uniq_marketing_suppression_scoped
  ON public.email_marketing_suppression (address_normalized, scope_kind, scope_id)
  WHERE scope_id IS NOT NULL;
CREATE UNIQUE INDEX uniq_marketing_suppression_platform
  ON public.email_marketing_suppression (address_normalized)
  WHERE scope_id IS NULL;

COMMENT ON TABLE public.email_marketing_suppression IS
  'Address-keyed marketing opt-outs per sending scope (platform | academy | trainer). Read at send time by campaign/onboarding senders; NEVER read by service notifications. Monotonic: rows are only ever added here — removing one is an explicit, audited operator decision, deliberately not implemented by any token endpoint.';

-- RLS enabled with ZERO policies BY DESIGN (the persons-tables doctrine): suppression rows carry
-- raw addresses, and every write goes through the definer RPC below.
--
-- service_role is REVOKED EXPLICITLY, and that is not belt-and-braces. This project's
-- ALTER DEFAULT PRIVILEGES grants service_role ALL on new tables, and service_role carries
-- BYPASSRLS — so a bare "REVOKE FROM PUBLIC, anon, authenticated" would leave every edge function
-- holding the service key able to DELETE an opt-out, TRUNCATE the table, or rewrite a row's
-- provenance. Suppression is supposed to be MONOTONIC; a role that can erase it makes that a
-- convention rather than a property.
--
-- Not even INSERT is granted: `record_marketing_suppression` is SECURITY DEFINER and writes as the
-- owner, so a direct insert would only be a way to bypass the validation it performs. SELECT stays,
-- because operator/admin surfaces legitimately read this.
ALTER TABLE public.email_marketing_suppression ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_marketing_suppression FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.email_marketing_suppression TO service_role;

-- ---------------------------------------------------------------------------
-- Send-time read. Fails CLOSED in BOTH directions: true means suppressed, and a MALFORMED call
-- RAISES rather than answering false — an S3 wiring error (an academy sender passing a NULL
-- scope id, a typo'd scope kind, a non-address) must become a deferred send and an alert, never
-- marketing clearance. The writer validates the same shapes; a reader that validated less would
-- turn its own leniency into permission.
CREATE OR REPLACE FUNCTION public.is_marketing_suppressed(
  p_address text,
  p_scope_kind text,
  p_scope_id uuid
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_address text := lower(btrim(p_address));
BEGIN
  IF v_address IS NULL OR position('@' IN v_address) <= 1 THEN
    RAISE EXCEPTION 'is_marketing_suppressed: not an email address';
  END IF;
  IF p_scope_kind IS NULL OR p_scope_kind NOT IN ('platform', 'academy', 'trainer') THEN
    RAISE EXCEPTION 'is_marketing_suppressed: unknown scope_kind %', p_scope_kind;
  END IF;
  IF (p_scope_kind = 'platform') <> (p_scope_id IS NULL) THEN
    RAISE EXCEPTION 'is_marketing_suppressed: scope_kind % and scope_id disagree', p_scope_kind;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.email_marketing_suppression s
     WHERE s.address_normalized = v_address
       AND (
         -- the platform arm silences platform marketing AND is honoured by tenant campaigns:
         -- "stop all marketing from this product" must mean all of it.
         s.scope_id IS NULL
         OR (s.scope_kind = p_scope_kind AND s.scope_id = p_scope_id)
       )
  );
END;
$$;

COMMENT ON FUNCTION public.is_marketing_suppressed(text, text, uuid) IS
  'True when the address is marketing-suppressed for the given sending scope. A platform-wide suppression covers every scope; a tenant suppression covers only that tenant. Malformed calls RAISE (fail closed) — callers must treat an ERROR as "do not send, defer and alert", never as clearance.';

REVOKE ALL ON FUNCTION public.is_marketing_suppressed(text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_marketing_suppressed(text, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- The one write path. Idempotent + monotonic; validates scope coherence rather than trusting the
-- caller; normalizes the address itself so no caller can fork the normalization rule.
CREATE OR REPLACE FUNCTION public.record_marketing_suppression(
  p_address text,
  p_scope_kind text,
  p_scope_id uuid,
  p_source text,
  p_capability_id uuid DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_address text := lower(btrim(p_address));
  v_min int;
  v_inserted int;
BEGIN
  IF v_address IS NULL OR position('@' IN v_address) <= 1 THEN
    RAISE EXCEPTION 'record_marketing_suppression: not an email address';
  END IF;
  IF p_scope_kind NOT IN ('platform', 'academy', 'trainer') THEN
    RAISE EXCEPTION 'record_marketing_suppression: unknown scope_kind %', p_scope_kind;
  END IF;
  IF (p_scope_kind = 'platform') <> (p_scope_id IS NULL) THEN
    RAISE EXCEPTION 'record_marketing_suppression: scope_kind % and scope_id disagree', p_scope_kind;
  END IF;
  -- The NULL arm is explicit because SQL `NOT IN` yields NULL for a NULL left side, so a NULL
  -- source would slip past this check and die later on the column's NOT NULL — producing exactly
  -- the bare constraint error these named refusals exist to replace.
  IF p_source IS NULL OR p_source NOT IN ('one_click', 'manage_page', 'manual') THEN
    RAISE EXCEPTION 'record_marketing_suppression: unknown source %', coalesce(p_source, '<null>');
  END IF;
  -- The same provenance rule the table constrains, enforced HERE too so the caller gets a named
  -- refusal rather than a bare constraint violation — and so the rule survives even if this
  -- function is ever pointed at another table.
  IF p_source IN ('one_click', 'manage_page') AND (p_capability_id IS NULL OR p_created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'record_marketing_suppression: a % suppression is authorized by a capability and has no human actor', p_source;
  END IF;
  IF p_source = 'manual' AND (p_created_by IS NULL OR p_capability_id IS NOT NULL) THEN
    RAISE EXCEPTION 'record_marketing_suppression: a manual suppression names the operator who made it and carries no capability';
  END IF;

  -- ...AND THE NAMED AUTHORITY MUST BE REAL. Shape coherence only proves the columns agree about
  -- which KIND of authority acted; it does not prove one did. A row citing a capability that never
  -- existed, or one belonging to a different address or scope, still cannot answer "on what
  -- authority?" — which is the only question this column exists for.
  --
  -- The reference stays SOFT (no FK) on purpose: a purged capability or a deleted operator must
  -- not erase the suppression they produced. Validating at WRITE time and not enforcing at read
  -- time is exactly the combination that gives a durable, honest audit trail.
  IF p_capability_id IS NOT NULL THEN
    -- LIFECYCLE, not just existence. `apply_notification_manage_action` refuses a revoked, expired
    -- or retired-generation capability — but this recorder is reachable on its own, so without the
    -- same checks a caller could cite a DEAD capability and mint token-attributed provenance that
    -- the token itself could never have produced. The floor is read under the same FOR SHARE the
    -- mint uses, so a rotation cannot commit between this check and the insert.
    SELECT min_mintable_version INTO v_min
      FROM public.notification_manage_key_state WHERE id FOR SHARE;
    IF v_min IS NULL THEN
      RAISE EXCEPTION 'record_marketing_suppression: signing-key state is missing';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.notification_manage_capabilities c
       WHERE c.id = p_capability_id
         AND c.address_normalized = v_address
         AND c.scope_kind = p_scope_kind
         AND c.scope_id IS NOT DISTINCT FROM p_scope_id
    ) THEN
      RAISE EXCEPTION 'record_marketing_suppression: capability % does not exist, or is not for this address and scope', p_capability_id;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.notification_manage_capabilities c
       WHERE c.id = p_capability_id
         AND c.revoked_at IS NULL
         AND c.expires_at > now()
         AND c.key_version >= v_min
    ) THEN
      RAISE EXCEPTION 'record_marketing_suppression: capability % is not live (revoked, expired, or signed by a retired generation)', p_capability_id;
    END IF;
  END IF;
  IF p_created_by IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM auth.users u WHERE u.id = p_created_by) THEN
    RAISE EXCEPTION 'record_marketing_suppression: created_by % is not an account', p_created_by;
  END IF;

  INSERT INTO public.email_marketing_suppression
    (address_normalized, scope_kind, scope_id, source, capability_id, created_by)
  VALUES (v_address, p_scope_kind, p_scope_id, p_source, p_capability_id, p_created_by)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  -- true = newly suppressed, false = was already suppressed. Both are success: the action is
  -- monotonic, and a replayed one-click merely re-asserts it.
  RETURN v_inserted > 0;
END;
$$;

COMMENT ON FUNCTION public.record_marketing_suppression(text, text, uuid, text, uuid, uuid) IS
  'Idempotent, monotonic marketing opt-out write. Normalizes and validates in the database. Returns true on first suppression, false when it already existed — a replayed unsubscribe is a success, not an error.';

REVOKE ALL ON FUNCTION public.record_marketing_suppression(text, text, uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_marketing_suppression(text, text, uuid, text, uuid, uuid) TO service_role;
