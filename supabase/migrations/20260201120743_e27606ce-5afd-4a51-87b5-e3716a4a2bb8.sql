-- Drop existing check constraint and recreate with awaiting_confirmation status
ALTER TABLE onboarding_email_queue DROP CONSTRAINT IF EXISTS onboarding_email_queue_status_check;

ALTER TABLE onboarding_email_queue ADD CONSTRAINT onboarding_email_queue_status_check 
CHECK (status IN ('pending', 'sent', 'failed', 'cancelled', 'awaiting_confirmation'));