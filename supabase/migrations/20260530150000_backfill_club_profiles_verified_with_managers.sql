-- Phase 1: Activate existing club claims that already have a manager (no admin approval gate).
-- Conservative: only clubs with at least one club_managers row are marked verified.

UPDATE public.club_profiles cp
SET is_verified = true
WHERE cp.is_verified = false
  AND EXISTS (
    SELECT 1
    FROM public.club_managers cm
    WHERE cm.club_profile_id = cp.id
  );
