

# P3-P4: Upgrade/Downgrade, Reconciliation, and Payment Audit Trail

## What's being built

Three remaining items from the Mollie subscription audit:

1. **Trainer upgrade/downgrade flow** -- Allow trainers to switch plans (e.g., Starter to Professional) without being blocked by the "already subscribed" check.
2. **Reconciliation cron job** -- A scheduled backend function that syncs subscription status from Mollie every 6 hours, protecting against missed webhooks.
3. **Subscription payments audit table** -- A new database table that logs every Mollie subscription payment for billing disputes and reconciliation.

---

## Technical Plan

### 1. Upgrade/Downgrade Flow

**Problem:** `create-mollie-subscription` returns `hasActiveSubscription: true` and blocks checkout when a trainer already has an active subscription. There's no way to change plans.

**Solution:** When the user has an active subscription and requests a different plan:
- Cancel the existing Mollie subscription (end-of-period)
- Create a new first payment for the new plan
- Return the checkout URL as normal

**Files changed:**
- `supabase/functions/create-mollie-subscription/index.ts` -- Replace the "block if active" logic (lines 102-114) with cancel-old + create-new logic. Add a `currentPlanId` detection from `subscription_tier` to prevent re-subscribing to the same plan.
- `src/pages/TrainerSubscription.tsx` -- Update the button label: show "Switch Plan" instead of "Upgrade" when user already has an active paid subscription on a different tier.

**Key behavior:**
- Same plan selected = show "Current Plan" (no action, already implemented)
- Different plan selected = cancel old subscription at Mollie, start new checkout
- Old subscription access continues until `subscription_ends_at`; new subscription kicks in after first payment succeeds

### 2. Reconciliation Cron Job

**Problem:** If a webhook fails or is missed, the database goes out of sync with Mollie. `check-mollie-subscription` partially compensates by calling Mollie live, but that's per-user and adds latency.

**Solution:** A new backend function `reconcile-subscriptions` that runs every 6 hours:
- Fetches all profiles (trainer, academy, club) with a `mollie_customer_id`
- For each, calls `GET /v2/customers/{id}/subscriptions`
- Compares Mollie status with DB status and reconciles:
  - If Mollie says `active` but DB says `inactive` or `canceled` -> update to `active`
  - If Mollie has no active subscriptions but DB says `active` and `subscription_ends_at` has passed -> update to `inactive`
  - Syncs `nextPaymentDate` into `subscription_ends_at`
- Processes in batches to avoid Mollie rate limits

**Files created:**
- `supabase/functions/reconcile-subscriptions/index.ts` -- The reconciliation logic
- `supabase/config.toml` -- Register the new function with `verify_jwt = false`

**Scheduling:** Use `pg_cron` + `pg_net` to invoke the function every 6 hours (via SQL insert, not migration, since it contains project-specific URLs/keys).

### 3. Subscription Payments Audit Table

**Problem:** No record of individual subscription payments. Can't resolve billing disputes or reconcile revenue.

**Solution:** A new `subscription_payments` table.

**Schema:**
- `id` (UUID, primary key, default gen_random_uuid())
- `profile_type` (text, not null) -- 'trainer', 'academy', or 'club'
- `profile_id` (UUID, not null) -- references the profile
- `mollie_payment_id` (text, not null, unique) -- prevents duplicate inserts
- `mollie_subscription_id` (text)
- `mollie_customer_id` (text)
- `amount` (numeric(10,2), not null)
- `currency` (text, default 'EUR')
- `status` (text, not null) -- 'paid', 'failed', 'expired', etc.
- `paid_at` (timestamptz)
- `created_at` (timestamptz, default now())

**RLS:** Enable RLS. Only service role (backend functions) writes. No public access needed -- admins query via edge functions or admin dashboard.

**Files changed:**
- Database migration -- Creates the table with RLS and a unique constraint on `mollie_payment_id`
- `supabase/functions/mollie-subscription-webhook/index.ts` -- After processing any payment (first or recurring, paid or failed), insert a row into `subscription_payments`

---

## Implementation Order

1. Database migration for `subscription_payments` table
2. Update `mollie-subscription-webhook` to insert payment records
3. Update `create-mollie-subscription` with upgrade/downgrade logic
4. Update `TrainerSubscription.tsx` button labels
5. Create `reconcile-subscriptions` edge function
6. Schedule the cron job
7. Deploy all edge functions

