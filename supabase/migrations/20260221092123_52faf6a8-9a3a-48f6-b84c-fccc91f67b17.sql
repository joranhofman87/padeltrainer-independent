-- Add preferred_language column to profiles
ALTER TABLE public.profiles ADD COLUMN preferred_language TEXT DEFAULT 'nl';

-- Backfill all existing profiles to Dutch
UPDATE public.profiles SET preferred_language = 'nl' WHERE preferred_language IS NULL;