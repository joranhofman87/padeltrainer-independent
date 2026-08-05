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
-- mail), 'academy' or 'trainer' (that tenant's campaigns). A platform-wide row does not silence a
-- tenant's campaigns and vice versa — a person may want one academy's news and not another's; the
-- manage page can always write multiple rows. Rows are MONOTONIC and idempotent: re-asserting an
-- existing suppression is a no-op, and nothing here un-suppresses (a deliberate omission — an
-- un-suppress is a consent decision that belongs to an explicit, audited surface, not to a token
-- endpoint that anyone holding a forwarded link can replay).
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
  -- provenance for audits: which capability performed it (one_click / manage_page), or which
  -- operator recorded it (manual). Soft references — a purged capability must not undo the
  -- suppression it created.
  capability_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uniq_marketing_suppression_scoped
  ON public.email_marketing_suppression (address_normalized, scope_kind, scope_id)
  WHERE scope_id IS NOT NULL;
CREATE UNIQUE INDEX uniq_marketing_suppression_platform
  ON public.email_marketing_suppression (address_normalized)
  WHERE scope_id IS NULL;

COMMENT ON TABLE public.email_marketing_suppression IS
  'Address-keyed marketing opt-outs per sending scope (platform | academy | trainer). Read at send time by campaign/onboarding senders; NEVER read by service notifications. Monotonic: rows are only ever added here — removing one is an explicit, audited operator decision, deliberately not implemented by any token endpoint.';

-- Service-role only, RLS enabled with ZERO policies BY DESIGN (the persons-tables doctrine):
-- suppression rows carry raw addresses, and the write paths are token endpoints + workers.
ALTER TABLE public.email_marketing_suppression ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_marketing_suppression FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.email_marketing_suppression TO service_role;

-- ---------------------------------------------------------------------------
-- Send-time read. Fails CLOSED by shape: returns true when suppressed; a caller that cannot
-- reach it must defer the send, never proceed (the caller-side rule the workers already follow
-- for is_email_suppressed).
CREATE OR REPLACE FUNCTION public.is_marketing_suppressed(
  p_address text,
  p_scope_kind text,
  p_scope_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.email_marketing_suppression s
     WHERE s.address_normalized = lower(btrim(p_address))
       AND (
         -- the platform arm silences platform marketing AND is honoured by tenant campaigns:
         -- "stop all marketing from this product" must mean all of it.
         s.scope_id IS NULL
         OR (s.scope_kind = p_scope_kind AND s.scope_id = p_scope_id)
       )
  );
$$;

COMMENT ON FUNCTION public.is_marketing_suppressed(text, text, uuid) IS
  'True when the address is marketing-suppressed for the given sending scope. A platform-wide suppression covers every scope; a tenant suppression covers only that tenant. Callers must treat an ERROR from this check as "do not send, defer and alert" — never as clearance.';

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
