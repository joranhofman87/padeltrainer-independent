-- Create rate limits table for tracking public form submissions
CREATE TABLE public.rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  endpoint text NOT NULL,
  request_count integer DEFAULT 1,
  window_start timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  UNIQUE(identifier, endpoint)
);

-- Index for fast lookups
CREATE INDEX idx_rate_limits_lookup ON rate_limits(identifier, endpoint, window_start);

-- Enable RLS - only service role can access (no policies = service role only)
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- Add action column to admin_impersonation_logs for different admin action types
ALTER TABLE admin_impersonation_logs 
ADD COLUMN IF NOT EXISTS action text DEFAULT 'impersonate';

-- Add details column for action-specific data
ALTER TABLE admin_impersonation_logs 
ADD COLUMN IF NOT EXISTS details jsonb;

-- Update table comment
COMMENT ON TABLE admin_impersonation_logs IS 
  'Audit log for admin actions: impersonation, user updates, password resets, deletions';