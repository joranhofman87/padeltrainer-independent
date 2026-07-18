-- Public trainer marketplace directory — bounded, server-side.
--
-- The /trainers page used to fetch EVERY public trainer (+ their profiles,
-- ratings, locations, availability) and then filter/sort/paginate in React —
-- an unbounded load that will not survive thousands of trainers. This migration
-- moves the directory to two locked-down, public-safe RPCs:
--
--   * search_public_trainers(...)  → ONE page of trainer cards + total_count.
--   * get_public_trainer_directory_facets() → the distinct filter options
--     (locations / specializations / certifications) as a bounded aggregate.
--
-- Entitlement + privacy are inherited from the audited views: trainer_profiles_safe
-- already computes is_active_subscription (own subscription/trial OR active-academy
-- coverage) and hides raw subscription_status/trial dates; profiles_public exposes
-- only public-safe identity fields. Neither RPC returns email, phone, user_id,
-- subscription internals, or any private profile column.

-- Directory review aggregate hits reviews by trainer, public reviews only.
CREATE INDEX IF NOT EXISTS idx_reviews_trainer_public
  ON public.reviews (trainer_id) WHERE is_public = true;

-- ---------------------------------------------------------------------------
-- search_public_trainers — one bounded page of directory cards + total_count.
-- Mirrors the exact filter/sort semantics the client used to compute locally.
CREATE OR REPLACE FUNCTION public.search_public_trainers(
  p_search             text    DEFAULT NULL,
  p_location_id        uuid    DEFAULT NULL,
  p_min_rating         numeric DEFAULT 0,       -- min AVERAGE public-review rating
  p_min_experience     int     DEFAULT 0,
  p_specializations    text[]  DEFAULT NULL,     -- match ANY (overlap)
  p_certifications     text[]  DEFAULT NULL,     -- match ANY (overlap)
  p_verified           boolean DEFAULT false,
  p_rating_system      text    DEFAULT NULL,     -- the trainer's own rating system
  p_min_trainer_rating numeric DEFAULT 0,        -- their skill in that system
  p_has_availability   boolean DEFAULT false,
  p_sort               text    DEFAULT 'rating', -- 'rating' | 'experience'
  p_page               int     DEFAULT 1,
  p_page_size          int     DEFAULT 48
)
RETURNS TABLE (
  trainer_profile_id uuid,
  slug               text,
  full_name          text,
  avatar_url         text,
  bio                text,
  location           text,
  experience_years   int,
  certifications     text[],
  specializations    text[],
  is_verified        boolean,
  average_rating     numeric,
  review_count       int,
  has_availability   boolean,
  total_count        bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH params AS (
    SELECT
      NULLIF(btrim(COALESCE(p_search, '')), '')                       AS q,
      LEAST(GREATEST(COALESCE(p_page_size, 48), 1), 100)             AS page_size,
      GREATEST(COALESCE(p_page, 1), 1)                               AS page,
      (SELECT lower_is_better FROM public.rating_systems WHERE code = p_rating_system) AS lower_is_better
  ),
  filtered AS (
    SELECT
      tp.id,
      tp.slug,
      pr.full_name,
      pr.avatar_url,
      pr.bio,
      pr.location,
      tp.experience_years,
      tp.certifications,
      tp.specializations,
      tp.is_verified,
      COALESCE(rv.avg_rating, 0)::numeric AS average_rating,
      COALESCE(rv.cnt, 0)::int            AS review_count,
      EXISTS (
        SELECT 1 FROM public.availability_slots av
        WHERE av.trainer_id = tp.id AND av.is_public = true AND av.start_time > now()
      )                                   AS has_availability
    FROM public.trainer_profiles_safe tp
    JOIN public.profiles_public pr ON pr.user_id = tp.user_id
    CROSS JOIN params
    LEFT JOIN LATERAL (
      SELECT avg(r.rating)::numeric AS avg_rating, count(*)::int AS cnt
      FROM public.reviews r
      WHERE r.trainer_id = tp.id AND r.is_public = true
    ) rv ON true
    WHERE tp.is_public = true
      AND tp.is_active_subscription = true
      -- free-text search: name / bio / any specialization
      AND (params.q IS NULL OR (
              pr.full_name ILIKE '%' || params.q || '%'
           OR pr.bio       ILIKE '%' || params.q || '%'
           OR EXISTS (SELECT 1 FROM unnest(tp.specializations) s WHERE s ILIKE '%' || params.q || '%')
      ))
      -- location
      AND (p_location_id IS NULL OR EXISTS (
              SELECT 1 FROM public.trainer_locations tl
              WHERE tl.trainer_id = tp.id AND tl.location_id = p_location_id))
      -- experience
      AND COALESCE(tp.experience_years, 0) >= COALESCE(p_min_experience, 0)
      -- specializations / certifications: ANY match (array overlap)
      AND (p_specializations IS NULL OR array_length(p_specializations, 1) IS NULL OR tp.specializations && p_specializations)
      AND (p_certifications  IS NULL OR array_length(p_certifications, 1)  IS NULL OR tp.certifications  && p_certifications)
      -- verified
      AND (NOT p_verified OR tp.is_verified = true)
      -- has future public availability
      AND (NOT p_has_availability OR EXISTS (
              SELECT 1 FROM public.availability_slots av
              WHERE av.trainer_id = tp.id AND av.is_public = true AND av.start_time > now()))
      -- trainer's own rating system + skill threshold (mirrors the client's
      -- lower_is_better handling: e.g. KNLTB lower = better)
      AND (
        p_rating_system IS NULL OR p_rating_system = ''
        OR (
          pr.rating_system = p_rating_system
          AND (
            COALESCE(p_min_trainer_rating, 0) = 0
            OR CASE WHEN params.lower_is_better
                 THEN COALESCE(pr.skill_rating, 0) > 0 AND pr.skill_rating <= p_min_trainer_rating
                 ELSE COALESCE(pr.skill_rating, 0) >= p_min_trainer_rating
               END
          )
        )
      )
  ),
  rated AS (
    SELECT * FROM filtered
    WHERE average_rating >= COALESCE(p_min_rating, 0)
  ),
  counted AS (
    SELECT *, count(*) OVER () AS total_count FROM rated
  )
  SELECT
    id, slug, full_name, avatar_url, bio, location, experience_years,
    certifications, specializations, is_verified, average_rating, review_count,
    has_availability, total_count
  FROM counted
  ORDER BY
    (CASE WHEN p_sort = 'experience' THEN COALESCE(experience_years, 0) END) DESC NULLS LAST,
    (CASE WHEN p_sort <> 'experience' THEN average_rating END)               DESC NULLS LAST,
    (CASE WHEN p_sort <> 'experience' THEN review_count END)                 DESC NULLS LAST,
    full_name ASC NULLS LAST,
    id ASC
  LIMIT  (SELECT page_size FROM params)
  OFFSET ((SELECT page FROM params) - 1) * (SELECT page_size FROM params);
