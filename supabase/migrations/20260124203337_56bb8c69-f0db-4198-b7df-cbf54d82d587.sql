-- Add show_on_club_page column to trainer_locations table
ALTER TABLE public.trainer_locations
ADD COLUMN show_on_club_page BOOLEAN NOT NULL DEFAULT false;

-- Comment for clarity
COMMENT ON COLUMN public.trainer_locations.show_on_club_page IS 'Controls whether this trainer appears on the public club page';