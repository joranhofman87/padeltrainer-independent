
-- Update the relationship_type check constraint to include 'academy_trainer'
ALTER TABLE public.trainer_locations DROP CONSTRAINT trainer_locations_relationship_type_check;
ALTER TABLE public.trainer_locations ADD CONSTRAINT trainer_locations_relationship_type_check 
  CHECK (relationship_type = ANY (ARRAY['independent'::text, 'club_trainer'::text, 'academy_trainer'::text]));
