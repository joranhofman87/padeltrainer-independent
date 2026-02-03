-- Add flat fee column to subscription_plans
ALTER TABLE subscription_plans 
ADD COLUMN IF NOT EXISTS platform_fee_flat NUMERIC(6,2) DEFAULT 1.00;

-- Set tiered values for existing plans
UPDATE subscription_plans SET platform_fee_flat = 1.00 WHERE tier = 'starter' OR tier = 'trial';
UPDATE subscription_plans SET platform_fee_flat = 0.75 WHERE tier = 'professional';
UPDATE subscription_plans SET platform_fee_flat = 0.50 WHERE tier = 'academy';

-- Add override column to trainer_profiles
ALTER TABLE trainer_profiles 
ADD COLUMN IF NOT EXISTS platform_fee_override NUMERIC(6,2) DEFAULT NULL;

COMMENT ON COLUMN trainer_profiles.platform_fee_override IS 
  'Custom platform fee for this trainer. If NULL, uses tier default.';

-- Add override column to academy_profiles
ALTER TABLE academy_profiles 
ADD COLUMN IF NOT EXISTS platform_fee_override NUMERIC(6,2) DEFAULT NULL;

COMMENT ON COLUMN academy_profiles.platform_fee_override IS 
  'Custom platform fee for this academy. If NULL, uses tier default.';