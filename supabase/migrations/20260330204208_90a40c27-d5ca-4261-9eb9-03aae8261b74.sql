-- Create private backups storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('backups', 'backups', false)
ON CONFLICT (id) DO NOTHING;

-- RLS: only admins can read from backups bucket
CREATE POLICY "Admins can read backups"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'backups'
  AND public.is_admin(auth.uid())
);

-- RLS: service role inserts (edge function) — allow authenticated admin inserts too
CREATE POLICY "Admins can insert backups"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'backups'
  AND public.is_admin(auth.uid())
);

-- RLS: only admins can delete backups
CREATE POLICY "Admins can delete backups"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'backups'
  AND public.is_admin(auth.uid())
);

-- Enable pg_net extension for cron HTTP calls
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;