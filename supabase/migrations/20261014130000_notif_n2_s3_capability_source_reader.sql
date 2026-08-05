-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N2 S3 — a READ-ONLY capability lookup by SOURCE, for the send-path cutover rule.
--
-- WHY THIS EXISTS. S3 attaches the marketing-unsubscribe footer inside the campaign sender,
-- whose provider idempotency key (`campaign-recipient-<id>`) is stable across retries — so a
-- retry MUST rebuild a byte-identical body. Rows first attempted BEFORE the footer deploy were
-- accepted by the provider footer-less; attaching a footer to their retry would change the body
-- under the same key inside the provider's dedupe window. The cutover rule therefore is:
--
--   capability EXISTS for this send        → the canonical body has the footer → attach it;
--   no capability AND never attempted      → fresh row → mint, then attach;
--   no capability AND already attempted    → pre-cutover row → send footer-less, byte-identical.
--
-- Distinguishing the first case from the third needs a read that does NOT create. The mint RPC
-- deliberately creates-or-returns, and `notification_manage_capabilities` grants service_role
-- nothing (S1 revoked ALL; definer RPCs are the interface — see 20261014110000). Hence this
-- reader: SECURITY DEFINER, service_role only, returns claims the send path needs and nothing
-- else (no address — the caller already knows who it is mailing; returning it would only widen
-- what a compromised edge key can enumerate).
--
-- S5's retention sweep verification reads it too.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_manage_capability_for_source(
  p_source_kind text,
  p_source_id uuid
) RETURNS TABLE (
  capability_id uuid,
  key_version int,
  revoked boolean,
  expired boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_source_kind IS NULL OR btrim(p_source_kind) = '' THEN
    RAISE EXCEPTION 'get_manage_capability_for_source: source_kind is required';
  END IF;
  IF p_source_id IS NULL THEN
    RAISE EXCEPTION 'get_manage_capability_for_source: source_id is required';
  END IF;

  RETURN QUERY
  SELECT c.id,
         c.key_version,
         (c.revoked_at IS NOT NULL),
         (c.expires_at <= now())
    FROM public.notification_manage_capabilities c
   WHERE c.source_kind = p_source_kind
     AND c.source_id = p_source_id;
END;
$$;

COMMENT ON FUNCTION public.get_manage_capability_for_source(text, uuid) IS
  'N2 S3: read-only capability lookup by send identity (source_kind, source_id) for the sender cutover rule — existence marks "this send''s canonical body carries the footer". Returns zero rows or one (the pair is UNIQUE). Never creates; the mint RPC is the only writer. service_role only.';

REVOKE ALL ON FUNCTION public.get_manage_capability_for_source(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_manage_capability_for_source(text, uuid) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- The onboarding queue learns 'suppressed'. The claim RPC optimistically marks a row 'sent';
-- when the send-time marketing gate then refuses it, the row must record WHY it did not go out.
-- Without this arm the status write would violate the CHECK, error, and leave the row falsely
-- recorded as sent — a suppression that looks like a delivery.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.onboarding_email_queue DROP CONSTRAINT IF EXISTS onboarding_email_queue_status_check;
ALTER TABLE public.onboarding_email_queue ADD CONSTRAINT onboarding_email_queue_status_check
  CHECK (status IN ('pending', 'sent', 'failed', 'cancelled', 'awaiting_confirmation', 'suppressed'));
