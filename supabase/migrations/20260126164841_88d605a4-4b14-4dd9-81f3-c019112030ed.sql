-- ======================================================
-- Auto-Follow and Prospect Tracking for Cycle Registrations
-- ======================================================

-- 1. Create club_followers table
CREATE TABLE public.club_followers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  club_profile_id UUID NOT NULL REFERENCES club_profiles(id) ON DELETE CASCADE,
  notify_new_availability BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, club_profile_id)
);

ALTER TABLE public.club_followers ENABLE ROW LEVEL SECURITY;

-- RLS policies for club_followers
CREATE POLICY "Players can view their club follows"
ON public.club_followers FOR SELECT
USING (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

CREATE POLICY "Players can create club follows"
ON public.club_followers FOR INSERT
WITH CHECK (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

CREATE POLICY "Players can delete club follows"
ON public.club_followers FOR DELETE
USING (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

CREATE POLICY "Club managers can view their followers"
ON public.club_followers FOR SELECT
USING (club_profile_id IN (SELECT get_user_club_ids(auth.uid())));

-- 2. Add status columns to guest_players
ALTER TABLE public.guest_players 
ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual',
ADD COLUMN IF NOT EXISTS has_trained BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN guest_players.source IS 'How they were added: manual, cycle_registration';
COMMENT ON COLUMN guest_players.has_trained IS 'Whether they have completed at least one lesson';

-- 3. Add status columns to club_players
ALTER TABLE public.club_players 
ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual',
ADD COLUMN IF NOT EXISTS has_trained BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN club_players.source IS 'How they were added: manual, cycle_registration';
COMMENT ON COLUMN club_players.has_trained IS 'Whether they have completed at least one lesson';

-- 4. Add RLS policies for cycle registration inserts
CREATE POLICY "Players can register as guest players for trainer cycles"
ON public.guest_players FOR INSERT
WITH CHECK (
  linked_profile_id IN (SELECT id FROM profiles WHERE user_id = auth.uid())
  AND source = 'cycle_registration'
);

CREATE POLICY "Players can register as club players for club cycles"
ON public.club_players FOR INSERT
WITH CHECK (
  linked_profile_id IN (SELECT id FROM profiles WHERE user_id = auth.uid())
  AND source = 'cycle_registration'
);

-- 5. Add unique constraint for club_players to prevent duplicates (partial index)
CREATE UNIQUE INDEX IF NOT EXISTS unique_club_player_email 
ON public.club_players (club_profile_id, email) 
WHERE email IS NOT NULL AND email != '';