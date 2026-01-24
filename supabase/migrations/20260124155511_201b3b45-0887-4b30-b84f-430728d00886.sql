-- Allow club managers to update court counts on their location
CREATE POLICY "Club managers can update their location courts"
ON public.locations
FOR UPDATE
USING (
  id IN (
    SELECT location_id FROM club_profiles 
    WHERE id IN (SELECT get_user_club_ids(auth.uid()))
  )
)
WITH CHECK (
  id IN (
    SELECT location_id FROM club_profiles 
    WHERE id IN (SELECT get_user_club_ids(auth.uid()))
  )
);

-- Create club_tournaments table for upcoming events
CREATE TABLE public.club_tournaments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_profile_id UUID NOT NULL REFERENCES club_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  start_date DATE NOT NULL,
  end_date DATE,
  registration_url TEXT,
  image_url TEXT,
  is_published BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.club_tournaments ENABLE ROW LEVEL SECURITY;

-- Club managers can CRUD their own tournaments
CREATE POLICY "Club managers can view their tournaments"
ON public.club_tournaments
FOR SELECT
USING (club_profile_id IN (SELECT get_user_club_ids(auth.uid())));

CREATE POLICY "Club managers can create tournaments"
ON public.club_tournaments
FOR INSERT
WITH CHECK (club_profile_id IN (SELECT get_user_club_ids(auth.uid())));

CREATE POLICY "Club managers can update their tournaments"
ON public.club_tournaments
FOR UPDATE
USING (club_profile_id IN (SELECT get_user_club_ids(auth.uid())));

CREATE POLICY "Club managers can delete their tournaments"
ON public.club_tournaments
FOR DELETE
USING (club_profile_id IN (SELECT get_user_club_ids(auth.uid())));

-- Public can view published tournaments for verified clubs
CREATE POLICY "Anyone can view published tournaments"
ON public.club_tournaments
FOR SELECT
USING (
  is_published = true 
  AND club_profile_id IN (
    SELECT id FROM club_profiles WHERE is_verified = true
  )
);

-- Create trigger for updated_at
CREATE TRIGGER update_club_tournaments_updated_at
BEFORE UPDATE ON public.club_tournaments
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();