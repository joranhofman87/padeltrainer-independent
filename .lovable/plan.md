

# Referral Discount System

## Overview

A universal discount system that admins can attach to any user (trainer, club, or academy). When a discounted user checks out via Mollie, the payment amount is reduced by the configured percentage. The discount has a limited duration in months, and the countdown starts from the first successful payment.

---

## Database Changes

### New table: `user_discounts`

| Column | Type | Description |
|---|---|---|
| `id` | UUID (PK) | Auto-generated |
| `user_id` | UUID (not null, unique) | References the user receiving the discount |
| `discount_percent` | INTEGER (not null) | Percentage off (1-100) |
| `duration_months` | INTEGER (not null) | Total months the discount lasts |
| `months_remaining` | INTEGER (not null) | Months left (decremented on each payment) |
| `source` | TEXT (default 'referral') | Origin of the discount (e.g., 'referral', 'promo') |
| `is_active` | BOOLEAN (default true) | Whether the discount is currently active |
| `first_payment_at` | TIMESTAMPTZ (nullable) | Set on first discounted payment to mark period start |
| `created_at` | TIMESTAMPTZ (default now()) | When the discount was created |
| `created_by` | UUID (nullable) | Admin who created it |

RLS: Enabled. Admins can CRUD. Users can read their own discount. Service role writes from edge functions.

---

## Edge Function Changes

### 1. `create-mollie-subscription` (Trainer)

Before creating the Mollie payment, look up the user's active discount from `user_discounts`:

- If an active discount with `months_remaining > 0` exists, calculate the discounted amount: `plan.amount * (1 - discount_percent / 100)`
- Format to 2 decimal places for Mollie
- Pass the original and discounted amounts in the payment metadata so the webhook can track it
- The recurring subscription created by the webhook will also need to use the discounted amount (passed via metadata)

### 2. `create-academy-mollie-subscription` (Academy)

Same logic: look up discount by manager's `user_id`, apply percentage to the `199.00` amount.

### 3. `create-club-mollie-subscription` (Club)

Same logic: look up discount by manager's `user_id`, apply percentage to the plan amount.

### 4. `mollie-subscription-webhook`

When processing a successful payment (first or recurring):

- Check `user_discounts` for the profile's user
- If active with `months_remaining > 0`:
  - Decrement `months_remaining` by 1
  - If `first_payment_at` is null, set it to now
  - If `months_remaining` reaches 0, set `is_active = false`
- When creating the Mollie recurring subscription (from first payment), use the discounted amount if the discount still has months remaining
- For recurring payments: the subscription amount at Mollie is already set, so the discount is baked in at subscription creation time. When the discount expires (`months_remaining` hits 0), the webhook will need to update the Mollie subscription amount back to full price via the Mollie API (`PATCH /v2/customers/{id}/subscriptions/{subId}`)

---

## Admin UI Changes

### AdminUsers page

Add a "Discount" column to the users table showing:
- The discount badge (e.g., "20% / 3mo left") if active
- Empty if no discount

Add a dropdown menu item "Manage Discount" that opens a dialog with:
- Discount percentage (number input, 1-100)
- Duration in months (number input)
- A "Remove Discount" button if one exists
- Save creates/updates the `user_discounts` row

---

## How the Month Countdown Works

1. Admin sets discount: `discount_percent = 20`, `duration_months = 6`, `months_remaining = 6`
2. User subscribes -- first payment is charged at 20% off. Webhook sets `first_payment_at = now()` and decrements `months_remaining` to 5
3. Each recurring payment: webhook decrements `months_remaining`
4. When `months_remaining` hits 0: webhook sets `is_active = false` and calls Mollie API to update the subscription amount back to full price

---

## Technical Details

### Discount application in payment creation

```text
Original amount: 39.00
Discount: 20%
Discounted amount: 31.20
Mollie payment body: { amount: { currency: "EUR", value: "31.20" } }
```

### Mollie subscription amount update (on expiry)

The webhook will `PATCH` the subscription to restore full pricing:

```text
PATCH /v2/customers/{customerId}/subscriptions/{subscriptionId}
Body: { amount: { currency: "EUR", value: "39.00" } }
```

### Files to create
- Database migration for `user_discounts` table

### Files to modify
- `supabase/functions/create-mollie-subscription/index.ts` -- discount lookup and amount adjustment
- `supabase/functions/create-academy-mollie-subscription/index.ts` -- discount lookup and amount adjustment
- `supabase/functions/create-club-mollie-subscription/index.ts` -- discount lookup and amount adjustment
- `supabase/functions/mollie-subscription-webhook/index.ts` -- decrement months, restore full price on expiry
- `src/pages/admin/AdminUsers.tsx` -- discount column and manage dialog
- `src/hooks/useAdminData.ts` -- fetch discount data with users

