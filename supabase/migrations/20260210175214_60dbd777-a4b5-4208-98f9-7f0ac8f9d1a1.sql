
DROP VIEW IF EXISTS public.trainer_profiles_safe;

CREATE VIEW public.trainer_profiles_safe AS
SELECT id,
    user_id,
    slug,
    hourly_rate,
    CASE
        WHEN (coaching_since_year IS NOT NULL) THEN ((EXTRACT(year FROM CURRENT_DATE))::integer - coaching_since_year)
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
    subscription_status,
    trial_ends_at,
    require_booking_approval,
    use_manual_invoicing,
    waiting_list_enabled,
    created_at,
    updated_at
FROM trainer_profiles;
