-- Phase 1: Mollie Migration - Rename tables and add OAuth columns

-- 1. Rename trainer_stripe_accounts to trainer_mollie_accounts
ALTER TABLE trainer_stripe_accounts RENAME TO trainer_mollie_accounts;

-- 2. Rename stripe_account_id column to mollie_organization_id
ALTER TABLE trainer_mollie_accounts 
  RENAME COLUMN stripe_account_id TO mollie_organization_id;

-- 3. Add OAuth token storage columns for trainer accounts
ALTER TABLE trainer_mollie_accounts
  ADD COLUMN access_token TEXT,
  ADD COLUMN refresh_token TEXT,
  ADD COLUMN token_expires_at TIMESTAMPTZ;

-- 4. Rename club_stripe_accounts to club_mollie_accounts
ALTER TABLE club_stripe_accounts RENAME TO club_mollie_accounts;

-- 5. Rename stripe_account_id column to mollie_organization_id for clubs
ALTER TABLE club_mollie_accounts
  RENAME COLUMN stripe_account_id TO mollie_organization_id;

-- 6. Add OAuth token storage columns for club accounts
ALTER TABLE club_mollie_accounts
  ADD COLUMN access_token TEXT,
  ADD COLUMN refresh_token TEXT,
  ADD COLUMN token_expires_at TIMESTAMPTZ;

-- 7. Update bookings table - rename Stripe columns to Mollie
ALTER TABLE bookings
  RENAME COLUMN stripe_session_id TO mollie_payment_id;

ALTER TABLE bookings
  RENAME COLUMN stripe_payment_intent_id TO mollie_transaction_id;

-- 8. Update club_profiles - rename stripe_customer_id to mollie_customer_id
ALTER TABLE club_profiles
  RENAME COLUMN stripe_customer_id TO mollie_customer_id;