-- Add cyclus tracking to availability_slots
ALTER TABLE public.availability_slots 
  ADD COLUMN cyclus_id uuid,
  ADD COLUMN cyclus_name text;

-- Create index for fast cyclus lookups
CREATE INDEX idx_availability_slots_cyclus ON public.availability_slots(cyclus_id) WHERE cyclus_id IS NOT NULL;