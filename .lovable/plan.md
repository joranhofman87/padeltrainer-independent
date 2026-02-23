

# Mollie Subscription Implementation Audit

## 1. Architecture Summary: What Exists

**Edge Functions (backend):**
- `create-mollie-subscription` -- Trainer checkout: creates/reuses Mollie customer, creates first payment with `sequenceType="first"`, sets `webhookUrl` to `mollie-subscription-webhook`, stores `pending` status. Metadata includes `trainer_profile_id`, `plan_id`, `type`.
- `create-academy-mollie-subscription` -- Academy checkout: same pattern as trainer. Metadata type = `academy_subscription_first_payment`.
- `mollie-subscription-webhook` -- Handles first-payment webhooks (creates Mollie subscription after mandate established) AND recurring payment webhooks (extends `subscription_ends_at`). Handles trainer + club types.
- `mollie-webhook` -- Handles **booking/lesson** payment webhooks (not subscriptions). Updates booking status.
- `check-mollie-subscription` -- Client-facing: checks trial, admin override, fetches Mollie subscriptions, reconciles DB state. Supports trainer/academy/club.
- `cancel-mollie-subscription` -- Cancels via `DELETE /v2/customers/{id}/subscriptions/{subId}`. Sets DB to `canceled`. Access continues until `subscription_ends_at`.

**Data model (columns on `trainer_profiles`, `academy_profiles`, `club_profiles`):**
- `mollie_customer_id`, `subscription_id`, `subscription_status`, `subscription_tier`, `subscription_ends_at`, `trial_ends_at`

**Client libraries:**
- `src/lib/subscription.ts` -- Tier config + types for trainers
- `src/lib/academySubscription.ts` -- Academy checkout/cancel/check wrappers
- `src/lib/clubSubscription.ts` -- Club checkout/cancel/check wrappers (invokes `create-club-mollie-subscription`)

**Access control:**
- `SubscriptionOverlay` component blocks UI when subscription expired
- `check-mollie-subscription` is the source of truth, called from layouts

---

## 2. Gaps (Missing Pieces)

### GAP-1: `create-club-mollie-subscription` edge function DOES NOT EXIST
- `src/lib/clubSubscription.ts` line 54 invokes `create-club-mollie-subscription`, but **no such file exists** in `supabase/functions/`.
- Club subscription checkout is completely broken.

### GAP-2: Academy first-payment webhook handler is MISSING
- `create-academy-mollie-subscription` sets metadata `type: "academy_subscription_first_payment"`.
- `mollie-subscription-webhook` only handles `type === "subscription_first_payment"` (trainer) and `type === "club_subscription_first_payment"` (club).
- **Academy first payments are silently dropped** -- no subscription is ever created after the first payment succeeds.

### GAP-3: No `subscription_payments` / payment history table
- Individual payment IDs (`mollie_payment_id`) for subscription payments are never stored.
- No audit trail of charges, amounts, or dates for billing disputes or reconciliation.

