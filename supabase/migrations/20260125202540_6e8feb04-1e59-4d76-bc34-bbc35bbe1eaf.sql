-- Add sessions_per_week column to intake_requests
ALTER TABLE intake_requests 
ADD COLUMN sessions_per_week integer DEFAULT 1;

COMMENT ON COLUMN intake_requests.sessions_per_week IS 'How many training sessions per week the player wants (1-7)';