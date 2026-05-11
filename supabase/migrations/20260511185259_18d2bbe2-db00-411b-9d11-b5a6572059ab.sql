-- 1. Revoke column-level access to the confidential revenue split
REVOKE SELECT (payment_percentage) ON public.academy_trainers FROM anon, authenticated;

-- 2. Owner-scoped view: academy managers, the trainer themselves, and admins
CREATE OR REPLACE VIEW public.academy_trainers_owner AS
SELECT *
FROM public.academy_trainers
WHERE
  academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
  OR trainer_profile_id IN (
    SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()
  )
  OR public.is_admin(auth.uid());

ALTER VIEW public.academy_trainers_owner OWNER TO postgres;
GRANT SELECT ON public.academy_trainers_owner TO authenticated;