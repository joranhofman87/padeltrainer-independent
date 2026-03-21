
ALTER TABLE public.intake_requests DROP CONSTRAINT IF EXISTS intake_requests_lesson_types_check;
ALTER TABLE public.intake_requests 
ADD CONSTRAINT intake_requests_lesson_types_check 
CHECK (lesson_type <@ ARRAY['private', 'duo', 'group', 'group3', 'group4', 'kids']::TEXT[]);
