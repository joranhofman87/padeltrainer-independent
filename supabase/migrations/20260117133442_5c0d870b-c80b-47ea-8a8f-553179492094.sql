-- Create table for storing historical player ratings
CREATE TABLE public.player_rating_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rating NUMERIC(4,2) NOT NULL,
  rating_system TEXT NOT NULL DEFAULT 'knltb' CHECK (rating_system IN ('knltb', 'playtomic')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'knltb_scrape')),
  scraped_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add index for efficient queries by player and date
CREATE INDEX idx_rating_history_profile_date ON public.player_rating_history(profile_id, scraped_at DESC);

-- Enable RLS
ALTER TABLE public.player_rating_history ENABLE ROW LEVEL SECURITY;

-- Players can view their own rating history
CREATE POLICY "Players can view their own rating history"
ON public.player_rating_history
FOR SELECT
USING (profile_id IN (SELECT id FROM public.profiles WHERE user_id = auth.uid()));

-- Service role can insert (for edge functions)
CREATE POLICY "Service role can insert rating history"
ON public.player_rating_history
FOR INSERT
WITH CHECK (true);

-- Enable realtime for rating updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.player_rating_history;