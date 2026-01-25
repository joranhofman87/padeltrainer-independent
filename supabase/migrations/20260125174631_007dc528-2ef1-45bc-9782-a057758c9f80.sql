-- Add skip_reason column to track why proposals weren't generated
ALTER TABLE public.intake_requests 
ADD COLUMN skip_reason TEXT NULL;