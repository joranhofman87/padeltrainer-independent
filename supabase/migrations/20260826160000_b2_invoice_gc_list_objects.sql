-- Theme B / B2: keyset-paginated reader over the 'invoices' bucket's objects for the storage GC.
--
-- The GC edge function must walk storage.objects, but the storage schema is not exposed through
-- PostgREST (only the Storage API service touches it), so a supabase-js `.schema('storage')` read
-- would 406. This SECURITY DEFINER function (owned by the migration role, which owns the storage
-- tables' grants) is the deterministic seam: service-role-only EXECUTE, read-only, bucket-pinned
-- to 'invoices', keyset on name.
CREATE OR REPLACE FUNCTION public.invoice_gc_list_objects(_after text DEFAULT NULL, _limit int DEFAULT 1000)
RETURNS TABLE (name text, updated_at timestamptz, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = storage, public
AS $$
  SELECT o.name, o.updated_at, o.created_at
  FROM storage.objects o
  WHERE o.bucket_id = 'invoices'
    AND (_after IS NULL OR o.name > _after)
  ORDER BY o.name
  LIMIT LEAST(GREATEST(COALESCE(_limit, 1000), 1), 1000);
$$;

-- Service-role only: the GC is a lifecycle job, never a user-facing capability. (Bucket names are
-- not secret, but object listings enumerate tenants' invoice numbers.)
REVOKE ALL ON FUNCTION public.invoice_gc_list_objects(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_gc_list_objects(text, int) TO service_role;
