-- Public academy pages show ZERO trainers because anon can no longer read
-- public.academy_trainers.
--
-- Root cause (verified): the table's "Public can view active academy trainers"
-- RLS policy has a USING subquery
--     academy_profile_id IN (SELECT id FROM academy_profiles WHERE is_verified AND is_public)
-- which is itself evaluated under the *caller's* RLS. Migration
-- 20260406141343 dropped the anon SELECT policy on the academy_profiles base
-- table ("remove overly permissive public SELECT policies on base tables"), so
-- for anon that subquery now returns the empty set -> the trainers policy is
-- false for every row -> anon sees nothing, platform-wide. (academy_locations
-- still shows because it has a second, subquery-free "club pages" policy.)
--
-- Fix follows the repo convention for anon-readable public data (cf.
-- trainer_profiles_safe / academy_profiles_public / profiles_public): a
-- postgres-owned view whose body runs as the view owner, so its academy_profiles
-- lookup bypasses RLS. It also structurally OMITS the confidential
-- payment_percentage (revenue split) and the internal invited_by column, so no
-- future blanket table grant can re-expose them.
--
-- The WHERE clause reproduces the ORIGINAL public predicate exactly
-- (status='active' AND show_on_academy_page=true AND academy verified+public) so
-- this does not widen the public contract one row beyond the dropped policy.

DROP VIEW IF EXISTS public.academy_trainers_public;

CREATE VIEW public.academy_trainers_public AS
  SELECT
    at.id,
    at.academy_profile_id,
    at.trainer_profile_id,
    at.status,
    at.show_on_academy_page,
    at.joined_at,
    at.created_at,
    at.updated_at
    -- payment_percentage (confidential revenue split) and invited_by intentionally
    -- omitted. Do NOT add payment_percentage to this view.
  FROM public.academy_trainers at
  WHERE at.status = 'active'
    AND at.show_on_academy_page = true
    AND at.academy_profile_id IN (
      SELECT id FROM public.academy_profiles
      WHERE is_verified = true AND is_public = true
    );

ALTER VIEW public.academy_trainers_public OWNER TO postgres;

GRANT SELECT ON public.academy_trainers_public TO anon, authenticated;
