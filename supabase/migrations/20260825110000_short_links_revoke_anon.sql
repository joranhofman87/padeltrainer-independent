-- SECURITY FIX for 20260825100000_short_links.sql: lock the mint + admin-read RPCs to authenticated.
--
-- Supabase's ALTER DEFAULT PRIVILEGES auto-grants EXECUTE on every new public function to `anon` (and
-- `authenticated`). The original migration's `REVOKE ALL … FROM public` removed only the PUBLIC
-- pseudo-role grant, NOT anon's explicit default-privileges grant — so an UNAUTHENTICATED caller could
-- mint short links (verified against prod: an anon RPC call returned a fresh code). The open-redirect
-- guard already blocks off-site targets, so the exposure was resource abuse (table spam), not an open
-- redirect — but minting must be authenticated.
--
-- resolve_short_link STAYS anon-callable (the Cloudflare Worker resolves with the anon key); the
-- short_links table itself remains fully locked by RLS (no policies).

REVOKE EXECUTE ON FUNCTION public.get_or_create_short_link(text, text, uuid, jsonb, boolean) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_short_codes(text, uuid[]) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.gen_short_code(int) FROM anon, PUBLIC;

-- Re-assert the intended grants (idempotent; the SECURITY DEFINER functions still call each other as
-- their owner, so internal use by the trigger/mint path is unaffected).
GRANT EXECUTE ON FUNCTION public.get_or_create_short_link(text, text, uuid, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_short_codes(text, uuid[]) TO authenticated;

-- Clean up any anon-minted junk from the exposure window. A real registration link always has
-- target_id set (the trigger fills it with the registration id), so target_id IS NULL uniquely
-- identifies path-only junk minted via the anon hole.
DELETE FROM public.short_links WHERE target_type = 'registration' AND target_id IS NULL;
