ALTER TABLE public.availability_slots
  ADD COLUMN is_public boolean NOT NULL DEFAULT true;