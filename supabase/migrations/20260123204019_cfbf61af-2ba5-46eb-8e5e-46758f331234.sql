-- Add visibility and trial columns to trainer_profiles
ALTER TABLE trainer_profiles ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT false;
ALTER TABLE trainer_profiles ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE trainer_profiles ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP WITH TIME ZONE;

-- Set trial dates for existing trainers based on their creation date
UPDATE trainer_profiles 
SET 
  trial_started_at = created_at,
  trial_ends_at = created_at + INTERVAL '7 days',
  subscription_status = CASE 
    WHEN subscription_status = 'active' THEN 'active'
    ELSE 'trial'
  END
WHERE trial_started_at IS NULL;

-- Update the Starter plan to inactive in subscription_plans
UPDATE subscription_plans 
SET is_active = false 
WHERE tier = 'starter';

-- Create index for efficient public trainer queries
CREATE INDEX IF NOT EXISTS idx_trainer_profiles_public_visibility 
ON trainer_profiles (is_public, subscription_status, trial_ends_at) 
WHERE is_public = true;