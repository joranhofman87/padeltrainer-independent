-- Per-trainer public-page banner.
--
-- Until now a trainer's public page had NO banner of its own: TrainerProfile.tsx borrows
-- the trainer's academy banner (academy_profiles.banner_url) and independent trainers get
-- none. This adds trainer_profiles.banner_url; the public page prefers it and falls back
-- to the academy banner, so existing pages look identical until someone uploads one.
--
-- Permissions need NO changes (verified against current policies):
--   * trainer_profiles UPDATE: trainer-self (20260115184937), academy managers of active
--     trainers (20260202092947), club managers (20260121221331), admins — none are
--     column-restricted, so all may write banner_url.
--   * Column grants: the 20260511183528 REVOKE is per-column (iban/bic/...); a new column
--     inherits the table-level SELECT/UPDATE grants.
--   * Storage: banners upload to the existing avatars bucket under {trainer_user_id}/…,
--     covered for self (20260118100847), academy managers (20260404145156) and club
--     managers (20260121221252) — the path policies constrain only the first folder.
--
-- trainer_profiles_safe is recreated to expose banner_url (base: 20260612210000, all other
-- columns byte-identical). The frontend reads the view with select('*'), so pre-migration
-- frontends simply see no banner_url and fall back to the academy banner — order-free.

ALTER TABLE public.trainer_profiles ADD COLUMN IF NOT EXISTS banner_url text;

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
    banner_url,
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
