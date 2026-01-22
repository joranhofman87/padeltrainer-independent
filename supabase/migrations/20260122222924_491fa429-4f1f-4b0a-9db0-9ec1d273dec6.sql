-- Add location_id column to availability_slots table
ALTER TABLE public.availability_slots 
ADD COLUMN location_id uuid REFERENCES public.locations(id);

-- Create index for better query performance
CREATE INDEX idx_availability_slots_location_id ON public.availability_slots(location_id);

-- Add comment explaining the column
COMMENT ON COLUMN public.availability_slots.location_id IS 'The location where this slot/training takes place. Replaces the location field on lessons.';