### GAP-4: No `current_period_start`, `current_period_end`, or `next_charge_at` columns
- Only `subscription_ends_at` is tracked, which is manually calculated (not from Mollie's actual data).
- If the webhook-calculated date drifts from Mollie's actual charge date, access windows will be incorrect.

### GAP-5: No reconciliation / cron job
- If a webhook fails or is missed, there is no background job to re-sync subscription status from Mollie.
- `check-mollie-subscription` does a live Mollie API call per user request, which partially compensates but is not a true reconciliation.

### GAP-6: No dunning / grace period for failed recurring payments
- `mollie-subscription-webhook` only processes `status === "paid"`. Failed payments are silently ignored (webhook returns 200 with no DB update).
- When a recurring payment fails, the user's `subscription_ends_at` simply expires and access is revoked with no notification or retry logic.

### GAP-7: No idempotency protection on webhook
- `mollie-subscription-webhook` has no check for "was this payment already processed?"
- If Mollie replays a webhook, `subscription_ends_at` gets recalculated and extended again (double-extension).

### GAP-8: Plan prices hardcoded in two places
- `create-mollie-subscription` lines 14-19 and `mollie-subscription-webhook` lines 14-19 both define `TRAINER_PLANS` with different structures.
- Price changes require updating two files. Risk of mismatch.

### GAP-9: No upgrade/downgrade flow
- If a trainer on `starter` wants to upgrade to `professional`, there is no mechanism to cancel the old subscription and create a new one (or update it).
- `create-mollie-subscription` returns `hasActiveSubscription: true` and blocks the flow.

---

## 3. Risks

### RISK-1: CRITICAL -- Academy subscriptions never activate
- Academy owners pay the first payment but the subscription webhook doesn't match `academy_subscription_first_payment`, so no Mollie subscription is created and the profile stays in `pending` forever. Money collected, no service granted, no subscription created.

### RISK-2: CRITICAL -- Club checkout 100% broken
- `create-club-mollie-subscription` function doesn't exist. Any club trying to subscribe gets a runtime error.

### RISK-3: HIGH -- Double-extension on webhook replay
- Mollie may retry webhooks. Each replay recalculates and extends `subscription_ends_at` by another month/year.

### RISK-4: HIGH -- Subscription end date drift
- End dates are calculated with `new Date()` in the webhook handler, not from Mollie's `nextPaymentDate`. Over time, the DB date and Mollie's billing cycle will diverge.

### RISK-5: MEDIUM -- No failed payment handling
- A declined card on a recurring charge silently expires the user. No email, no grace period, no admin alert.

### RISK-6: MEDIUM -- Webhook returns 200 on errors
- `mollie-subscription-webhook` catches all errors and returns `200`. This means Mollie won't retry on genuine transient failures (DB down, network glitch). Errors are silently swallowed.

### RISK-7: LOW -- `check-mollie-subscription` makes live Mollie API calls on every page load
- This creates latency and Mollie rate-limit risk. Should use DB as primary and reconcile periodically.

---

## 4. Fix Plan (Prioritized)

### P0 -- Fix academy webhook handler (RISK-1)
**File:** `supabase/functions/mollie-subscription-webhook/index.ts`
Add a handler block for `metadata.type === "academy_subscription_first_payment"` after the trainer block (line 151). Pattern: identical to club handler but targeting `academy_profiles`, using `"academy"` tier and the academy plan amount (`199.00` / `1 month`).

### P0 -- Create `create-club-mollie-subscription` edge function (RISK-2)
**File:** `supabase/functions/create-club-mollie-subscription/index.ts` (new file)
Clone the pattern from `create-academy-mollie-subscription`, adjusting:
- Table: `club_profiles` with `club_managers` join for auth
- Metadata type: `club_subscription_first_payment`
- Amount: `199.00` monthly or `2388.00` yearly
- Redirect: `/club/subscription?success=true`

### P1 -- Add idempotency to webhook (RISK-3)
**File:** `supabase/functions/mollie-subscription-webhook/index.ts`
Before processing, query the DB: if `subscription_id` is already set and matches the created subscription, skip. For recurring payments, store last processed `payment_id` in a new column `last_processed_payment_id` on the profile table, and skip if it matches.

### P1 -- Use Mollie's `nextPaymentDate` instead of manual calculation (RISK-4)
**File:** `supabase/functions/mollie-subscription-webhook/index.ts`
After creating the subscription (line 110), use `subscription.nextPaymentDate` for `subscription_ends_at` instead of manually adding months.

### P2 -- Handle failed recurring payments (RISK-5)
**File:** `supabase/functions/mollie-subscription-webhook/index.ts`
Add handling for `payment.status === "failed"` or `"expired"`: update `subscription_status` to `"past_due"`, send a Slack alert, and optionally email the user.

### P2 -- Return 500 on transient errors (RISK-6)
**File:** `supabase/functions/mollie-subscription-webhook/index.ts`
Only return 200 for successfully processed webhooks or known-ignorable cases (e.g., missing payment ID). Return 500 for DB errors and Mollie API failures so Mollie retries.

### P3 -- Add upgrade/downgrade support (GAP-9)
**File:** `supabase/functions/create-mollie-subscription/index.ts`
When `hasActiveSubscription` is true, instead of blocking, cancel the old subscription and create a new first payment for the new plan. Prorate if needed, or handle at end of current period.

### P3 -- Add reconciliation cron job (GAP-5)
Create a new edge function `reconcile-subscriptions` that iterates all profiles with `mollie_customer_id`, fetches their Mollie subscription status, and syncs the DB. Schedule via `pg_cron` every 6 hours.

### P4 -- Create `subscription_payments` table (GAP-3)
New migration adding a `subscription_payments` table with columns: `id`, `profile_type`, `profile_id`, `mollie_payment_id`, `mollie_subscription_id`, `amount`, `currency`, `status`, `paid_at`, `created_at`. Insert a row on every webhook.

---

## 5. Test Plan (Mollie Test Mode)

### Test 1: Trainer first payment + subscription creation
1. Call `create-mollie-subscription` with `planId: "starter"`.
2. Complete checkout with Mollie test card.
3. Verify `mollie-subscription-webhook` is called.
4. Verify `trainer_profiles.subscription_status = "active"`, `subscription_id` is set.
5. Verify a Mollie subscription exists via `GET /v2/customers/{id}/subscriptions`.

### Test 2: Academy first payment (currently broken)
1. Call `create-academy-mollie-subscription`.
2. Complete checkout.
3. **Before fix:** Verify webhook logs show payment received but no subscription created (confirms bug).
4. **After fix:** Verify `academy_profiles.subscription_status = "active"`.

### Test 3: Club checkout (currently broken)
1. Call `create-club-mollie-subscription`.
2. **Before fix:** Confirm 500 error / function not found.
3. **After fix:** Complete checkout, verify subscription created.

### Test 4: Webhook idempotency
1. Complete a trainer subscription checkout.
2. Record the `subscription_ends_at` value.
3. Replay the same webhook payload (POST to `mollie-subscription-webhook` with same payment ID).
4. Verify `subscription_ends_at` has NOT changed.

### Test 5: Cancellation
1. Cancel a trainer subscription via `cancel-mollie-subscription`.
2. Verify `subscription_status = "canceled"` in DB.
3. Verify `check-mollie-subscription` still returns `subscribed: true` until `subscription_ends_at`.
4. After `subscription_ends_at` passes, verify `subscribed: false`.

### Test 6: Failed recurring payment (after fix)
1. In Mollie test mode, trigger a failed recurring payment.
2. Verify `subscription_status` updates to `past_due`.
3. Verify Slack notification fires.

### Test 7: Access control
1. Set `subscription_status = "inactive"` and `trial_ends_at` in the past.
2. Load the trainer dashboard.
3. Verify `SubscriptionOverlay` blocks access.
4. Navigate to `/trainer/subscription` -- verify it is still accessible.

