ALTER TABLE public.guest_players
  ADD COLUMN IF NOT EXISTS preferred_location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_guest_players_preferred_location ON public.guest_players(preferred_location_id);