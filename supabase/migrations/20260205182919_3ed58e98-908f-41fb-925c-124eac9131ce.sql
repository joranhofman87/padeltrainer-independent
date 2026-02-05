-- Add location_id column to partner_banners for targeting specific locations (clubs)
ALTER TABLE public.partner_banners 
ADD COLUMN location_id UUID REFERENCES public.locations(id) ON DELETE SET NULL;

-- Create index for faster lookups
CREATE INDEX idx_partner_banners_location_id ON public.partner_banners(location_id);

-- Add comment explaining the column
COMMENT ON COLUMN public.partner_banners.location_id IS 'Optional location to target this banner to. If set, banner only shows on this location page.';