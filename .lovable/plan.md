

# Migrate Platform Subscriptions from Mollie to Stripe

## Current State

The platform charges trainers, clubs, and academies for subscriptions using **Mollie** as the payment provider. This involves:

### Edge Functions (Mollie-based, to be replaced)
| Function | Purpose |
|----------|---------|
| `create-mollie-subscription` | Trainer checkout (first payment → mandate → recurring) |
| `create-club-mollie-subscription` | Club checkout |
| `create-academy-mollie-subscription` | Academy checkout |
| `check-mollie-subscription` | Checks subscription status for all 3 entity types |
| `cancel-mollie-subscription` | Cancels subscription for all 3 entity types |
| `mollie-subscription-webhook` | Processes first + recurring payments, activates profiles |
| `reconcile-subscriptions` | Cron job syncing DB with Mollie API every 6h |

### Frontend (calls Mollie functions)
| File | Usage |
|------|-------|
| `src/hooks/useAuth.tsx` | Calls `check-mollie-subscription` on login/refresh |
| `src/pages/TrainerSubscription.tsx` | Calls `create-mollie-subscription` and `cancel-mollie-subscription` |
| `src/pages/club/ClubSubscription.tsx` | Calls club checkout/cancel/check via `src/lib/clubSubscription.ts` |
| `src/lib/academySubscription.ts` | Calls academy checkout/cancel/check |
| `src/lib/clubSubscription.ts` | Calls club checkout/cancel/check |

### Database columns (on `trainer_profiles`, `club_profiles`, `academy_profiles`)
- `mollie_customer_id`, `subscription_id`, `subscription_status`, `subscription_tier`, `subscription_ends_at`, `trial_ends_at`, `last_processed_payment_id`

### Key detail: Mollie stays for player payments
Mollie Connect is still used for **player-facing payments** (lesson bookings routed to trainer/academy Mollie accounts). Only the **platform subscription billing** moves to Stripe.

---

## Migration Plan

### Phase 1: Create Stripe Edge Functions

1. **`create-stripe-checkout`** — Replaces `create-mollie-subscription`, `create-club-mollie-subscription`, `create-academy-mollie-subscription`
   - Single function handling all 3 entity types via `type` param
   - Uses Stripe Checkout with `mode: "subscription"`
   - Looks up or creates Stripe customer by user email
   - Uses price IDs from the `subscription_plans` table (`mollie_plan_id_monthly`/`yearly` columns — rename or add `stripe_price_id_monthly`/`yearly`)
   - Handles plan switching (checks existing active subscription)
   - Applies `user_discounts` as Stripe coupons

2. **`check-stripe-subscription`** — Replaces `check-mollie-subscription`
   - Queries Stripe for active subscriptions by customer email
   - Same response shape: `{ subscribed, status, tier, endsAt, trialEndsAt, isPublic }`
   - Preserves manual override logic (admin sets `subscription_status = 'active'` without a Stripe customer)
   - Preserves trial logic

3. **`cancel-stripe-subscription`** — Replaces `cancel-mollie-subscription`
   - Cancels at period end via Stripe API
   - Updates DB status to `canceled`

4. **`stripe-subscription-webhook`** — Replaces `mollie-subscription-webhook`
   - Handles `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`
   - Activates/extends/deactivates profiles
   - Sends Slack notifications on new subscriptions and failures

5. **`customer-portal`** (new) — Stripe Customer Portal for self-service subscription management

### Phase 2: Database Changes

1. Add columns to `subscription_plans` table:
   - `stripe_price_id_monthly` and `stripe_price_id_yearly`
   
2. Add `stripe_customer_id` to `trainer_profiles`, `club_profiles`, `academy_profiles`
   - Keep `mollie_customer_id` for backward compat during migration

3. Update `reconcile-subscriptions` to query Stripe instead of Mollie (or remove it — Stripe webhooks are more reliable)

### Phase 3: Create Stripe Products & Prices

Using the Stripe tools, create products and prices matching the existing `subscription_plans` rows:
- Trainer Starter (€9/mo, €75.60/yr)
- Trainer Professional (€29/mo, €243.60/yr)  
- Academy Plan (€199/mo, €2388/yr)
- Club Plan (€199/mo, €2388/yr)

Store the resulting `price_xxx` IDs in the `subscription_plans` table.

### Phase 4: Update Frontend

1. **`src/hooks/useAuth.tsx`** — Change `check-mollie-subscription` → `check-stripe-subscription`
2. **`src/pages/TrainerSubscription.tsx`** — Change `create-mollie-subscription` → `create-stripe-checkout`, `cancel-mollie-subscription` → `cancel-stripe-subscription`
3. **`src/lib/clubSubscription.ts`** — Point to new Stripe functions
4. **`src/lib/academySubscription.ts`** — Point to new Stripe functions
5. **`src/pages/club/ClubSubscription.tsx`** — Uses updated lib functions (no direct changes needed)
6. Add "Manage Subscription" button linking to Stripe Customer Portal

### Phase 5: Cleanup

- Mark old Mollie subscription functions as deprecated (keep for existing subscribers during transition)
- Update `reconcile-subscriptions` or retire it
- Remove Mollie plan ID columns from `subscription_plans` once fully migrated

---

## What stays unchanged

- **Mollie Connect** for player payments (lesson bookings) — completely separate concern
- **Trial logic** — same 7-day trainer / 14-day club+academy trials
- **Admin overrides** — same `subscription_status = 'active'` without payment provider
- **`subscription_plans` table** — extends with Stripe IDs, keeps existing structure
- **`user_discounts`** — converted to Stripe coupons/promotion codes

---

## Implementation Order

1. Create Stripe products/prices via Stripe tools
2. DB migration: add `stripe_customer_id` + `stripe_price_id` columns
3. Build the 5 new edge functions
4. Update frontend to call new functions
5. Test end-to-end
6. Deprecate old Mollie subscription functions

