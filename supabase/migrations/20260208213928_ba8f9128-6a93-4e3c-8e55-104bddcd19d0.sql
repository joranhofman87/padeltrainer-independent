-- Add optional training level to availability slots
ALTER TABLE public.availability_slots
ADD COLUMN training_level text DEFAULT NULL;

-- Add comment for clarity
COMMENT ON COLUMN public.availability_slots.training_level IS 'Optional training level: beginner, intermediate, advanced, or null for any level';