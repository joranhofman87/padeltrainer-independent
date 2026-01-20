-- Add 'club_manager' to the app_role enum
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'club_manager';

-- Create club_profiles table (one per location when claimed)
CREATE TABLE public.club_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL UNIQUE REFERENCES public.locations(id) ON DELETE CASCADE,
  description TEXT,
  contact_email TEXT,
  phone TEXT,
  logo_url TEXT,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  claimed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create club_managers table (multiple managers per club)
CREATE TABLE public.club_managers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_profile_id UUID NOT NULL REFERENCES public.club_profiles(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('owner', 'manager')),
  invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (club_profile_id, user_id)
);

-- Add relationship_type to trainer_locations
ALTER TABLE public.trainer_locations 
ADD COLUMN relationship_type TEXT NOT NULL DEFAULT 'independent' 
CHECK (relationship_type IN ('independent', 'club_trainer'));

-- Create club_players table (players managed by the club)
CREATE TABLE public.club_players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_profile_id UUID NOT NULL REFERENCES public.club_profiles(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  skill_rating NUMERIC,
  rating_system TEXT NOT NULL DEFAULT 'knltb',
  notes TEXT,
  linked_profile_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on all new tables
ALTER TABLE public.club_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_managers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_players ENABLE ROW LEVEL SECURITY;

-- Create helper function to check if user is a club manager
CREATE OR REPLACE FUNCTION public.is_club_manager(_user_id UUID, _club_profile_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.club_managers
    WHERE user_id = _user_id
      AND club_profile_id = _club_profile_id
  )
$$;

-- Create helper function to check if user is any club manager
CREATE OR REPLACE FUNCTION public.is_any_club_manager(_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.club_managers
    WHERE user_id = _user_id
  )
$$;

-- Create helper function to get user's club profile ids
CREATE OR REPLACE FUNCTION public.get_user_club_ids(_user_id UUID)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT club_profile_id
  FROM public.club_managers
  WHERE user_id = _user_id
$$;

-- RLS Policies for club_profiles
CREATE POLICY "Anyone can view verified club profiles"
ON public.club_profiles
FOR SELECT
USING (is_verified = true);

CREATE POLICY "Club managers can view their own club profile"
ON public.club_profiles
FOR SELECT
USING (id IN (SELECT public.get_user_club_ids(auth.uid())));

CREATE POLICY "Admins can view all club profiles"
ON public.club_profiles
FOR SELECT
USING (public.is_admin(auth.uid()));

CREATE POLICY "Authenticated users can create club profiles (claims)"
ON public.club_profiles
FOR INSERT
WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Club managers can update their own club profile"
ON public.club_profiles
FOR UPDATE
USING (id IN (SELECT public.get_user_club_ids(auth.uid())));

CREATE POLICY "Admins can update any club profile"
ON public.club_profiles
FOR UPDATE
USING (public.is_admin(auth.uid()));

-- RLS Policies for club_managers
CREATE POLICY "Club managers can view their club's managers"
ON public.club_managers
FOR SELECT
USING (club_profile_id IN (SELECT public.get_user_club_ids(auth.uid())));

CREATE POLICY "Admins can view all club managers"
ON public.club_managers
FOR SELECT
USING (public.is_admin(auth.uid()));

CREATE POLICY "Club owners can manage club managers"
ON public.club_managers
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.club_managers cm
    WHERE cm.club_profile_id = club_profile_id
      AND cm.user_id = auth.uid()
      AND cm.role = 'owner'
  )
  OR NOT EXISTS (
    SELECT 1 FROM public.club_managers cm
    WHERE cm.club_profile_id = club_profile_id
  )
);

CREATE POLICY "Club owners can update club managers"
ON public.club_managers
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.club_managers cm
    WHERE cm.club_profile_id = club_managers.club_profile_id
      AND cm.user_id = auth.uid()
      AND cm.role = 'owner'
  )
);

CREATE POLICY "Club owners can delete club managers"
ON public.club_managers
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM public.club_managers cm
    WHERE cm.club_profile_id = club_managers.club_profile_id
      AND cm.user_id = auth.uid()
      AND cm.role = 'owner'
  )
);

-- RLS Policies for club_players
CREATE POLICY "Club managers can view their club's players"
ON public.club_players
FOR SELECT
USING (club_profile_id IN (SELECT public.get_user_club_ids(auth.uid())));

CREATE POLICY "Club managers can create players for their club"
ON public.club_players
FOR INSERT
WITH CHECK (club_profile_id IN (SELECT public.get_user_club_ids(auth.uid())));

CREATE POLICY "Club managers can update their club's players"
ON public.club_players
FOR UPDATE
USING (club_profile_id IN (SELECT public.get_user_club_ids(auth.uid())));

CREATE POLICY "Club managers can delete their club's players"
ON public.club_players
FOR DELETE
USING (club_profile_id IN (SELECT public.get_user_club_ids(auth.uid())));

-- Add updated_at triggers
CREATE TRIGGER update_club_profiles_updated_at
BEFORE UPDATE ON public.club_profiles
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_club_players_updated_at
BEFORE UPDATE ON public.club_players
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();