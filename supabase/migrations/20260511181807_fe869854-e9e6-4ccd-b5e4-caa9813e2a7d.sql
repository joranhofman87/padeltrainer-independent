-- ============================================================
-- Security hardening batch (items #1–#4 + #7)
-- ============================================================

-- ---------- #1: Lock down first-manager INSERT (academy) ----------
DROP POLICY IF EXISTS "Academy owners can add managers" ON public.academy_managers;
DROP POLICY IF EXISTS "Managers or admins can insert academy managers" ON public.academy_managers;

CREATE POLICY "Owners or admins can insert academy managers"
ON public.academy_managers
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_academy_owner(auth.uid(), academy_profile_id)
  OR public.is_admin(auth.uid())
  OR (
    -- Bootstrap: only the original creator can become first manager
    NOT public.academy_has_managers(academy_profile_id)
    AND EXISTS (
      SELECT 1 FROM public.academy_profiles ap
      WHERE ap.id = academy_profile_id
        AND ap.created_by = auth.uid()
    )
    AND user_id = auth.uid()
  )
);

-- ---------- #1: Lock down first-manager INSERT (club) ----------
DROP POLICY IF EXISTS "Club owners can add managers" ON public.club_managers;
DROP POLICY IF EXISTS "Managers or admins can insert club managers" ON public.club_managers;

CREATE POLICY "Owners or admins can insert club managers"
ON public.club_managers
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_club_owner(auth.uid(), club_profile_id)
  OR public.is_admin(auth.uid())
  OR (
    NOT public.club_has_managers(club_profile_id)
    AND EXISTS (
      SELECT 1 FROM public.club_profiles cp
      WHERE cp.id = club_profile_id
        AND cp.created_by = auth.uid()
    )
    AND user_id = auth.uid()
  )
);

-- ---------- #2 & #7: Revoke OAuth token columns from clients ----------
REVOKE SELECT (access_token, refresh_token, token_expires_at)
  ON public.trainer_mollie_accounts FROM authenticated, anon;
REVOKE SELECT (access_token, refresh_token, token_expires_at)
  ON public.club_mollie_accounts FROM authenticated, anon;
REVOKE SELECT (access_token, refresh_token, token_expires_at)
  ON public.academy_mollie_accounts FROM authenticated, anon;
REVOKE SELECT (access_token, refresh_token, token_expires_at)
  ON public.user_calendar_connections FROM authenticated, anon;

-- Also block UPDATE on token columns from clients (only service role rotates them)
REVOKE UPDATE (access_token, refresh_token, token_expires_at)
  ON public.trainer_mollie_accounts FROM authenticated, anon;
REVOKE UPDATE (access_token, refresh_token, token_expires_at)
  ON public.club_mollie_accounts FROM authenticated, anon;
REVOKE UPDATE (access_token, refresh_token, token_expires_at)
  ON public.academy_mollie_accounts FROM authenticated, anon;
REVOKE UPDATE (access_token, refresh_token, token_expires_at)
  ON public.user_calendar_connections FROM authenticated, anon;

-- ---------- #4: Require trainer/admin role to create orgs ----------
DROP POLICY IF EXISTS "Authenticated users can create academies" ON public.academy_profiles;
CREATE POLICY "Trainers or admins can create academies"
ON public.academy_profiles
FOR INSERT
TO authenticated
WITH CHECK (
  created_by = auth.uid()
  AND (
    public.has_role(auth.uid(), 'trainer'::app_role)
    OR public.is_admin(auth.uid())
  )
);

DROP POLICY IF EXISTS "Authenticated users can create club profiles" ON public.club_profiles;
CREATE POLICY "Trainers or admins can create club profiles"
ON public.club_profiles
FOR INSERT
TO authenticated
WITH CHECK (
  created_by = auth.uid()
  AND (
    public.has_role(auth.uid(), 'trainer'::app_role)
    OR public.is_admin(auth.uid())
  )
);
