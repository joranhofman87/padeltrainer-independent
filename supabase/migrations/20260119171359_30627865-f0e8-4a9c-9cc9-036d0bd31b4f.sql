-- Create table for tracking anonymous profile views
CREATE TABLE public.trainer_profile_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id UUID NOT NULL REFERENCES trainer_profiles(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id TEXT -- For deduping multiple views in same session
);

-- Indexes for efficient queries
CREATE INDEX idx_profile_views_trainer ON public.trainer_profile_views(trainer_id);
CREATE INDEX idx_profile_views_date ON public.trainer_profile_views(viewed_at);

-- Enable RLS
ALTER TABLE public.trainer_profile_views ENABLE ROW LEVEL SECURITY;

-- Anyone can insert views (anonymous tracking)
CREATE POLICY "Anyone can insert profile views"
ON public.trainer_profile_views
FOR INSERT
WITH CHECK (true);

-- Trainers can view their own profile views
CREATE POLICY "Trainers can view their own profile views"
ON public.trainer_profile_views
FOR SELECT
USING (trainer_id IN (
  SELECT id FROM trainer_profiles WHERE user_id = auth.uid()
));