

# Plan: Maximize Stripe for Platform Payments

## Summary

Three changes to fully leverage Stripe's payment infrastructure for platform subscriptions while keeping Mollie for booking fees:

1. **Create Stripe customer on signup** — so every user has a Stripe Customer ID from day one
2. **Add "Manage Subscription" button** using Stripe Customer Portal — for self-service billing management  
3. **Use Stripe Coupons natively** — replace the custom `user_discounts` coupon-creation logic with Stripe Promotion Codes

---

## 1. Create Stripe Customer on Signup

**Where:** `supabase/functions/signup-user/index.ts`

After user creation (line ~139), create a Stripe customer using their email and name, then store the customer ID on the `profiles` table.

- Add `stripe_customer_id` column to the `profiles` table (migration)
- In `signup-user`, after `supabase.auth.admin.createUser()`:
  - Call `stripe.customers.create({ email, name: fullName, metadata: { user_id } })`
  - Save the returned customer ID to `profiles.stripe_customer_id`
- Update `create-stripe-checkout` to check `profiles.stripe_customer_id` first before creating a new customer, and copy it to the entity-specific profile (`trainer_profiles`, etc.) if not already set

**Database migration:**
```sql
ALTER TABLE public.profiles ADD COLUMN stripe_customer_id TEXT;
```

## 2. Leverage Stripe Customer Portal

**Where:** `TrainerSubscription.tsx`, `clubSubscription.ts`, `academySubscription.ts`

The `customer-portal` edge function already exists and works. The frontend just never calls it.

- **TrainerSubscription.tsx**: Replace the "Cancel Subscription" button with a "Manage Subscription" button that opens the Stripe Customer Portal (where users can cancel, change payment method, view invoices, etc.)
- **Club/Academy subscription pages**: Add the same "Manage Subscription" button pattern
- The portal handles cancellation, plan changes, payment method updates, and invoice history — no need for the separate `cancel-stripe-subscription` function from the frontend

## 3. Use Stripe Coupon Codes Natively

**Where:** `supabase/functions/create-stripe-checkout/index.ts`

The current flow already creates a Stripe coupon from `user_discounts` data (lines 131-148). This works, but creates a new Stripe coupon object every checkout attempt.

- Instead, when an admin creates a discount in `AdminUsers.tsx`, also create a persistent Stripe Coupon and store the coupon ID in `user_discounts.stripe_coupon_id`
- In `create-stripe-checkout`, reference the existing coupon ID instead of creating a new one each time
- Optionally support Stripe Promotion Codes so users can enter coupon codes at checkout

**Database migration:**
```sql
ALTER TABLE public.user_discounts ADD COLUMN stripe_coupon_id TEXT;
```

---

## Technical Details

### Edge function changes
| Function | Change |
|---|---|
| `signup-user` | Add Stripe customer creation after user creation |
| `create-stripe-checkout` | Use `profiles.stripe_customer_id` as fallback; use stored coupon ID |
| `customer-portal` | No changes needed — already complete |
| `cancel-stripe-subscription` | Keep for API use but remove from main UI (portal handles it) |

### Frontend changes
| File | Change |
|---|---|
| `TrainerSubscription.tsx` | Replace "Cancel" with "Manage Subscription" → calls `customer-portal` |
| Club/Academy subscription pages | Add "Manage Subscription" button |
| `AdminUsers.tsx` | When creating discount, also create Stripe coupon and store ID |

### Mollie stays unchanged
All Mollie Connect logic for player booking payments (application fees) remains untouched.

