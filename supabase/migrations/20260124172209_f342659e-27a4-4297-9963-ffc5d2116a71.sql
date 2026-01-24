-- Add description and logo_url columns to locations table
ALTER TABLE public.locations
ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE public.locations
ADD COLUMN IF NOT EXISTS logo_url text;

-- Add comment for documentation
COMMENT ON COLUMN public.locations.description IS 'Auto-generated or manually set description of the location/club';
COMMENT ON COLUMN public.locations.logo_url IS 'URL to the club logo image';