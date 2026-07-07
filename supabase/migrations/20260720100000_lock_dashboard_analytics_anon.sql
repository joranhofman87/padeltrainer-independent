-- ============================================================================
-- Lock the dashboard analytics RPCs to authenticated (revoke the anon grant)
-- ============================================================================
-- get_academy_dashboard_analytics / get_trainer_dashboard_analytics (20260719100000) are
-- guard-protected — they return NULL for a non-manager / a caller with no trainer profile,
-- so an anon caller already only ever gets NULL (no data leak). But Supabase's default
-- privilege auto-grants EXECUTE on newly-created functions to anon/authenticated BY NAME, so
-- the `REVOKE ALL ... FROM PUBLIC` in that migration left them anon-CALLABLE (confirmed by an
-- anon-key probe: HTTP 200 null). These are authenticated-dashboard RPCs — revoke the named
-- anon grant so they aren't callable by anon at all (matches the resolve_slot_booking_tier /
-- can_book_member_window lockdowns). authenticated + service_role keep their grants.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.get_academy_dashboard_analytics(uuid, int) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_trainer_dashboard_analytics(int) FROM anon;
