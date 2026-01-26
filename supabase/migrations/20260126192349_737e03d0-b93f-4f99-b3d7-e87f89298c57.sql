-- Change lesson_type from TEXT to TEXT[] to allow multi-select
-- First, drop the existing check constraint
ALTER TABLE public.intake_requests DROP CONSTRAINT IF EXISTS intake_requests_lesson_type_check;

-- Change the column type from TEXT to TEXT[]
ALTER TABLE public.intake_requests 
ALTER COLUMN lesson_type TYPE TEXT[] 
USING ARRAY[lesson_type];

-- Add a new check constraint to ensure all values in the array are valid
ALTER TABLE public.intake_requests 
ADD CONSTRAINT intake_requests_lesson_types_check 
CHECK (lesson_type <@ ARRAY['private', 'duo', 'group', 'kids']::TEXT[]);