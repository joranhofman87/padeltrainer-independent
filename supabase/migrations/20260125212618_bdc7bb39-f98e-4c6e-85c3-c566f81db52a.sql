-- Drop the legacy preferred_trainer_id column (data already uses preferred_trainer_ids array)
ALTER TABLE intake_requests DROP COLUMN IF EXISTS preferred_trainer_id;