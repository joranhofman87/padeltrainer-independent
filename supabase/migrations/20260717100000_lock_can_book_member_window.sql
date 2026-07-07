-- ============================================================================
-- Lock can_book_member_window to service_role; add an auth.uid() wrapper for clients
-- ============================================================================
-- can_book_member_window(_user_id, _cycle_id) takes an ARBITRARY _user_id and was granted
-- to anon/authenticated so the client visibility path (filterVisibleSlotIds) could call it.
-- But that let an anon caller probe whether ANY user has cohort/priority/linked-guest access
-- to ANY round — the same leak class the #398 lockdown closed for resolve_slot_booking_tier /
-- can_book_slot (a Supabase default-privilege auto-grants EXECUTE to anon/authenticated, so a
-- plain REVOKE FROM PUBLIC is not enough; the named grant must be revoked explicitly).
--
-- Fix: expose only an auth.uid()-based wrapper (no arbitrary-user arg) to clients, and lock
-- the arbitrary-_user_id function to service_role. can_book_slot + enforce_booking_slot_tier
-- call can_book_member_window via SECURITY DEFINER ownership, so they are unaffected.
-- ============================================================================

-- Client-safe wrapper: answers "can the CURRENT user book this round's member window?"
-- using auth.uid() — no way to ask about someone else.
CREATE OR REPLACE FUNCTION public.can_current_user_book_member_window(_cycle_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.can_book_member_window(auth.uid(), _cycle_id);
$$;

REVOKE ALL ON FUNCTION public.can_current_user_book_member_window(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_current_user_book_member_window(uuid) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.can_current_user_book_member_window(uuid) IS
  'Client-safe wrapper: member-window eligibility for the CURRENT user (auth.uid()) — no arbitrary-user arg. Used by filterVisibleSlotIds so visibility matches the server booking tier.';

-- Lock the arbitrary-_user_id function to service_role only (explicit named revoke — see header).
REVOKE EXECUTE ON FUNCTION public.can_book_member_window(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_book_member_window(uuid, uuid) TO service_role;
