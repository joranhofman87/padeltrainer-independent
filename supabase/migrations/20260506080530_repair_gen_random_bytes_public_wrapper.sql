-- Repair: unqualified gen_random_bytes() in 20260506080606 cannot resolve when
-- pgcrypto lives in schema extensions. Idempotent. No data changes.

CREATE OR REPLACE FUNCTION public.gen_random_bytes(len integer)
RETURNS bytea
LANGUAGE sql
VOLATILE
PARALLEL SAFE
SET search_path = extensions
AS $$
  SELECT extensions.gen_random_bytes(len);
$$;

COMMENT ON FUNCTION public.gen_random_bytes(integer) IS
  'Shim for pgcrypto in extensions schema; used by slot_priority_claims.claim_token default.';
