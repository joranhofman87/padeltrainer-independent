-- ============================================================================
-- FIX: academy managers could not CREATE guest players — INSERT ... RETURNING
--      (PostgREST `?select=*`) was rejected with 42501 for EVERY academy manager.
-- ============================================================================
--
-- Root cause: the P2-2 migration (20260706130100_p2_2_guest_players_academy_scope)
-- narrowed the academy-manager SELECT policy to
--     USING (guest_belongs_to_user_academy(id, auth.uid()))
-- That SECURITY DEFINER function determines membership by RE-READING guest_players
-- BY id (`... FROM guest_players gp WHERE gp.id = _guest_id ...`).
--
-- The app inserts guests with `.insert({...}).select()` → `INSERT ... RETURNING *`.
-- PostgreSQL applies the SELECT policy to the RETURNING output, but during that
-- check the just-inserted row is NOT yet visible to the function's own nested
-- SELECT, so guest_belongs_to_user_academy() returns false and the executor
-- rejects the row: "new row violates row-level security policy for table
-- guest_players" (ExecWithCheckOptions). The plain INSERT WITH CHECK passes fine —
-- only the RETURNING/SELECT step fails — which is why guests could still be READ
-- but never CREATED, on every academy account, since 2026-07-06.
--
-- Fix: OR the row's OWN academy_profile_id column check back into the SELECT policy.
-- That branch is evaluable directly on the NEW row during RETURNING (no self-lookup)
-- and is IDENTICAL to branch (a) already inside guest_belongs_to_user_academy — so it
-- does NOT widen visibility. The cross-relationship branches (booking on the academy's
-- slot; academy_player_metadata link) stay behind the function. Tenant isolation (the
-- shared-trainer roster leak P2-2 closed) is preserved: a manager still only sees /
-- creates guests whose academy_profile_id is in their own get_user_academy_ids set.
--
-- Owner-applied (migrations are not auto-deployed).
-- ============================================================================

DROP POLICY IF EXISTS "Academy managers can view related academy guest players" ON public.guest_players;
CREATE POLICY "Academy managers can view related academy guest players"
ON public.guest_players FOR SELECT
TO authenticated
USING (
  -- (a) own-academy guest — checked on the row's OWN column so INSERT ... RETURNING works
  (academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid())))
  -- (b) booking on a caller-academy slot, or (c) academy_player_metadata link
  OR public.guest_belongs_to_user_academy(id, auth.uid())
);
