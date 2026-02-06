

# Fix Payment Routing - Trainer ID Mismatch

## Problem

The payment is going to your platform account (Reditus Software Holding B.V.) instead of the trainer because the edge function can't find the trainer's Mollie account. Here's why:

- The frontend sends `trainerId = dc4abd48-...` which is the **trainer profile ID** (from `trainer_profiles.id`)
- The edge function incorrectly assumes this is a **user ID** and queries `trainer_profiles` with `.eq("user_id", trainerId)`
- That lookup returns nothing, so the Mollie routing is skipped entirely
- The full payment goes to your platform account

The trainer's Mollie account IS properly connected (`org_19447741`, charges enabled, onboarding complete). It's just never found due to the wrong lookup.

## Fix

### `supabase/functions/create-mollie-payment/index.ts`

Change the trainer profile lookup (around line 57) from:

```typescript
const { data: trainerProfile } = await supabase
  .from("trainer_profiles")
  .select("id")
  .eq("user_id", trainerId)   // WRONG: trainerId is already a profile ID
  .single();
```

To:

```typescript
const { data: trainerProfile } = await supabase
  .from("trainer_profiles")
  .select("id")
  .eq("id", trainerId)        // CORRECT: match directly on profile ID
  .single();
```

This one-line change means:
- The trainer profile is found correctly
- The `trainer_mollie_accounts` lookup succeeds (since `trainer_id` matches the profile ID)
- Payment routing kicks in: the trainer receives the lesson amount minus the platform fee
- Your platform account collects only the platform fee (not the full amount)

No other files need to change.

