-- Repair: academy Stripe → Mollie rename omitted from 20260203100646
-- Idempotent schema-only fix. No data changes.
-- Skips entirely when public.academy_mollie_accounts already exists.

-- 1. Rename table when still on Stripe name
DO $$
BEGIN
  IF to_regclass('public.academy_stripe_accounts') IS NOT NULL
     AND to_regclass('public.academy_mollie_accounts') IS NULL
  THEN
    ALTER TABLE public.academy_stripe_accounts RENAME TO academy_mollie_accounts;
  END IF;
END $$;

-- 2. Rename account id column (handles rename-only or already-renamed table)
DO $$
BEGIN
  IF to_regclass('public.academy_mollie_accounts') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'academy_mollie_accounts'
         AND column_name = 'stripe_account_id'
     )
  THEN
    ALTER TABLE public.academy_mollie_accounts
      RENAME COLUMN stripe_account_id TO mollie_organization_id;
  END IF;
END $$;

-- 3. OAuth columns (mirror trainer/club in 20260203100646)
DO $$
BEGIN
  IF to_regclass('public.academy_mollie_accounts') IS NOT NULL THEN
    ALTER TABLE public.academy_mollie_accounts
      ADD COLUMN IF NOT EXISTS access_token TEXT,
      ADD COLUMN IF NOT EXISTS refresh_token TEXT,
      ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;
  END IF;
END $$;
