-- Add latitude and longitude columns to locations table
ALTER TABLE public.locations
ADD COLUMN latitude NUMERIC(10, 7),
ADD COLUMN longitude NUMERIC(10, 7);

-- Add index for spatial queries (useful for future "nearby clubs" feature)
CREATE INDEX idx_locations_coordinates ON public.locations (latitude, longitude)
WHERE latitude IS NOT NULL AND longitude IS NOT NULL;