$$;

-- ---------------------------------------------------------------------------
-- Filter options for the directory — distinct across the SAME entitled+public
-- set, as a single bounded aggregate (never a per-trainer scan on the client).
CREATE OR REPLACE FUNCTION public.get_public_trainer_directory_facets()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH entitled AS (
    SELECT tp.id, tp.specializations, tp.certifications
    FROM public.trainer_profiles_safe tp
    WHERE tp.is_public = true AND tp.is_active_subscription = true
  )
  SELECT jsonb_build_object(
    'locations', COALESCE((
      SELECT jsonb_agg(DISTINCT jsonb_build_object(
               'id', l.id, 'name', l.name, 'city', l.city, 'country', l.country, 'slug', l.slug))
      FROM public.trainer_locations tl
      JOIN entitled e   ON e.id = tl.trainer_id
      JOIN public.locations l ON l.id = tl.location_id
    ), '[]'::jsonb),
    'specializations', COALESCE((
      SELECT jsonb_agg(DISTINCT s ORDER BY s)
      FROM entitled e, unnest(e.specializations) s WHERE s IS NOT NULL AND s <> ''
    ), '[]'::jsonb),
    'certifications', COALESCE((
      SELECT jsonb_agg(DISTINCT c ORDER BY c)
      FROM entitled e, unnest(e.certifications) c WHERE c IS NOT NULL AND c <> ''
    ), '[]'::jsonb)
  );
$$;

-- Public directory: readable by anon + authenticated, nothing else.
REVOKE ALL ON FUNCTION public.search_public_trainers(text, uuid, numeric, int, text[], text[], boolean, text, numeric, boolean, text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_public_trainers(text, uuid, numeric, int, text[], text[], boolean, text, numeric, boolean, text, int, int) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_public_trainer_directory_facets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_trainer_directory_facets() TO anon, authenticated;
