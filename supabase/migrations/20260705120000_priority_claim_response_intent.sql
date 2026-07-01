-- Slice B (owner decision #2 / Codex P3): store WHICH button the player clicked on a rebook invite,
-- even when they don't finish. Today an explicit "No" sets status='declined' (recorded), and a
-- completed "Yes" becomes status='claimed' via the payment webhook — but a "Yes" that never finishes
-- checkout leaves the claim 'pending', indistinguishable from someone who never opened the email.
--
-- Add a lightweight, NON-DESTRUCTIVE intent log: response_intent ('accept'|'decline') + when. It is
-- stamped the moment the player lands from an email button (or presses Yes on the page), WITHOUT
-- touching status/capacity/release logic — so the academy can see "clicked Yes, hasn't paid yet".
ALTER TABLE public.slot_priority_claims
  ADD COLUMN IF NOT EXISTS response_intent text,
  ADD COLUMN IF NOT EXISTS response_intent_at timestamptz;

COMMENT ON COLUMN public.slot_priority_claims.response_intent IS
  'The button the player clicked on the invite (accept|decline), recorded on landing/press even if they never finish. Distinct from status: an accept intent can sit on a still-pending (unpaid) claim.';

-- Token-gated, write-only: record the click on a still-actionable (pending) claim. Never changes
-- status — a NULL/other _intent or an already-responded claim is a no-op. anon+authenticated so the
-- no-login email flow can record it.
CREATE OR REPLACE FUNCTION public.record_priority_claim_intent(_token text, _intent text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _intent NOT IN ('accept', 'decline') THEN
    RETURN;
  END IF;
  UPDATE public.slot_priority_claims
    SET response_intent = _intent, response_intent_at = now()
    WHERE claim_token = _token AND status = 'pending';
END;
$$;

REVOKE ALL ON FUNCTION public.record_priority_claim_intent(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_priority_claim_intent(text, text) TO anon, authenticated;
