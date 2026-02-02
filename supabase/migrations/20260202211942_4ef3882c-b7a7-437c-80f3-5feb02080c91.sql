-- Add column to track logo fetch attempts
ALTER TABLE public.locations 
ADD COLUMN IF NOT EXISTS logo_fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- Add index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_locations_logo_fetched_at 
ON public.locations(logo_fetched_at) 
WHERE logo_fetched_at IS NULL;