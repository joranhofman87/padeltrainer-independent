-- ============================================================================
-- REBOOK · resume-payment: the claimant's active UNPAID rebook invoice by claim token
-- ============================================================================
-- WHY: a player who accepted a STRICT/upfront rebook but never finished Mollie
-- (closed tab, network drop, page refresh) lands back on the claim page, which
-- shows the deferred "you'll receive an invoice when the cycle starts" copy —
-- but on a strict cycle NO invoice is ever sent, so the held seat silently lapses
-- and the academy loses the booking. The claim page needs a "Continue to payment"
-- link, which requires the unpaid invoice's public pay token.
--
-- RLS blocks a logged-out guest from reading invoices directly, so this token-gated
-- SECURITY DEFINER read returns just {public_token,status} for the ONE active,
-- unpaid, non-revoked rebook invoice tied to the claim — single-claim invoices are
-- tagged rebook_cyclus_id + the claimant identity; group invoices are tagged
-- rebook_group_id. The claim_token is the capability (mirrors get_priority_claim_by_token),
-- and the /pay/:public_token page is already anon-accessible, so this exposes no new
-- surface. Read-only, no side effects. anon + authenticated.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_unpaid_rebook_invoice_by_claim_token(_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.slot_priority_claims%ROWTYPE;
  v_cyclus_id uuid;
  v_inv public.invoices%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.slot_priority_claims WHERE claim_token = _token LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF c.rebook_group_id IS NOT NULL THEN
    -- GROUP: the captain's single invoice covers the whole group (tagged rebook_group_id).
    SELECT i.* INTO v_inv FROM public.invoices i
    WHERE i.rebook_group_id = c.rebook_group_id
      AND i.status NOT IN ('paid', 'cancelled', 'draft')
      AND i.public_token IS NOT NULL
      AND i.public_token_revoked_at IS NULL
    ORDER BY i.created_at DESC
    LIMIT 1;
  ELSE
    -- SINGLE: one active invoice per claimant+cyclus (tagged rebook_cyclus_id + the claimant
    -- identity). Match the claimant on player_id, else guest_player_id (mirrors create_invoice_deduped).
    SELECT s.cyclus_id INTO v_cyclus_id FROM public.availability_slots s WHERE s.id = c.slot_id;
    IF v_cyclus_id IS NULL THEN RETURN NULL; END IF;
    SELECT i.* INTO v_inv FROM public.invoices i
    WHERE i.rebook_cyclus_id = v_cyclus_id
      AND ((c.player_id IS NOT NULL AND i.player_id = c.player_id)
        OR (c.player_id IS NULL AND c.guest_player_id IS NOT NULL AND i.guest_player_id = c.guest_player_id))
      AND i.status NOT IN ('paid', 'cancelled', 'draft')
      AND i.public_token IS NOT NULL
      AND i.public_token_revoked_at IS NULL
    ORDER BY i.created_at DESC
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('public_token', v_inv.public_token, 'status', v_inv.status);
END;
$$;

COMMENT ON FUNCTION public.get_unpaid_rebook_invoice_by_claim_token(text) IS
  'Token-gated read: the ONE active UNPAID rebook invoice pay token for a claim (single: rebook_cyclus_id + claimant identity; group: rebook_group_id), so the claim page can offer Continue-to-payment after a dropped checkout. Returns {public_token,status} or NULL. Read-only; anon-executable (logged-out guests). The /pay/:token page is already anon, so no new surface.';

REVOKE ALL ON FUNCTION public.get_unpaid_rebook_invoice_by_claim_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_unpaid_rebook_invoice_by_claim_token(text) TO anon, authenticated;
