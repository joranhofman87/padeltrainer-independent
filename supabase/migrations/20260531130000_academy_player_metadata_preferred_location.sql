-- Academy-scoped preferred club for registered players (real locations.id only).
ALTER TABLE public.academy_player_metadata
  ADD COLUMN IF NOT EXISTS preferred_location_id uuid
  REFERENCES public.locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_academy_player_metadata_preferred_location
  ON public.academy_player_metadata(preferred_location_id)
  WHERE preferred_location_id IS NOT NULL;

COMMENT ON COLUMN public.academy_player_metadata.preferred_location_id IS
  'Academy-scoped preferred padel club (locations.id). Not training history.';
