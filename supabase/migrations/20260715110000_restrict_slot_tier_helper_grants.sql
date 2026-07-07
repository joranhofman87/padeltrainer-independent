-- ============================================================================
-- Restrict resolve_slot_booking_tier + can_book_slot to service_role ONLY
-- ============================================================================
-- 20260715100000 created these two helpers intending them to be service-role only
-- (they take an arbitrary _user_id, so an anon/authenticated caller could enumerate
-- whether ANY user has claim/member access to ANY slot). It used
-- `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO service_role;` — but that is NOT
-- sufficient on Supabase: the project runs
--   ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon, authenticated
-- for the function owner, so a NEWLY CREATED function is auto-granted EXECUTE to anon
-- and authenticated BY NAME. `REVOKE ... FROM PUBLIC` does not remove those named
-- grants, so both functions ended up callable by anon/authenticated in production
-- (confirmed with an anon-key probe: can_book_slot returned a result, not a permission
-- error). This closes that leak by revoking the named grants explicitly.
--
-- Safe: the enforce_booking_slot_tier trigger and book_slot_for_payment call these via
-- SECURITY DEFINER ownership (unaffected by role grants), and the create-mollie-payment
-- edge pre-check calls can_book_slot as service_role. book_slot_for_payment itself was
-- CREATE OR REPLACE'd (existing service_role-only grant preserved) so it never leaked.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.resolve_slot_booking_tier(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.can_book_slot(uuid, uuid)        FROM PUBLIC, anon, authenticated;

-- Re-affirm the intended grant (idempotent).
GRANT EXECUTE ON FUNCTION public.resolve_slot_booking_tier(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.can_book_slot(uuid, uuid)        TO service_role;
