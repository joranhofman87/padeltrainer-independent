-- Add new columns for extended location data from CSV import
ALTER TABLE public.locations
ADD COLUMN IF NOT EXISTS phone text,
ADD COLUMN IF NOT EXISTS email text,
ADD COLUMN IF NOT EXISTS facebook_url text,
ADD COLUMN IF NOT EXISTS instagram_url text,
ADD COLUMN IF NOT EXISTS google_maps_url text,
ADD COLUMN IF NOT EXISTS google_rating numeric,
ADD COLUMN IF NOT EXISTS google_review_count integer,
ADD COLUMN IF NOT EXISTS opening_hours text;

-- Add indexes for performance on large dataset
CREATE INDEX IF NOT EXISTS idx_locations_city ON public.locations(city);
CREATE INDEX IF NOT EXISTS idx_locations_country ON public.locations(country);