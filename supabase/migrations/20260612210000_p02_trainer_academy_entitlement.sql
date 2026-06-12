-- P-02: academy entitlement for managed trainers.
-- Product decision: a trainer with an active academy_trainers membership is covered by
-- that academy's subscription INCLUDING its trial period; only independent trainers
-- need a personal subscription. Redefine trainer_profiles_safe so the computed
-- is_active_subscription also counts academy entitlement.
-- Base definition: 20260406141426 (latest); all other columns kept byte-identical.
DROP VIEW IF EXISTS public.trainer_profiles_safe;
CREATE VIEW public.trainer_profiles_safe AS
  SELECT
    id,
    user_id,
    slug,
    hourly_rate,
    CASE
      WHEN coaching_since_year IS NOT NULL THEN (EXTRACT(year FROM CURRENT_DATE))::integer - coaching_since_year
      ELSE experience_years
    END AS experience_years,
    certifications,
    specializations,
    is_verified,
    knltb_rating,
    trainer_rating_system,
    coaching_method,
    favourite_quote,
    video_url,
    website_url,
    social_instagram,
    social_tiktok,
    social_youtube,
    social_linkedin,
    preferred_min_rating,
    preferred_max_rating,
    preferred_rating_system,
    is_public,
    slot_duration_minutes,
    schedule_weeks_ahead,
    require_booking_approval,
    use_manual_invoicing,
    waiting_list_enabled,
    welcome_message,
    general_terms,
    created_at,
    updated_at,
    -- Computed: hides raw subscription_status and trial_ends_at.
    -- Own entitlement OR coverage via an actively-subscribed (or trialing) academy.
    (
      subscription_status = 'active'
      OR (trial_ends_at IS NOT NULL AND trial_ends_at > now())
      OR EXISTS (
        SELECT 1
        FROM public.academy_trainers atr
        JOIN public.academy_profiles ap ON ap.id = atr.academy_profile_id
        WHERE atr.trainer_profile_id = tp.id
          AND atr.status = 'active'
          AND (ap.subscription_status = 'active' OR (ap.trial_ends_at IS NOT NULL AND ap.trial_ends_at > now()))
      )
    ) AS is_active_subscription
  FROM public.trainer_profiles tp;

GRANT SELECT ON public.trainer_profiles_safe TO anon, authenticated;
