-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N2 S5 round-2 — APPLY binds the SIGNED generation to the STORED one, in the database.
--
-- Review found the apply endpoints verifying a token's HMAC and then acting on the capability id
-- alone. The context path binds generations through `bindManageTokenToRow`; apply did not — and
-- the RPC could not, because nothing told it which generation the token was signed under.
--
-- WHY THIS IS LOAD-BEARING, precisely: an attacker cannot forge a signature without a key, so in
-- normal operation a verifying token always matches its row. The binding matters in the one
-- scenario generations exist for — a compromised-but-not-yet-retired key vN. WITH binding, a
-- stolen vN signs actions only against rows actually minted under vN (the compromise's real
-- blast radius). WITHOUT it, one stolen generation acts on EVERY capability of every generation.
--
-- The check lives HERE, under the row's FOR UPDATE, rather than in a read-then-act adapter —
-- the database enforces it atomically, and no future caller can forget it: the old 3-argument
-- signature is DROPPED, so a stale caller fails loudly (42883) instead of applying unbound.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.apply_notification_manage_action(uuid, text, text);

CREATE OR REPLACE FUNCTION public.apply_notification_manage_action(
  p_capability_id uuid,
  p_action text,
  p_source text,
  p_signed_key_version int
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v public.notification_manage_capabilities%ROWTYPE;
  v_new boolean;
  v_min int;
BEGIN
  -- ONE action, and it is MONOTONIC (see 20261014110000 for the full rationale).
  IF p_action <> 'marketing_unsubscribe' THEN
    RETURN 'rejected_unknown_action';
  END IF;
  IF p_source NOT IN ('one_click', 'manage_page') THEN
    RETURN 'rejected_unknown_source';
  END IF;
  IF p_signed_key_version IS NULL OR p_signed_key_version < 1 THEN
    -- The caller MUST know the signed generation — it is part of the verified token. A NULL here
    -- is a caller bug, never a recipient outcome.
    RETURN 'rejected_unbound_caller';
  END IF;

  SELECT * INTO v FROM public.notification_manage_capabilities c
   WHERE c.id = p_capability_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'rejected_missing'; END IF;
  -- THE BINDING: the generation the token was signed under must be the one the row was minted
  -- under. A verifying-but-mismatched pairing only exists if a key leaked; refuse it as the
  -- forgery it is.
  IF v.key_version <> p_signed_key_version THEN RETURN 'rejected_generation_mismatch'; END IF;
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

COMMENT ON FUNCTION public.apply_notification_manage_action(uuid, text, text, int) IS
  'N2: the ONE monotonic act a manage token authorizes — suppress marketing to this capability''s address in its scope. Requires the SIGNED key generation and refuses a row minted under any other (rejected_generation_mismatch): a verifying-but-mismatched pairing only exists if a key leaked. The 3-arg form is DROPPED so an unbound caller fails 42883 rather than applying without the binding. service_role only.';

REVOKE ALL ON FUNCTION public.apply_notification_manage_action(uuid, text, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_notification_manage_action(uuid, text, text, int) TO service_role;
