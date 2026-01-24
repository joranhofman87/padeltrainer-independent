-- Create club_profile_views table for analytics
CREATE TABLE public.club_profile_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_profile_id UUID NOT NULL REFERENCES public.club_profiles(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id TEXT
);

-- Indexes for faster queries
CREATE INDEX idx_club_profile_views_club_id ON public.club_profile_views(club_profile_id);
CREATE INDEX idx_club_profile_views_viewed_at ON public.club_profile_views(viewed_at);

-- Enable RLS
ALTER TABLE public.club_profile_views ENABLE ROW LEVEL SECURITY;

-- Anyone can insert (for tracking views)
CREATE POLICY "Anyone can record club profile views"
  ON public.club_profile_views FOR INSERT
  WITH CHECK (true);

-- Club managers can view their own analytics
CREATE POLICY "Club managers can view their club's profile views"
  ON public.club_profile_views FOR SELECT
  USING (club_profile_id IN (SELECT get_user_club_ids(auth.uid())));

-- Add social media columns to club_profiles
ALTER TABLE public.club_profiles
ADD COLUMN social_instagram TEXT,
ADD COLUMN social_facebook TEXT,
ADD COLUMN social_tiktok TEXT,
ADD COLUMN social_youtube TEXT,
ADD COLUMN social_linkedin TEXT;

-- Update the public view to include social columns
DROP VIEW IF EXISTS public.club_profiles_public;
CREATE VIEW public.club_profiles_public AS
SELECT 
  id, location_id, description, logo_url, banner_url, 
  is_verified, claimed_at, created_at, updated_at,
  subscription_status, subscription_tier,
  social_instagram, social_facebook, social_tiktok, social_youtube, social_linkedin
FROM public.club_profiles
WHERE is_verified = true;