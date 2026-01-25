-- Add column for multiple preferred trainers
ALTER TABLE intake_requests 
ADD COLUMN preferred_trainer_ids uuid[] DEFAULT '{}';

-- Migrate existing single trainer preferences to the array
UPDATE intake_requests 
SET preferred_trainer_ids = ARRAY[preferred_trainer_id]
WHERE preferred_trainer_id IS NOT NULL 
  AND (preferred_trainer_ids IS NULL OR preferred_trainer_ids = '{}');