-- Add number_of_courts to locations table
ALTER TABLE public.locations 
ADD COLUMN number_of_courts integer DEFAULT NULL;

-- Add banner_url to club_profiles table for club customization
ALTER TABLE public.club_profiles 
ADD COLUMN banner_url text DEFAULT NULL;

-- Add index for faster lookups on claimed locations
CREATE INDEX IF NOT EXISTS idx_club_profiles_location_id ON public.club_profiles(location_id);