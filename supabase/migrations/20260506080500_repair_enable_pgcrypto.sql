-- Repair: pgcrypto required for gen_random_bytes() in 20260506080606
-- Idempotent. No data changes. Matches Supabase extensions schema convention.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
