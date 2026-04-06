

# Clean Up Legacy Mollie Subscription Code

## Summary

Platform subscriptions (trainer, academy, club) are fully on Stripe. The frontend already calls Stripe edge functions (`check-stripe-subscription`, `create-stripe-checkout`, `cancel-stripe-subscription`, `customer-portal`). Six Mollie subscription edge functions remain deployed but are never called — they are dead code that should be removed.

## What gets deleted

| Edge function | Why it's dead |
|---|---|
| `create-mollie-subscription/` | Trainer subscription creation — replaced by `create-stripe-checkout` |
| `create-club-mollie-subscription/` | Club subscription creation — replaced by `create-stripe-checkout` |
| `create-academy-mollie-subscription/` | Academy subscription creation — replaced by `create-stripe-checkout` |
| `cancel-mollie-subscription/` | Subscription cancellation — replaced by `cancel-stripe-subscription` |
| `check-mollie-subscription/` | Subscription status check — replaced by `check-stripe-subscription` |
| `mollie-subscription-webhook/` | Webhook for Mollie subscription payments — no longer receives events since subscriptions moved to Stripe |
| `reconcile-subscriptions/` | Cron job that syncs Mollie subscription status to DB — obsolete |

## What stays (Mollie is still used for these)

- `mollie-webhook/` — player-to-trainer payment webhooks
- `mollie-connect-trainer/` and `mollie-connect-academy/` — Mollie Connect onboarding
- `check-mollie-connect-status/` — Mollie account verification
- `create-mollie-payment/` — booking/invoice payments from players
- `mollie-callback/` — OAuth callback for Mollie Connect
- `verify-mollie-payment/` — payment verification

## What stays in the database

The `mollie_customer_id` columns on profile tables stay — they're used by Mollie Connect for payment collection, not subscriptions.

## Steps

1. Delete the 7 edge function directories listed above
2. Remove the `stripe-subscription-webhook/` function only if it duplicates what `check-stripe-subscription` already does on-demand (need to verify — if it handles Stripe webhook events, it stays)

## Technical note

No frontend changes needed. The `src/lib/` subscription files and `useAuth.tsx` already reference only Stripe functions. No database migration needed — the `subscription_status`, `subscription_tier`, etc. columns are still used by the Stripe flow.

## File summary

| File | Change |
|---|---|
| `supabase/functions/create-mollie-subscription/` | Delete |
| `supabase/functions/create-club-mollie-subscription/` | Delete |
| `supabase/functions/create-academy-mollie-subscription/` | Delete |
| `supabase/functions/cancel-mollie-subscription/` | Delete |
| `supabase/functions/check-mollie-subscription/` | Delete |
| `supabase/functions/mollie-subscription-webhook/` | Delete |
| `supabase/functions/reconcile-subscriptions/` | Delete |

