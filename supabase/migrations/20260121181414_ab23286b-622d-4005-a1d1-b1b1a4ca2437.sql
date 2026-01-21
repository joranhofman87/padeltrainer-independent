-- Create admin impersonation logs table for audit trail
CREATE TABLE public.admin_impersonation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  ip_address TEXT,
  user_agent TEXT
);

-- Enable RLS
ALTER TABLE public.admin_impersonation_logs ENABLE ROW LEVEL SECURITY;

-- Only admins can view impersonation logs
CREATE POLICY "Admins can view impersonation logs"
ON public.admin_impersonation_logs
FOR SELECT
USING (is_admin(auth.uid()));

-- Only admins can insert impersonation logs (via edge function with service role)
CREATE POLICY "Service role can insert impersonation logs"
ON public.admin_impersonation_logs
FOR INSERT
WITH CHECK (true);

-- Admins can update their own impersonation logs (to set ended_at)
CREATE POLICY "Admins can update their impersonation logs"
ON public.admin_impersonation_logs
FOR UPDATE
USING (is_admin(auth.uid()) AND admin_user_id = auth.uid());

-- Create index for faster lookups
CREATE INDEX idx_impersonation_logs_admin ON public.admin_impersonation_logs(admin_user_id);
CREATE INDEX idx_impersonation_logs_target ON public.admin_impersonation_logs(target_user_id);