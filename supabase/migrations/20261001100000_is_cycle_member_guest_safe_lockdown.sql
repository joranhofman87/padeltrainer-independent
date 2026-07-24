-- Auth-hardening (task #30): make public.is_cycle_member(uuid, uuid) guest-safe and lock it down.
--
-- BEFORE this migration is_cycle_member had TWO defects (confirmed against the LIVE prod catalog, not
-- just migration history):
--   1. ORACLE: it was never granted/revoked, so it kept PostgreSQL's default PUBLIC EXECUTE — callable
--      by anon + authenticated. Being SECURITY DEFINER (bypasses bookings/slots RLS) with an arbitrary
--      caller-supplied _user_id, any client could probe "does user X have a booking in cycle Y?" for
--      ANY X/Y — leaking other users' per-cycle booking existence.
--   2. NOT GUEST-SAFE (FAM-02): it matched membership on the RAW bookings.player_id only. On a dual-key
--      booking (player_id = captain/parent, guest_player_id = the actual guest) it granted the raw
--      parent — who is not the person in that seat — and never the guest or the guest's verified account.
--
-- The live caller audit (pg_proc bodies + pg_policies, 2026-07-24) found ZERO live callers: no SQL
-- function calls it (the only can_book_member_window match is a deferral COMMENT — 20260928100000
-- inlined its own guest-safe clause and removed the call), no RLS policy uses it, and the sole client
-- reference (the priorityClaims.ts isCycleMember() helper) was dead + is deleted in this PR. So this is
-- security cleanup + defense-in-depth with no behavioral impact on any live path.
--
-- Fix: redefine membership with the SAME guest-safe identity rule as can_book_member_window clause (a)
-- (20260928100000) — reuse guest_verified_account_profile(), which already encodes person_links
-- precedence -> twin -> linked with split-freeze — and lock EXECUTE to service_role only. Per the owner:
-- NO auth.uid() wrapper is added (there is no active client workflow that needs one; add one only when a
-- caller requires it). Same 2-arg signature -> no generated-types drift.
CREATE OR REPLACE FUNCTION public.is_cycle_member(_user_id uuid, _cycle_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (SELECT id FROM public.profiles WHERE user_id = _user_id)
  SELECT EXISTS (
    SELECT 1
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    WHERE s.cyclus_id = _cycle_id
      AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
      AND (
        -- pure-profile booking owned by me
        (b.guest_player_id IS NULL AND b.player_id = (SELECT id FROM me))
        -- guest booking whose VERIFIED account (person_links -> twin -> linked, split-freeze) is me;
        -- the raw player_id on a dual-key booking is NOT identity proof.
        OR (b.guest_player_id IS NOT NULL
            AND public.guest_verified_account_profile(b.guest_player_id) = (SELECT id FROM me))
      )
  );
$$;

-- Close the oracle: service_role only. A bare REVOKE FROM PUBLIC is insufficient under this project's
-- default privileges (which GRANT EXECUTE to anon/authenticated), so revoke the named roles explicitly.
REVOKE ALL ON FUNCTION public.is_cycle_member(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_cycle_member(uuid, uuid) TO service_role;
