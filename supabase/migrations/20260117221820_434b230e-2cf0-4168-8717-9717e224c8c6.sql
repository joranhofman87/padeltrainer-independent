-- Add is_marked_full column to availability_slots table
ALTER TABLE public.availability_slots
ADD COLUMN is_marked_full BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.availability_slots.is_marked_full IS 'When true, slot is hidden from players/followers even if spots are available (private training)';