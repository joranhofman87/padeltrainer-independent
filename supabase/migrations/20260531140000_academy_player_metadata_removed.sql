-- Academy-scoped soft removal: hide player from active overview without deleting global data.
ALTER TABLE public.academy_player_metadata
  ADD COLUMN IF NOT EXISTS removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS removed_by uuid,
  ADD COLUMN IF NOT EXISTS remove_reason text;

CREATE INDEX IF NOT EXISTS idx_academy_player_metadata_removed_at
  ON public.academy_player_metadata(academy_profile_id, removed_at)
  WHERE removed_at IS NOT NULL;

COMMENT ON COLUMN public.academy_player_metadata.removed_at IS
  'When set, player is hidden from active academy players overview. Does not delete bookings/invoices/profiles.';
COMMENT ON COLUMN public.academy_player_metadata.removed_by IS
  'Optional profiles.id of academy manager who removed the player from this academy.';
COMMENT ON COLUMN public.academy_player_metadata.remove_reason IS
  'Optional free-text reason for academy-scoped removal.';
